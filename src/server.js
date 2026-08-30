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
const conversationStore = require("./utils/conversationStore");
const { getActivePromotion } = require("./utils/activePromotion");
const clinicConfig = require("./config/clinicConfig");
const messagesRepo = require("./db/messagesRepo");
const contactsRepo = require("./db/contactsRepo");
const pipelineRepo = require("./db/pipelineRepo");
const { checkKeywordTriggers, extractHandoffSignal } = require("./utils/attentionTriggers");
const realtimeEvents = require("./utils/realtimeEvents");
const { enqueueConversation } = require("./utils/conversationQueue");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { verifyMetaWebhookSignature } = require("./middleware/verifyMetaWebhookSignature");
const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const configRoutes = require("./routes/config");
const contactsRoutes = require("./routes/contacts");
const pipelineRoutes = require("./routes/pipeline");
const { bootstrapAdminUser } = require("./db/bootstrapAdmin");
const configRepo = require("./db/configRepo");
const { pruneOrphanedPromoImages } = configRepo;
const promoImagesRepo = require("./db/promoImagesRepo");
const { initSchema } = require("./db/db");
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

function initialInboundText(incoming) {
  if (incoming.unsupportedType) {
    return `📎 [Patient sent an unsupported ${incoming.unsupportedType} message]`;
  }
  if (incoming.mediaType === "audio") return "🎤 [Patient sent a voice message]";
  if (incoming.mediaType === "image") {
    return incoming.text ? `📷 ${incoming.text}` : "📷 [Patient sent a photo]";
  }
  return incoming.text || "[Patient sent an empty message]";
}

async function processIncomingMessage(incoming) {
  const {
    id,
    from,
    profileName,
    mediaType,
    unsupportedType,
  } = incoming;
  const channel = incoming.channel || "whatsapp";
  let contact = null;
  let savedInbound = null;
  let responseAttempted = false;

  try {
    contact = channel === "whatsapp"
      ? await contactsRepo.getOrCreateContact(from, profileName)
      : await contactsRepo.getOrCreateChannelContact(
          channel,
          from,
          profileName,
          incoming.photoUrl || null
        );

    // This INSERT is the durable webhook claim. It happens before media or AI
    // work and uses ON CONFLICT, so simultaneous Meta retries cannot both send
    // a response. Prefix social message ids with their channel so they can
    // never collide with WhatsApp WAMIDs or another social network's ids.
    const storedInboundId = channel === "whatsapp" ? id : `${channel}:${id}`;
    savedInbound = await conversationStore.appendInboundMessageIfNew(
      contact.id,
      initialInboundText(incoming),
      storedInboundId
    );
    if (!savedInbound) {
      console.log(`Skipping duplicate/retried ${channel} message ${id}`);
      return;
    }

    await contactsRepo.setUnread(contact.id, true);

    // Every genuine first inbound conversation becomes a lead. The partial
    // unique index keeps one open sales journey per contact while still
    // allowing a returning patient to start a new journey after closing one.
    try {
      await pipelineRepo.ensureLeadForContact(
        contact.id,
        "Automation",
        savedInbound.id
      );
    } catch (pipelineErr) {
      // Pipeline bookkeeping must never prevent the chatbot from answering.
      console.error(`Failed to create or locate lead for contact ${contact.id}:`, pipelineErr);
    }

    if (unsupportedType) {
      const label = channelMessaging.labelForChannel(channel);
      await contactsRepo.setAttention(
        contact.id,
        true,
        `Unsupported ${label} message (${unsupportedType}) needs staff review.`
      );
      responseAttempted = true;
      await sendTrackedText(
        contact,
        "Sorry, I can only read text, voice, or photo messages for now — could you type that out for me? 🙂"
      );
      return;
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
        responseAttempted = true;
        await sendTrackedText(
          contact,
          "Sorry, I couldn't quite catch that voice message — mind typing it out, or sending the voice note again? 🙂"
        );
        return;
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
        responseAttempted = true;
        await sendTrackedText(
          contact,
          "Sorry, I couldn't load that photo — mind sending it again? 🙂"
        );
        return;
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

    const keywordReason = checkKeywordTriggers(text);
    if (keywordReason) {
      await contactsRepo.setAttention(contact.id, true, keywordReason);
    }

    // Re-read ownership after media processing. Staff may have taken over
    // while a download or transcription was running.
    const currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact) throw new Error(`Contact ${contact.id} disappeared during processing.`);
    contact = currentContact;

    if (contact.mode === "human") {
      if (!keywordReason) {
        await contactsRepo.setAttention(
          contact.id,
          true,
          "New message — conversation is staff-owned."
        );
      }
      console.log(`Skipping AI reply for ${channel}:${from} — conversation is in human mode.`);
      return;
    }

    const history = await conversationStore.getHistoryForContact(contact.id);
    const isFirstMessage = history.length === 1;
    const rawAiReply = await ai.getReply(history, isFirstMessage);
    const { text: aiReply, flagged } = extractHandoffSignal(rawAiReply);

    if (flagged) {
      await contactsRepo.setAttention(
        contact.id,
        true,
        "AI handed off this conversation."
      );
    }

    const reply = isFirstMessage
      ? `${clinicConfig.introMessage}\n\n${aiReply}`
      : aiReply;

    responseAttempted = true;
    await sendTrackedText(contact, reply);

    if (isFirstMessage) {
      const promo = getActivePromotion(clinicConfig.promotions);
      if (promo) {
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
  } catch (err) {
    console.error(`Error handling incoming ${channel} message ${id || "without id"}:`, err);

    if (contact && savedInbound) {
      try {
        await contactsRepo.setAttention(
          contact.id,
          true,
          "Message processing failed. A staff reply is needed."
        );
      } catch (attentionErr) {
        console.error("Failed to flag the conversation after a processing error:", attentionErr);
      }
    }

    if (contact && savedInbound && !responseAttempted) {
      try {
        responseAttempted = true;
        await sendTrackedText(
          contact,
          "Sorry, something went wrong on our end — a team member will follow up with you shortly!"
        );
      } catch (fallbackErr) {
        console.error("Failed to save or send the fallback message:", fallbackErr);
      }
    }
  }
}

const app = express();

// Needed so req.protocol correctly reflects the original https scheme when
// running behind a reverse proxy (Render, most PaaS hosts) — used to build
// a correct public URL for uploaded promo images (see routes/config.js and
// the GET /promo-images/:id route below).
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

// ── WhatsApp webhook: needs the raw body for signature verification, so it
// gets its own JSON parser instance separate from the portal API's. ──
// Same reasoning as SESSION_SECRET below: fail fast at startup in production
// rather than silently accepting unsigned webhook requests, which would let
// anyone who finds the webhook URL inject fake "patient" messages that the
// bot processes and replies to.
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
// Fail fast rather than silently falling back to a hardcoded secret — a
// missing/default session secret would let anyone forge a valid staff
// login cookie. Generate a real one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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

  // Put inbound messages in their per-customer queue before awaiting any
  // delivery-status database work. This preserves request arrival order even
  // when Meta sends messages and status callbacks in the same webhook batch.
  const incomingWork = Promise.all(
    whatsapp.parseIncomingMessages(req.body).map((incoming) =>
      enqueueConversation(incoming.from, () => processIncomingMessage(incoming))
    )
  );

  // ── Async WhatsApp delivery-status callbacks (sent/delivered/read/failed) ──
  // A 200 OK from the earlier send call only meant Meta *accepted* the
  // request — this is where the real outcome shows up, separately and later.
  const statusUpdates = whatsapp.parseStatusUpdates(req.body);
  for (const update of statusUpdates) {
    try {
      const updatedMessage = await messagesRepo.updateDeliveryStatusByWamid(
        update.wamid,
        update.status,
        update.errorMessage || update.errorTitle || null
      );

      // No matching row means this message predates whatsapp_message_id
      // being captured for outbound sends, or it's a status for something
      // we don't track (e.g. a template message) — nothing more to do.
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

  await incomingWork;
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

// TEMPORARY DIAGNOSTIC ROUTE — remove once the Instagram token issue is
// resolved. Never returns the token itself, only safe metadata (length,
// first/last few chars, whitespace/quote detection) so it can't leak the
// credential even if someone else hits this URL. Gated behind
// META_VERIFY_TOKEN as a crude shared-secret check since it's exposed on a
// public Render URL.
app.get("/debug-instagram-token", (req, res) => {
  if (req.query.key !== process.env.META_VERIFY_TOKEN) {
    return res.sendStatus(404);
  }
  const token = process.env.INSTAGRAM_ACCESS_TOKEN || "";
  res.json({
    length: token.length,
    first8: token.slice(0, 8),
    last4: token.slice(-4),
    hasWhitespace: /\s/.test(token),
    hasQuoteChars: /["']/.test(token),
  });
});

app.post("/meta-webhook", metaWebhookJsonParser, async (req, res) => {
  // Acknowledge Meta before AI/network work for the same retry protection used
  // by the existing WhatsApp webhook.
  res.sendStatus(200);

  // TEMPORARY DIAGNOSTIC — remove once Instagram messages are confirmed
  // flowing end-to-end. Logs the full raw payload (message content/IDs
  // only, no secrets) and how many messages parseIncomingMessages extracted.
  console.log("[meta-webhook debug] raw body:", JSON.stringify(req.body));

  const incomingMessages = metaMessaging.parseIncomingMessages(req.body);
  console.log(`[meta-webhook debug] parsed ${incomingMessages.length} message(s):`, JSON.stringify(incomingMessages));

  try {
    await Promise.all(
      incomingMessages.map((incoming) =>
        enqueueConversation(
          `${incoming.channel}:${incoming.from}`,
          () => processIncomingMessage(incoming)
        )
      )
    );
  } catch (err) {
    console.error("[meta-webhook debug] error while processing incoming message(s):", err);
  }
});

// ── Promo graphics uploaded from Settings > Promotions — served publicly.
// WhatsApp, Messenger and Instagram need a publicly fetchable URL when an
// outbound promo image is sent by link.
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
  // from Postgres into the shared, in-memory clinicConfig object — see
  // db/configRepo.js. On a brand-new database this also seeds the table
  // from config/clinicConfig.default.js.
  await configRepo.loadConfig();

  // Bring existing conversations into the first pipeline stage on the
  // initial deployment. Later starts are a no-op once a contact has any
  // recorded sales journey, including a completed one.
  const backfilledLeadCount = await pipelineRepo.backfillLeadsForExistingContacts();
  if (backfilledLeadCount > 0) {
    console.log(`Added ${backfilledLeadCount} existing conversation(s) to the lead pipeline.`);
  }

  // Creates a first staff login from ADMIN_USERNAME/ADMIN_PASSWORD env vars,
  // but only if no staff logins exist yet. Needed for hosts without shell
  // access (e.g. Render's free tier) — see src/db/bootstrapAdmin.js.
  await bootstrapAdminUser();

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // Catches promo images that were uploaded (writing a row immediately —
  // see promoImagesRepo.saveImage) but never made it into a saved config.
  pruneOrphanedPromoImages();
  setInterval(pruneOrphanedPromoImages, PROMO_IMAGE_PRUNE_INTERVAL_MS);

  // Automated follow-ups deliberately remain WhatsApp-only. The query in
  // followUpRepo.js already filters c.channel = 'whatsapp', so adding social
  // auto replies cannot change that existing behavior.
  startAutomatedFollowUps();

  // If staff owns a conversation and a customer has been waiting without a
  // successful outbound reply for 10 minutes, send one separate Telegram
  // reminder for that unanswered episode. Returning to AI cancels eligibility.
  startStaffWaitingAlerts();

  // Reviews eligible lead conversations after a quiet period or a configured
  // ceiling. This runs outside the webhook response path, uses durable claims,
  // and is a no-op until staff enables it in Tools.
  startLeadScoring();
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
