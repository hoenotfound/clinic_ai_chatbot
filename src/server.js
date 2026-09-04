require("dotenv").config();
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const metaMessaging = require("./services/metaMessagingService");
const channelMessaging = require("./services/channelMessagingService");
const ai = require("./services/aiService");
const { transcribeAudio } = require("./services/transcriptionService");
const { convertToMp3 } = require("./services/audioConvertService");
const { getAiOwnedContact } = require("./services/automaticReplyGuard");
const {
  getPendingAiHandoffContact,
  pauseAiForHumanHandoff,
} = require("./services/aiHandoffService");
const { claimIncomingMessage } = require("./services/inboundMessageClaimService");
const {
  claimLiveItem,
  processClaimedBatch,
  startInboundProcessingRecovery,
} = require("./services/inboundProcessingService");
const { markBookingReadyForContact } = require("./services/bookingReadyOutcomeService");
const conversationStore = require("./utils/conversationStore");
const { getActivePromotion } = require("./utils/activePromotion");
const { parseAiReplyResult } = require("./utils/aiReplyResult");
const {
  fallbackHandoffReply,
  isUrgentSafetyMessage,
} = require("./utils/handoffReply");
const clinicConfig = require("./config/clinicConfig");
const messagesRepo = require("./db/messagesRepo");
const contactsRepo = require("./db/contactsRepo");
const pipelineRepo = require("./db/pipelineRepo");
const { checkKeywordTriggers } = require("./utils/attentionTriggers");
const realtimeEvents = require("./utils/realtimeEvents");
const {
  enqueueConversation,
  enqueueConversationBurst,
} = require("./utils/conversationQueue");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { verifyMetaWebhookSignature } = require("./middleware/verifyMetaWebhookSignature");
const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const configRoutes = require("./routes/config");
const contactsRoutes = require("./routes/contacts");
const pipelineRoutes = require("./routes/pipeline");
const setupStatusRoutes = require("./routes/setupStatus");
const { bootstrapAdminUser } = require("./db/bootstrapAdmin");
const configRepo = require("./db/configRepo");
const { pruneOrphanedPromoImages } = configRepo;
const promoImagesRepo = require("./db/promoImagesRepo");
const { initSchema } = require("./db/db");
const setupStatusRepo = require("./db/setupStatusRepo");
const { startAutomatedFollowUps } = require("./services/followUpService");
const { startLeadScoring } = require("./services/leadScoringService");
const { startStaffWaitingAlerts } = require("./services/staffWaitingAlertService");
const {
  reviewLeadTemperatureForMessage,
} = require("./services/leadTemperatureAutomation");

// How often the backstop sweep for abandoned promo-image uploads runs —
// see the setInterval call in start() below.
const PROMO_IMAGE_PRUNE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const WHATSAPP_SEND_REJECTED_ERROR =
  "WhatsApp did not accept this message. Check the reply window or connection and try again.";

function publishDeliveryStatus(message) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason: "delivery_status",
  });
}

async function persistSendOutcome(
  savedMessage,
  sendResult,
  errorText = WHATSAPP_SEND_REJECTED_ERROR
) {
  let updated = null;
  if (sendResult.wamid) {
    updated = await messagesRepo.setWhatsappMessageId(savedMessage.id, sendResult.wamid);
  } else if (!sendResult.success) {
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, "failed", errorText);
  }
  publishDeliveryStatus(updated);
  return updated || savedMessage;
}

async function sendTrackedText(contact, text) {
  const saved = await conversationStore.appendMessageForContact(
    contact.id,
    "assistant",
    text
  );
  const sendResult = await channelMessaging.sendText(contact, text);
  const errorText = sendResult.error || channelMessaging.rejectedError(contact.channel);
  const finalMessage = await persistSendOutcome(saved, sendResult, errorText);

  if (!sendResult.success) {
    await contactsRepo.setDeliveryAttention(
      contact.id,
      `Delivery failed: ${errorText}`
    );
  }

  return { finalMessage, sendResult };
}

function unwrapIncoming(item) {
  return item?.incoming || item;
}

function dedupeIncomingBatch(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const incoming = unwrapIncoming(item);
    const channel = incoming?.channel || "whatsapp";
    const id = incoming?.id;
    const key = id ? `${channel}:${id}` : `${channel}:${incoming?.from}:${result.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function processIncomingBatch(items) {
  const batch = dedupeIncomingBatch(items);
  if (!batch.length) return;

  let firstMessageWasSuppressed = false;
  let inheritedKeywordReason = null;

  for (let index = 0; index < batch.length; index += 1) {
    const isLast = index === batch.length - 1;
    const result = await processIncomingMessage(batch[index], {
      suppressAutoReply: !isLast,
      forceFirstMessage: isLast && firstMessageWasSuppressed,
      inheritedKeywordReason,
    });

    if (result?.wasFirstMessage) firstMessageWasSuppressed = true;
    if (!inheritedKeywordReason && result?.keywordReason) {
      inheritedKeywordReason = result.keywordReason;
    }
  }
}

/**
 * Persist each webhook message and its durable processing job immediately,
 * then let the short typing debounce decide when to run expensive reply work.
 * The in-memory queue keeps the low-latency happy path; Postgres owns the job
 * state so a Render restart can recover anything that was pending/in-flight.
 */
async function queueIncomingForReply(queueKey, incoming) {
  try {
    const claimed = await enqueueConversation(
      queueKey,
      () => claimIncomingMessage(incoming)
    );
    if (!claimed) {
      console.log(
        `Skipping duplicate/retried ${incoming.channel || "whatsapp"} message ${incoming.id}`
      );
      return null;
    }

    const processingItem = await claimLiveItem(claimed);
    if (!processingItem) {
      // A recovery sweep can win this tiny race after preparation. In that
      // case it owns the durable job and will process it; never run it twice.
      console.log(
        `Inbound processing job already claimed for ${incoming.channel || "whatsapp"} message ${incoming.id}`
      );
      return null;
    }

    return await enqueueConversationBurst(
      queueKey,
      processingItem,
      (items) => processClaimedBatch(items, processIncomingBatch)
    );
  } catch (err) {
    console.error(
      `Failed to claim/queue incoming ${incoming.channel || "whatsapp"} message ${incoming.id || "without id"}:`,
      err
    );
    return null;
  }
}

async function processIncomingMessage(
  item,
  {
    suppressAutoReply = false,
    forceFirstMessage = false,
    inheritedKeywordReason = null,
  } = {}
) {
  const preclaimed = item?.incoming && item?.contact && item?.savedInbound
    ? item
    : null;
  const incoming = preclaimed?.incoming || item;
  const {
    id,
    from,
    mediaType,
    unsupportedType,
  } = incoming;
  const channel = incoming.channel || "whatsapp";
  let contact = preclaimed?.contact || null;
  let savedInbound = preclaimed?.savedInbound || null;
  let responseAttempted = false;
  let wasFirstMessage = Boolean(preclaimed?.wasFirstMessage);
  let keywordReason = inheritedKeywordReason;

  try {
    // Keep a direct-call fallback for internal/tests, but normal webhook flow
    // arrives here already durably claimed before the reply debounce starts.
    if (!preclaimed) {
      const claimed = await claimIncomingMessage(incoming);
      if (!claimed) {
        console.log(`Skipping duplicate/retried ${channel} message ${id}`);
        return { wasFirstMessage: false, keywordReason };
      }
      contact = claimed.contact;
      savedInbound = claimed.savedInbound;
      wasFirstMessage = Boolean(claimed.wasFirstMessage);
    }

    if (unsupportedType) {
      const label = channelMessaging.labelForChannel(channel);
      await contactsRepo.setAttention(
        contact.id,
        true,
        `Unsupported ${label} message (${unsupportedType}) needs staff review.`
      );

      if (!suppressAutoReply) {
        const autoReplyContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "unsupported-message fallback",
        });
        if (autoReplyContact) {
          contact = autoReplyContact;
          responseAttempted = true;
          await sendTrackedText(
            contact,
            "Sorry, I can only read text, voice, or photo messages for now — could you type that out for me? 🙂"
          );
        }
      }
      return { wasFirstMessage, keywordReason };
    }

    let text = incoming.text || "";
    let mediaAttachment = null;

    if (mediaType === "audio") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      const [transcript, mp3] = media
        ? await Promise.all([
            transcribeAudio(media.buffer, media.mimeType),
            convertToMp3(media.buffer),
          ])
        : [null, null];

      if (media) {
        mediaAttachment = mp3
          ? { mimeType: mp3.mimeType, buffer: mp3.buffer }
          : {
              mimeType: media.mimeType.split(";")[0].trim(),
              buffer: media.buffer,
            };
      }

      if (!transcript) {
        await conversationStore.updateInboundMessage(
          contact.id,
          savedInbound.id,
          "🎤 [Voice message could not be transcribed]",
          mediaAttachment
        );
        await contactsRepo.setAttention(
          contact.id,
          true,
          "A patient voice message could not be transcribed."
        );

        if (!suppressAutoReply) {
          const autoReplyContact = await getAiOwnedContact(contact, {
            channel,
            from,
            reason: "voice-transcription fallback",
          });
          if (autoReplyContact) {
            contact = autoReplyContact;
            responseAttempted = true;
            await sendTrackedText(
              contact,
              "Sorry, I couldn't quite catch that voice message — mind typing it out, or sending the voice note again? 🙂"
            );
          }
        }
        return { wasFirstMessage, keywordReason };
      }

      text = `🎤 ${transcript}`;
      await conversationStore.updateInboundMessage(
        contact.id,
        savedInbound.id,
        text,
        mediaAttachment
      );
    }

    if (mediaType === "image") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      if (!media) {
        await contactsRepo.setAttention(
          contact.id,
          true,
          "A patient photo could not be downloaded."
        );

        if (!suppressAutoReply) {
          const autoReplyContact = await getAiOwnedContact(contact, {
            channel,
            from,
            reason: "photo-download fallback",
          });
          if (autoReplyContact) {
            contact = autoReplyContact;
            responseAttempted = true;
            await sendTrackedText(
              contact,
              "Sorry, I couldn't load that photo — mind sending it again? 🙂"
            );
          }
        }
        return { wasFirstMessage, keywordReason };
      }

      mediaAttachment = {
        mimeType: media.mimeType,
        buffer: media.buffer,
      };
      text = incoming.text ? `📷 ${incoming.text}` : "📷 [Patient sent a photo]";
      await conversationStore.updateInboundMessage(
        contact.id,
        savedInbound.id,
        text,
        mediaAttachment
      );
    }

    // Photos without captions and failed/unsupported media contain no text
    // that can safely support a sales-temperature decision.
    const temperatureReviewEligible = Boolean(text.trim()) && !(
      mediaType === "image" && !incoming.text
    );

    if (temperatureReviewEligible) {
      try {
        await reviewLeadTemperatureForMessage(contact.id, savedInbound.id, text);
      } catch (temperatureErr) {
        // Lead categorization must never prevent or replace a customer reply.
        console.error(
          `Failed to apply lead temperature rules for contact ${contact.id}:`,
          temperatureErr
        );
      }
    }

    keywordReason = keywordReason || checkKeywordTriggers(text);

    // Re-read ownership after media processing. Staff may have taken over
    // while a download or transcription was running.
    const currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact) throw new Error(`Contact ${contact.id} disappeared during processing.`);
    contact = currentContact;

    if (contact.mode === "human") {
      await contactsRepo.setAttention(
        contact.id,
        true,
        keywordReason || "New message — conversation is staff-owned."
      );
      console.log(`Skipping AI reply for ${channel}:${from} — conversation is in human mode.`);
      return { wasFirstMessage, keywordReason };
    }

    // Earlier messages in the same typing burst are fully saved/transcribed and
    // included in history, but only the last one gets an AI response. This is
    // what turns three short chat bubbles into one coherent assistant reply.
    if (suppressAutoReply) {
      return { wasFirstMessage, keywordReason };
    }

    const history = await conversationStore.getHistoryForContact(contact.id, {
      throughMessageId: savedInbound.id,
    });
    const isFirstMessage = forceFirstMessage || history.length === 1;
    const rawAiReply = await ai.getReply(history, { isFirstMessage, channel });
    const parsedReply = parseAiReplyResult(rawAiReply);
    let {
      text: aiReply,
      flagged,
      bookingReady,
      details,
    } = parsedReply;

    // The deterministic keyword layer is a safety backstop, not just a badge.
    // If the model misses the handoff entirely, force one. For high-confidence
    // urgent symptom phrases, always use the deterministic immediate-care
    // wording even if the model did choose needs_human but wrote a weak reply.
    if (keywordReason && (!flagged || isUrgentSafetyMessage(text))) {
      flagged = true;
      bookingReady = false;
      aiReply = fallbackHandoffReply(text, clinicConfig.escalation.handoffMessage);
    }

    const reply = isFirstMessage
      ? `${clinicConfig.introMessage}\n\n${aiReply}`
      : aiReply;

    // AI generation can take long enough for staff to take over after the
    // earlier ownership check. Re-check immediately before any AI-owned state
    // change or outbound send.
    const aiReplyContact = await getAiOwnedContact(contact, {
      channel,
      from,
      reason: "AI reply",
    });
    if (!aiReplyContact) return { wasFirstMessage, keywordReason };
    contact = aiReplyContact;

    if (flagged) {
      // A handoff is an actual ownership transition, not only a red badge.
      const pausedContact = await pauseAiForHumanHandoff(
        contact.id,
        keywordReason || "AI handed off this conversation."
      );
      if (!pausedContact) return { wasFirstMessage, keywordReason };

      // Staff can claim the synthetic handoff immediately from the Inbox. Do a
      // final ownership read right before the one allowed AI handoff message so
      // a late model reply does not overwrite a staff member who already acted.
      const pendingHandoff = await getPendingAiHandoffContact(pausedContact.id);
      if (!pendingHandoff) return { wasFirstMessage, keywordReason };
      contact = pendingHandoff;
    } else if (bookingReady) {
      try {
        await markBookingReadyForContact(contact.id, savedInbound.id, {
          details,
        });
      } catch (bookingOutcomeErr) {
        // Sales bookkeeping/alerts must never prevent the customer from
        // receiving the AI reply that tells them staff will confirm the slot.
        console.error(
          `Failed to apply booking-ready outcome for contact ${contact.id}:`,
          bookingOutcomeErr
        );
      }
    }

    responseAttempted = true;
    const sendOutcome = await sendTrackedText(contact, reply);

    // Never follow a sensitive handoff, deterministic safety match, Booking
    // Ready outcome, unresolved staff-attention state, or failed text delivery
    // with a sales graphic. A first-time complaint/medical issue should not be
    // answered with a HIFU promo immediately after the handoff message.
    if (
      isFirstMessage &&
      !flagged &&
      !bookingReady &&
      !keywordReason &&
      !contact.needs_attention &&
      sendOutcome.sendResult.success
    ) {
      const promo = getActivePromotion(clinicConfig.promotions);
      if (promo) {
        const promoContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "automatic promo image",
        });
        // Re-check both ownership and attention immediately before the promo.
        if (!promoContact || promoContact.needs_attention) {
          return { wasFirstMessage, keywordReason };
        }
        contact = promoContact;

        const savedPromo = await conversationStore.appendMessageForContact(
          contact.id,
          "assistant",
          promo.caption || "",
          null,
          null,
          promo.imageUrl
        );
        const promoResult = await channelMessaging.sendImageByUrl(
          contact,
          promo.imageUrl,
          promo.caption
        );
        const promoError = promoResult.error || channelMessaging.rejectedError(contact.channel);
        await persistSendOutcome(savedPromo, promoResult, promoError);
        if (!promoResult.success) {
          console.warn(`Promo image failed to send to ${channel}:${from}, continuing without it.`);
          await contactsRepo.setDeliveryAttention(
            contact.id,
            `Delivery failed: ${promoError}`
          );
        }
      }
    }

    return { wasFirstMessage, keywordReason };
  } catch (err) {
    console.error(`Error handling incoming ${channel} message ${id || "without id"}:`, err);

    if (suppressAutoReply) {
      if (contact && savedInbound) {
        try {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
        } catch (attentionErr) {
          console.error("Failed to flag the suppressed burst message after an error:", attentionErr);
        }
      }
      return { wasFirstMessage, keywordReason };
    }

    if (contact && savedInbound) {
      try {
        const fallbackContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "processing-error fallback",
        });

        if (!fallbackContact) {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
          return { wasFirstMessage, keywordReason };
        }

        const pausedContact = await pauseAiForHumanHandoff(
          fallbackContact.id,
          "Message processing failed. A staff reply is needed."
        );
        if (!pausedContact) return { wasFirstMessage, keywordReason };

        const pendingHandoff = await getPendingAiHandoffContact(pausedContact.id);
        if (!pendingHandoff) return { wasFirstMessage, keywordReason };

        if (!responseAttempted) {
          responseAttempted = true;
          await sendTrackedText(
            pendingHandoff,
            "Sorry, something went wrong on our end — a team member will follow up with you shortly!"
          );
        }
      } catch (fallbackErr) {
        console.error("Failed to save or send the fallback message:", fallbackErr);
        try {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
        } catch (attentionErr) {
          console.error("Failed to flag the conversation after fallback failure:", attentionErr);
        }
      }
    }

    return { wasFirstMessage, keywordReason };
  }
}

const app = express();

// Needed so req.protocol correctly reflects the original https scheme when
// running behind a reverse proxy (Render, most PaaS hosts) — used to build a
// correct public URL for uploaded promo images.
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

// ── WhatsApp webhook: needs the raw body for signature verification, so it
// gets its own JSON parser instance separate from the portal API's. ──
if (!process.env.WHATSAPP_APP_SECRET && process.env.NODE_ENV === "production") {
  console.error(
    "❌ WHATSAPP_APP_SECRET is not set. Refusing to start, since without it " +
      "the webhook cannot verify incoming requests actually came from Meta. " +
      "Set WHATSAPP_APP_SECRET (see .env.example) and restart."
  );
  process.exit(1);
}
const webhookJsonParser = bodyParser.json({ verify: verifyWebhookSignature });

// Facebook and Instagram use a separate callback and app secret. Keeping this
// parser separate means enabling social channels cannot change how WhatsApp's
// existing webhook signature verification behaves.
const socialMessagingConfigured =
  metaMessaging.configured("facebook") || metaMessaging.configured("instagram");
if (
  socialMessagingConfigured &&
  !process.env.META_APP_SECRET &&
  process.env.NODE_ENV === "production"
) {
  console.error(
    "❌ META_APP_SECRET is not set. Refusing to start with Facebook/Instagram messaging enabled, " +
      "since the social webhook cannot verify requests from Meta."
  );
  process.exit(1);
}
const metaWebhookJsonParser = bodyParser.json({ verify: verifyMetaWebhookSignature });

// ── Portal API: normal JSON parsing + signed session cookie for staff login. ──
app.use("/api", bodyParser.json());
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error(
    "❌ SESSION_SECRET is not set. Refusing to start, since a missing/default " +
      "session secret would let anyone forge a valid staff login cookie. Set " +
      "SESSION_SECRET (see .env.example) and restart."
  );
  process.exit(1);
}

app.use(
  "/api",
  cookieSession({
    name: "session",
    secret: SESSION_SECRET,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

// ── Health check ──
app.get("/", (req, res) => {
  res.send("Clinic AI messaging bot is running.");
});

// ── WhatsApp webhook verification (unchanged callback) ──
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("WhatsApp webhook verification failed — token mismatch.");
  return res.sendStatus(403);
});

// ── Incoming WhatsApp messages and delivery statuses ──
app.post("/webhook", webhookJsonParser, async (req, res) => {
  // Respond to Meta immediately — don't make them wait on the AI call,
  // or Meta may retry/resend the same message.
  res.sendStatus(200);
  const webhookActivity = setupStatusRepo.recordWebhook("whatsapp_webhook").catch((err) => {
    console.error("Failed to record WhatsApp webhook activity:", err);
  });

  // The durable message + processing-job claim runs immediately in
  // queueIncomingForReply(); only expensive media/AI work waits for debounce.
  const incomingWork = Promise.all(
    whatsapp.parseIncomingMessages(req.body).map((incoming) =>
      queueIncomingForReply(incoming.from, incoming)
    )
  );

  // ── Async WhatsApp delivery-status callbacks (sent/delivered/read/failed) ──
  const statusUpdates = whatsapp.parseStatusUpdates(req.body);
  for (const update of statusUpdates) {
    try {
      const updatedMessage = await messagesRepo.updateDeliveryStatusByWamid(
        update.wamid,
        update.status,
        update.errorMessage || update.errorTitle || null
      );

      if (!updatedMessage) continue;

      publishDeliveryStatus(updatedMessage);

      if (update.status === "failed") {
        const reason = update.errorMessage || update.errorTitle || "WhatsApp reported delivery as failed.";
        console.error(`Delivery failed for message ${update.wamid} (code ${update.errorCode}):`, reason);
        await contactsRepo.setDeliveryAttention(
          updatedMessage.contact_id,
          `Delivery failed: ${reason}`
        );
      }
    } catch (err) {
      console.error("Failed to process delivery-status update:", err);
    }
  }

  await Promise.all([incomingWork, webhookActivity]);
});

// ── Facebook Messenger + Instagram Messaging webhook verification ──
app.get("/meta-webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("Facebook/Instagram webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("Facebook/Instagram webhook verification failed — token mismatch.");
  return res.sendStatus(403);
});

app.post("/meta-webhook", metaWebhookJsonParser, async (req, res) => {
  // Acknowledge Meta before AI/network work for the same retry protection used
  // by the existing WhatsApp webhook.
  res.sendStatus(200);
  const webhookActivity = setupStatusRepo.recordWebhook("meta_webhook").catch((err) => {
    console.error("Failed to record Meta webhook activity:", err);
  });

  const incomingMessages = metaMessaging.parseIncomingMessages(req.body);
  const resolvedEditMessages = await metaMessaging.resolveMessageEditEvents(req.body);
  const allIncoming = [...incomingMessages, ...resolvedEditMessages];

  try {
    await Promise.all([
      webhookActivity,
      ...allIncoming.map((incoming) =>
        queueIncomingForReply(
          `${incoming.channel}:${incoming.from}`,
          incoming
        )
      ),
    ]);
  } catch (err) {
    console.error("Failed to process incoming Meta message(s):", err);
  }
});

// ── Promo graphics uploaded from Settings > Promotions — served publicly.
app.get("/promo-images/:id", async (req, res) => {
  try {
    const image = await promoImagesRepo.getImage(req.params.id);
    if (!image) return res.status(404).send("Not found");

    res.set("Content-Type", image.mime_type);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(image.data, "base64"));
  } catch (err) {
    console.error("Failed to serve promo image:", err);
    res.status(500).send("Something went wrong.");
  }
});

// ── Management portal API ──
app.use("/api/auth", authRoutes);
app.use("/api/conversations", requireAuth, conversationsRoutes);
app.use("/api/config", requireAuth, configRoutes);
app.use("/api/contacts", requireAuth, contactsRoutes);
app.use("/api/pipeline", requireAuth, pipelineRoutes);
app.use("/api/setup-status", requireAuth, setupStatusRoutes);

// ── Serve the built portal frontend in production ──
const portalBuildPath = path.join(__dirname, "../portal-frontend/dist");
app.use(express.static(portalBuildPath));
app.get(/^(?!\/(webhook|meta-webhook|api)).*/, (req, res) => {
  res.sendFile(path.join(portalBuildPath, "index.html"), (err) => {
    if (err) res.status(404).send("Portal not built yet — run `npm run build` in portal-frontend/, or use `npm run dev` there for local development.");
  });
});

async function start() {
  // Create tables if they don't exist yet — safe to run every startup.
  await initSchema();

  // Loads the clinic config (branches, services, AI tone/playbook/SOP, etc.)
  // from Postgres into the shared, in-memory clinicConfig object.
  await configRepo.loadConfig();

  // Bring existing conversations into the first pipeline stage on the
  // initial deployment.
  const backfilledLeadCount = await pipelineRepo.backfillLeadsForExistingContacts();
  if (backfilledLeadCount > 0) {
    console.log(`Added ${backfilledLeadCount} existing conversation(s) to the lead pipeline.`);
  }

  await bootstrapAdminUser();

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  pruneOrphanedPromoImages();
  setInterval(pruneOrphanedPromoImages, PROMO_IMAGE_PRUNE_INTERVAL_MS);

  startInboundProcessingRecovery({ processBatch: processIncomingBatch });
  startAutomatedFollowUps();
  startStaffWaitingAlerts();
  startLeadScoring();
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});