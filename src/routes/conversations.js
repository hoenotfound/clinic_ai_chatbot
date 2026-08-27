const express = require("express");
const multer = require("multer");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const conversationStore = require("../utils/conversationStore");
const realtimeEvents = require("../utils/realtimeEvents");
const whatsapp = require("../services/whatsappService");
const { convertToWhatsAppVoice } = require("../services/audioConvertService");
const { transcribeStaffAudio } = require("../services/transcriptionService");

const router = express.Router();
const STAFF_TRANSCRIPTION_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_INCREMENTAL_PAGE_SIZE = 100;
const SSE_HEARTBEAT_MS = 25 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("audio/")) {
      return cb(new Error("Only audio recordings are allowed."));
    }
    cb(null, true);
  },
});

async function resolveWithin(promise, timeoutMs, fallbackValue) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallbackValue),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parsePositiveInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

router.get("/", async (req, res) => {
  try {
    const conversations = await contactsRepo.listConversations();
    res.json(conversations);
  } catch (err) {
    console.error("Failed to list conversations:", err);
    res.status(500).json({ error: "Something went wrong loading conversations." });
  }
});

// Authenticated server-sent event stream for the Inbox. Events contain only
// tiny contact/message identifiers; the browser then asks for lightweight
// incremental data only when something actually changed. This replaces idle
// polling without putting message or media payloads on the SSE connection.
router.get("/events", (req, res) => {
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  const removeClient = realtimeEvents.addClient(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
      removeClient();
    }
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient();
  });
});

// Portal message history is cursor-paginated. The first request returns only
// the newest 50 messages. beforeId loads older history, while afterId fetches
// only messages newer than the browser's current cursor.
router.get("/:contactId/messages", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const beforeId = parsePositiveInt(req.query.beforeId);
    const afterId = parsePositiveInt(req.query.afterId);
    if (beforeId && afterId) {
      return res.status(400).json({ error: "Use beforeId or afterId, not both." });
    }

    const requestedLimit = parsePositiveInt(req.query.limit) || DEFAULT_MESSAGE_PAGE_SIZE;
    const limit = Math.min(
      requestedLimit,
      afterId ? MAX_INCREMENTAL_PAGE_SIZE : DEFAULT_MESSAGE_PAGE_SIZE
    );
    const includeMedia = req.query.includeMedia === "true";

    const page = await messagesRepo.getMessagePageForContact(contactId, {
      limit,
      beforeId,
      afterId,
      includeMedia,
    });

    res.json({
      messages: page.rows,
      hasMore: page.hasMore,
      oldestId: page.rows[0]?.id || null,
      newestId: page.rows[page.rows.length - 1]?.id || null,
    });
  } catch (err) {
    console.error("Failed to load conversation thread:", err);
    res.status(500).json({ error: "Something went wrong loading the conversation." });
  }
});

router.get("/:contactId/messages/:messageId/media", async (req, res) => {
  try {
    const media = await messagesRepo.getMessageMediaForContact(
      req.params.contactId,
      req.params.messageId
    );
    if (!media) return res.status(404).json({ error: "Message attachment not found." });

    const buffer = Buffer.from(media.media_base64, "base64");
    const mimeType = media.media_mime_type || "application/octet-stream";
    const range = req.headers.range;

    res.set({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600, immutable",
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    });

    if (!range) {
      res.set("Content-Length", String(buffer.length));
      return res.send(buffer);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.set("Content-Range", `bytes */${buffer.length}`);
      return res.sendStatus(416);
    }

    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(buffer.length - suffixLength, 0);
      end = buffer.length - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : buffer.length - 1;
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= buffer.length
    ) {
      res.set("Content-Range", `bytes */${buffer.length}`);
      return res.sendStatus(416);
    }

    end = Math.min(end, buffer.length - 1);
    const chunk = buffer.subarray(start, end + 1);
    res.status(206).set({
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
    });
    return res.send(chunk);
  } catch (err) {
    console.error("Failed to load message attachment:", err);
    res.status(500).json({ error: "Something went wrong loading this attachment." });
  }
});

router.post("/:contactId/takeover", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const updated = await contactsRepo.takeOver(contact.id, req.session.username);
    res.json(updated);
  } catch (err) {
    console.error("Failed to take over conversation:", err);
    res.status(500).json({ error: "Something went wrong taking over this conversation." });
  }
});

router.post("/:contactId/return-to-ai", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const updated = await contactsRepo.returnToAi(contact.id);
    res.json(updated);
  } catch (err) {
    console.error("Failed to return conversation to AI:", err);
    res.status(500).json({ error: "Something went wrong returning this conversation to the AI." });
  }
});

router.patch("/:contactId/attention", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { needsAttention, reason } = req.body || {};
    if (typeof needsAttention !== "boolean") {
      return res.status(400).json({ error: "needsAttention (boolean) is required." });
    }

    const updated = await contactsRepo.setAttention(
      contact.id,
      needsAttention,
      needsAttention ? reason || "Flagged by staff." : null
    );
    res.json(updated);
  } catch (err) {
    console.error("Failed to update attention flag:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

router.post("/:contactId/messages", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message text is required." });
    }

    if (contact.mode !== "human") {
      await contactsRepo.takeOver(contact.id, req.session.username);
    } else {
      await contactsRepo.setAttention(contact.id, false);
    }

    const saved = await conversationStore.appendMessage(
      contact.whatsapp_number,
      "assistant",
      text.trim(),
      null,
      req.session.username
    );

    const { success: delivered, wamid } = await whatsapp.sendMessage(contact.whatsapp_number, text.trim());
    if (wamid) {
      await messagesRepo.setWhatsappMessageId(saved.id, wamid);
    }

    res.status(201).json({ ...saved, delivered });
  } catch (err) {
    console.error("Failed to send staff message:", err);
    res.status(500).json({ error: "Something went wrong sending this message." });
  }
});

function handleImageUpload(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image is too large. Please choose a file under 16MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload image." });
  });
}

function handleVoiceUpload(req, res, next) {
  voiceUpload.single("voice")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Voice recording is too large. Please keep it under 16MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload voice recording." });
  });
}

router.post("/:contactId/media", handleImageUpload, async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const caption = (req.body?.caption || "").trim();

    if (contact.mode !== "human") {
      await contactsRepo.takeOver(contact.id, req.session.username);
    } else {
      await contactsRepo.setAttention(contact.id, false);
    }

    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype);
    if (!mediaId) {
      return res.status(502).json({ error: "Failed to upload image to WhatsApp. Please try again." });
    }

    const { success: delivered, wamid } = await whatsapp.sendImageById(
      contact.whatsapp_number,
      mediaId,
      caption || undefined
    );

    const saved = await conversationStore.appendMessage(
      contact.whatsapp_number,
      "assistant",
      caption,
      null,
      req.session.username,
      null,
      { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") }
    );
    if (wamid) {
      await messagesRepo.setWhatsappMessageId(saved.id, wamid);
    }

    res.status(201).json({ ...saved, delivered });
  } catch (err) {
    console.error("Failed to send staff image:", err);
    res.status(500).json({ error: "Something went wrong sending this image." });
  }
});

router.post("/:contactId/voice", handleVoiceUpload, async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    if (contact.mode !== "human") {
      return res.status(409).json({ error: "Take over this conversation before sending a voice message." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "A voice recording is required." });
    }

    const converted = await convertToWhatsAppVoice(req.file.buffer, req.file.mimetype);

    if (!converted) {
      return res.status(422).json({ error: "Couldn't process that recording. Please record it again." });
    }

    const transcript = await resolveWithin(
      transcribeStaffAudio(converted.whatsapp.buffer, converted.whatsapp.mimeType),
      STAFF_TRANSCRIPTION_TIMEOUT_MS,
      null
    );

    let currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact || currentContact.mode !== "human") {
      return res.status(409).json({ error: "This conversation is no longer in Staff mode." });
    }

    const mediaId = await whatsapp.uploadMedia(
      converted.whatsapp.buffer,
      converted.whatsapp.mimeType,
      converted.whatsapp.filename
    );
    if (!mediaId) {
      return res.status(502).json({ error: "Failed to upload voice message to WhatsApp. Please try again." });
    }

    currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact || currentContact.mode !== "human") {
      return res.status(409).json({ error: "This conversation is no longer in Staff mode." });
    }

    const content = transcript ? `🎤 ${transcript}` : "🎤 Staff sent a voice message";
    const saved = await conversationStore.appendMessage(
      currentContact.whatsapp_number,
      "assistant",
      content,
      null,
      req.session.username,
      null,
      {
        mimeType: converted.playback.mimeType,
        data: converted.playback.buffer.toString("base64"),
      }
    );

    const { success: delivered, wamid } = await whatsapp.sendVoiceById(currentContact.whatsapp_number, mediaId);
    if (wamid) {
      await messagesRepo.setWhatsappMessageId(saved.id, wamid);
    }
    try {
      await contactsRepo.setAttention(
        currentContact.id,
        !delivered,
        delivered ? null : "Staff voice message failed to deliver. Please resend it."
      );
    } catch (attentionErr) {
      console.error("Failed to update attention after staff voice message:", attentionErr);
    }

    res.status(201).json({
      ...saved,
      delivered,
      transcribed: !!transcript,
    });
  } catch (err) {
    console.error("Failed to send staff voice message:", err);
    res.status(500).json({ error: "Something went wrong sending this voice message." });
  }
});

module.exports = router;
