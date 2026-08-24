require("dotenv").config();
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const ai = require("./services/aiService");
const conversationStore = require("./utils/conversationStore");
const { getActivePromotion } = require("./utils/activePromotion");
const clinicConfig = require("./config/clinicConfig");
const messagesRepo = require("./db/messagesRepo");
const contactsRepo = require("./db/contactsRepo");
const { checkKeywordTriggers, extractHandoffSignal } = require("./utils/attentionTriggers");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const { bootstrapAdminUser } = require("./db/bootstrapAdmin");
const { initSchema } = require("./db/db");

const app = express();

const PORT = process.env.PORT || 3000;

// ── WhatsApp webhook: needs the raw body for signature verification, so it
// gets its own JSON parser instance separate from the portal API's. ──
const webhookJsonParser = bodyParser.json({ verify: verifyWebhookSignature });

// ── Portal API: normal JSON parsing + signed session cookie for staff login. ──
app.use("/api", bodyParser.json());
app.use(
  "/api",
  cookieSession({
    name: "session",
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me",
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

  const incomingMessages = whatsapp.parseIncomingMessages(req.body);

  for (const incoming of incomingMessages) {
    const { id, from, text, unsupportedType } = incoming;

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
          "Sorry, I can only read text messages for now — could you type that out for me? 🙂"
        );
        continue;
      }

      console.log(`Incoming from ${from}: ${text}`);

      // Fetch (or create) the contact first — we need its current mode
      // before deciding whether the AI should even respond.
      const contact = await contactsRepo.getOrCreateContact(from);

      // Save the patient's message first, independent of whether the AI
      // reply succeeds — so it always shows in the inbox, even on failure.
      await conversationStore.appendMessage(from, "user", text, id);

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

      await conversationStore.appendMessage(from, "assistant", reply);

      await whatsapp.sendMessage(from, reply);
      console.log(`Replied to ${from}: ${reply}`);

      // Promo graphic — first message only, code-triggered (see comment above
      // for why this can't be left to the AI to decide). Sent AFTER the text
      // reply so the patient's actual question gets answered first and the
      // image reinforces it, not the other way round.
      if (isFirstMessage) {
        const promo = getActivePromotion(clinicConfig.promotions);
        if (promo) {
          const sent = await whatsapp.sendImage(from, promo.imageUrl, promo.caption);
          // Never throw on a failed promo image — the text reply already
          // succeeded and that's what actually matters to the patient.
          if (!sent) {
            console.warn(`Promo image failed to send to ${from}, continuing without it.`);
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

// ── Management portal API ──
app.use("/api/auth", authRoutes);
app.use("/api/conversations", requireAuth, conversationsRoutes);

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

  // Creates a first staff login from ADMIN_USERNAME/ADMIN_PASSWORD env vars,
  // but only if no staff logins exist yet. Needed for hosts without shell
  // access (e.g. Render's free tier) — see src/db/bootstrapAdmin.js.
  await bootstrapAdminUser();

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
