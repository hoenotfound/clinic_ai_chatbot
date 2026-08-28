require("dotenv").config();
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
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
const {
  reviewLeadTemperatureForMessage,
} = require("./services/leadTemperatureAutomation");

// How often the backstop sweep for abandoned promo-image uploads runs —
// see the setInterval call in start() below.
const PROMO_IMAGE_PRUNE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SEND_REJECTED_ERROR =
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

async function persistSendOutcome(savedMessage, sendResult, errorText = SEND_REJECTED_ERROR) {
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
  const sendResult = await whatsapp.sendMessage(contact.whatsapp_number, text);
  const finalMessage = await persistSendOutcome(saved, sendResult);

  if (!sendResult.success) {
    await contactsRepo.setDeliveryAttention(
      contact.id,
      `Delivery failed: ${SEND_REJECTED_ERROR}`
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
  const { id, from, profileName, mediaId, mediaType, unsupportedType } = incoming;
  let contact = null;
  let savedInbound = null;
  let responseAttempted = false;

  try {
    contact = await contactsRepo.getOrCreateContact(from, profileName);

    // This INSERT is the durable webhook claim. It happens before media or AI
    // work and uses ON CONFLICT, so simultaneous Meta retries cannot both send
    // a response. The placeholder also makes a failed media operation visible
    // in the Inbox instead of silently dropping the patient's message.
    savedInbound = await conversationStore.appendInboundMessageIfNew(
      contact.id,
      initialInboundText(incoming),
      id
    );
    if (!savedInbound) {
      console.log(`Skipping duplicate/retried message ${id}`);
      return;
    }

    await contactsRepo.setUnread(contact.id, true);

    // Every genuine first inbound conversation becomes a lead. The partial
    // unique index keeps one open sales journey per contact while still
    // allowing a returning patient to start a new journey after closing one.
    try {
      await pipelineRepo.ensureLeadForContact(contact.id, "Automation");
    } catch (pipelineErr) {
      // Pipeline bookkeeping must never prevent the chatbot from answering.
      console.error(`Failed to create or locate lead for contact ${contact.id}:`, pipelineErr);
    }

    if (unsupportedType) {
      await contactsRepo.setAttention(
        contact.id,
        true,
        `Unsupported WhatsApp message (${unsupportedType}) needs staff review.`
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
      const media = mediaId ? await whatsapp.downloadMedia(mediaId) : null;
      const [transcript, mp3] = media
        ? await Promise.all([
            transcribeAudio(media.buffer, media.mimeType),
            convertToMp3(media.buffer),
          ])
        : [null, null];

      if (media) {
        mediaAttachment = mp3
          ? { mimeType: mp3.mimeType, data: mp3.buffer.toString("base64") }
          : {
              mimeType: media.mimeType.split(";")[0].trim(),
              data: media.buffer.toString("base64"),
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
      const media = mediaId ? await whatsapp.downloadMedia(mediaId) : null;
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
        data: media.buffer.toString("base64"),
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
      console.log(`Skipping AI reply for ${from} — conversation is in human mode.`);
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
        const promoResult = await whatsapp.sendImage(from, promo.imageUrl, promo.caption);
        await persistSendOutcome(savedPromo, promoResult);
        if (!promoResult.success) {
          console.warn(`Promo image failed to send to ${from}, continuing without it.`);
          await contactsRepo.setDeliveryAttention(
            contact.id,
            `Delivery failed: ${SEND_REJECTED_ERROR}`
          );
        }
      }
    }
  } catch (err) {
    console.error(`Error handling incoming message ${id || "without id"}:`, err);

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
  res.send("WhatsApp AI Clinic Bot is running.");
});

// ── Webhook verification (Meta calls this once when you set up the webhook) ──
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("Webhook verification failed — token mismatch.");
  return res.sendStatus(403);
});

// ── Incoming messages ──
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

  // ── Async delivery-status callbacks (sent/delivered/read/failed) ──
  // A 200 OK from the earlier send call only meant Meta *accepted* the
  // request — this is where the real outcome shows up, separately and
  // later. Without this, a message that fails after being accepted (e.g. a
  // media/format problem, or the recipient being outside the 24-hour
  // messaging window) looks identical to a successful send anywhere else in
  // the app: the Inbox would show it as sent forever, with no way for staff
  // to know the patient never actually got it.
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

// ── Promo graphics uploaded from Settings > Promotions — served publicly,
// deliberately with NO auth, since WhatsApp's Cloud API has to fetch this
// URL directly (by link, see services/whatsappService.js sendImage()) to
// actually send the image, and Meta's servers obviously can't log in as
// staff first. Nothing sensitive lives here — just clinic promo graphics. ──
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
app.get(/^(?!\/(webhook|api)).*/, (req, res) => {
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

  // Bring existing WhatsApp conversations into the first pipeline stage on
  // the initial deployment. Later starts are a no-op once a contact has any
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
  // see promoImagesRepo.saveImage) but never made it into a saved config:
  // staff picked a file then closed the tab, switched away, or the browser
  // crashed before hitting Save. The explicit deletes in
  // routes/config.js/Settings.jsx and the post-save reconcile in
  // configRepo.updateConfig() cover the normal flows; this timer is the
  // backstop for everything else. Runs on startup too, in case the server
  // was down when an abandoned upload's grace period elapsed.
  pruneOrphanedPromoImages();
  setInterval(pruneOrphanedPromoImages, PROMO_IMAGE_PRUNE_INTERVAL_MS);

  // Checks once a minute for outbound messages that have reached the
  // staff-configured follow-up delay without a customer reply. The service
  // is a no-op while the tool is disabled.
  startAutomatedFollowUps();

  // Reviews eligible lead conversations after a quiet period or a configured
  // ceiling. This runs outside the webhook response path, uses durable claims,
  // and is a no-op until staff enables it in Tools.
  startLeadScoring();
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
