require("dotenv").config();
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const ai = require("./services/aiService");
const conversationStore = require("./utils/conversationStore");
const messagesRepo = require("./db/messagesRepo");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");

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
    if (messagesRepo.messageExistsByWhatsappId(id)) {
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

      // Save the patient's message first, independent of whether the AI
      // reply succeeds — so it always shows in the inbox, even on failure.
      conversationStore.appendMessage(from, "user", text, id);

      const history = conversationStore.getHistory(from); // now includes the message just saved
      const reply = await ai.getReply(history);

      conversationStore.appendMessage(from, "assistant", reply);

      await whatsapp.sendMessage(from, reply);
      console.log(`Replied to ${from}: ${reply}`);
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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
