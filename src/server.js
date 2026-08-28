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
const { checkKeywordTriggers, extractHandoffSignal } = require("./utils/attentionTriggers");
const realtimeEvents = require("./utils/realtimeEvents");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const configRoutes = require("./routes/config");
const contactsRoutes = require("./routes/contacts");
const { bootstrapAdminUser } = require("./db/bootstrapAdmin");
const configRepo = require("./db/configRepo");
const { pruneOrphanedPromoImages } = configRepo;
const promoImagesRepo = require("./db/promoImagesRepo");
const { initSchema } = require("./db/db");
const { startAutomatedFollowUps } = require("./services/followUpService");

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

  const incomingMessages = whatsapp.parseIncomingMessages(req.body);

  for (const incoming of incomingMessages) {
    const { id, from, profileName, mediaId, mediaType, unsupportedType } = incoming;
    let text = incoming.text;
    let mediaAttachment = null; // patient photo or voice note audio, persisted via appendMessage below

    // Persisted dedup check (survives restarts) — the messages table has a
    // unique constraint on whatsapp_message_id, this is just a friendlier
    // early-exit than catching that constraint error.
    if (await messagesRepo.messageExistsByWhatsappId(id)) {
      console.log(`Skipping duplicate/retried message ${id}`);
      continue;
    }

    try {
      if (unsupportedType) {
        await whatsapp.sendMessage(
          from,
          "Sorry, I can only read text, voice, or photo messages for now — could you type that out for me? 🙂"
        );
        continue;
      }

      // Voice note: download from WhatsApp and transcribe (English / Bahasa
      // Malaysia / Chinese, incl. mixed-language "Manglish" speech), then
      // treat it exactly like a text message from here on. Also persist a
      // playable copy of the audio (base64, in Postgres — see schema.sql) so
      // staff can play the original recording in the Inbox — useful since
      // transcription isn't perfect, especially with mixed languages or
      // medical/treatment names, and tone/urgency don't come through in
      // text. WhatsApp voice notes are Ogg/Opus, which Safari can't play at
      // all, so we transcode to MP3 for storage/playback; transcription
      // itself uses the original audio, since that format is irrelevant to Gemini.
      if (mediaType === "audio") {
        const media = await whatsapp.downloadMedia(mediaId);
        const transcript = media ? await transcribeAudio(media.buffer, media.mimeType) : null;

        if (!transcript) {
          await whatsapp.sendMessage(
            from,
            "Sorry, I couldn't quite catch that voice message — mind typing it out, or sending the voice note again? 🙂"
          );
          continue;
        }
        text = `🎤 ${transcript}`;

        const mp3 = await convertToMp3(media.buffer);
        mediaAttachment = mp3
          ? { mimeType: mp3.mimeType, data: mp3.buffer.toString("base64") }
          // Conversion failing shouldn't block the reply — fall back to the
          // original audio (playable in Chrome/Firefox/Edge, just not
          // Safari) rather than losing playback entirely. Mime type is
          // sanitized (no "; codecs=opus" param) so it's still a valid data URI.
          : { mimeType: media.mimeType.split(";")[0].trim(), data: media.buffer.toString("base64") };
      }

      // Photo: download and persist it (base64, in Postgres — see schema.sql)
      // so it shows in the Inbox and so the AI can still look at it in later
      // turns, not just the turn it arrived on. The AI already has a
      // guardrail (clinicConfig guardrails) against assessing treatment
      // suitability from a photo — it can comment on/discuss it, but hands
      // off medical judgment calls to a doctor same as it would for a text
      // question.
      if (mediaType === "image") {
        const media = await whatsapp.downloadMedia(mediaId);
        if (!media) {
          await whatsapp.sendMessage(
            from,
            "Sorry, I couldn't load that photo — mind sending it again? 🙂"
          );
          continue;
        }
        mediaAttachment = { mimeType: media.mimeType, data: media.buffer.toString("base64") };
        text = text ? `📷 ${text}` : "📷 [Patient sent a photo]";
      }

      console.log(`Incoming from ${from}: ${text}`);

      // Fetch (or create) the contact first — we need its current mode
      // before deciding whether the AI should even respond.
      const contact = await contactsRepo.getOrCreateContact(from, profileName);

      // Save the patient's message first, independent of whether the AI
      // reply succeeds — so it always shows in the inbox, even on failure.
      await conversationStore.appendMessage(from, "user", text, id, null, null, mediaAttachment);
      await contactsRepo.setUnread(contact.id, true);

      // Keyword safety-net — runs on every inbound message regardless of
      // mode, so urgent messages get flagged even if a human already owns
      // the conversation. See utils/attentionTriggers.js.
      const keywordReason = checkKeywordTriggers(text);
      if (keywordReason) {
        await contactsRepo.setAttention(contact.id, true, keywordReason);
      }

      // ── Human takeover: a staff member owns this conversation ──
      // The AI stays completely silent — no auto-reply, no promo. Staff
      // reply manually from the portal until they hit "Return to AI".
      // We still flag needs_attention (above, if triggered, or here
      // unconditionally) so staff know there's a new unread message.
      if (contact.mode === "human") {
        if (!keywordReason) {
          await contactsRepo.setAttention(contact.id, true, "New message — conversation is staff-owned.");
        }
        console.log(`Skipping AI reply for ${from} — conversation is in human mode.`);
        continue;
      }

      const history = await conversationStore.getHistory(from); // now includes the message just saved

      // history.length === 1 means this save was the very first message this
      // patient has ever sent — a reliable, code-level check (not something
      // left to the AI to remember). This guarantees the intro is correct
      // and present 100% of the time, with zero chance of the model skipping
      // it, leaving a placeholder in, or getting the clinic name wrong.
      const isFirstMessage = history.length === 1;

      const rawAiReply = await ai.getReply(history, isFirstMessage);

      // Strip the internal [[NEEDS_HUMAN]] marker (see systemPrompt.js) —
      // the patient never sees it, but it tells us to flag this chat.
      const { text: aiReply, flagged } = extractHandoffSignal(rawAiReply);
      if (flagged) {
        await contactsRepo.setAttention(contact.id, true, "AI handed off this conversation.");
      }

      const reply = isFirstMessage
        ? `${clinicConfig.introMessage}\n\n${aiReply}`
        : aiReply;

      const savedReply = await conversationStore.appendMessage(from, "assistant", reply);

      const replyResult = await whatsapp.sendMessage(from, reply);
      await persistSendOutcome(savedReply, replyResult);
      if (!replyResult.success) {
        await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${SEND_REJECTED_ERROR}`);
      }
      console.log(`Replied to ${from}: ${reply}`);

      // Promo graphic — first message only, code-triggered (see comment above
      // for why this can't be left to the AI to decide). Sent AFTER the text
      // reply so the patient's actual question gets answered first and the
      // image reinforces it, not the other way round.
      if (isFirstMessage) {
        const promo = getActivePromotion(clinicConfig.promotions);
        if (promo) {
          // Save first so an immediate rejection still appears as failed in
          // the Inbox and staff can retry the same promo message.
          const savedPromo = await conversationStore.appendMessage(
            from,
            "assistant",
            promo.caption || "",
            null,
            null,
            promo.imageUrl
          );
          const promoResult = await whatsapp.sendImage(from, promo.imageUrl, promo.caption);
          await persistSendOutcome(savedPromo, promoResult);
          // Never throw on a failed promo image — the text reply already
          // succeeded and that's what actually matters to the patient.
          if (!promoResult.success) {
            console.warn(`Promo image failed to send to ${from}, continuing without it.`);
            await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${SEND_REJECTED_ERROR}`);
          }
        }
      }
    } catch (err) {
      console.error("Error handling incoming message:", err);
      try {
        await whatsapp.sendMessage(
          from,
          "Sorry, something went wrong on our end — a team member will follow up with you shortly!"
        );
      } catch (sendErr) {
        console.error("Also failed to send fallback message:", sendErr);
      }
    }
  }
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
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
