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
const SEND_REJECTED_ERROR =
  "WhatsApp did not accept this message. Check the reply window or connection and try again.";
const MAX_DELIVERY_STATUS_IDS = 500;
const retryingMessageIds = new Set();

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
  } else {
    // Extremely defensive: Meta normally returns a WAMID for every accepted
    // request. Keep the row lightweight even if an accepted response omits it.
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, null, null);
  }
  publishDeliveryStatus(updated);
  return updated || savedMessage;
}

async function sendStoredMessage(contact, message) {
  const mimeType = String(message.media_mime_type || "").toLowerCase();

  if (mimeType.startsWith("audio/")) {
    if (!message.media_base64) {
      return { success: false, wamid: null, error: "The saved voice recording is unavailable." };
    }
    const converted = await convertToWhatsAppVoice(
      Buffer.from(message.media_base64, "base64"),
      mimeType
    );
    if (!converted) {
      return { success: false, wamid: null, error: "The saved voice recording could not be processed." };
    }
    const mediaId = await whatsapp.uploadMedia(
      converted.whatsapp.buffer,
      converted.whatsapp.mimeType,
      converted.whatsapp.filename
    );
    if (!mediaId) {
      return { success: false, wamid: null, error: "The voice recording could not be uploaded to WhatsApp." };
    }
    return whatsapp.sendVoiceById(contact.whatsapp_number, mediaId);
  }

  if (mimeType.startsWith("image/") && message.media_base64) {
    const mediaId = await whatsapp.uploadMedia(
      Buffer.from(message.media_base64, "base64"),
      mimeType
    );
    if (!mediaId) {
      return { success: false, wamid: null, error: "The image could not be uploaded to WhatsApp." };
    }
    return whatsapp.sendImageById(
      contact.whatsapp_number,
      mediaId,
      message.content || undefined
    );
  }

  if (message.media_url) {
    return whatsapp.sendImage(
      contact.whatsapp_number,
      message.media_url,
      message.content || undefined
    );
  }

  if (message.content?.trim()) {
    return whatsapp.sendMessage(contact.whatsapp_number, message.content.trim());
  }

  return { success: false, wamid: null, error: "This message has no retryable content." };
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

router.patch("/:contactId/read-state", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { unread } = req.body || {};
    if (typeof unread !== "boolean") {
      return res.status(400).json({ error: "unread (boolean) is required." });
    }

    const updated = await contactsRepo.setUnread(contact.id, unread);
    res.json(updated);
  } catch (err) {
    console.error("Failed to update conversation read state:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

router.patch("/:contactId/follow-up", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { needsFollowUp } = req.body || {};
    if (typeof needsFollowUp !== "boolean") {
      return res.status(400).json({ error: "needsFollowUp (boolean) is required." });
    }

    const updated = await contactsRepo.setFollowUp(contact.id, needsFollowUp);
    res.json(updated);
  } catch (err) {
    console.error("Failed to update follow-up state:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

router.post("/:contactId/messages/delivery-statuses", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const rawMessageIds = req.body?.messageIds;
    if (!Array.isArray(rawMessageIds) || rawMessageIds.length > MAX_DELIVERY_STATUS_IDS) {
      return res.status(400).json({
        error: `messageIds must be an array of at most ${MAX_DELIVERY_STATUS_IDS} ids.`,
      });
    }

    const messageIds = rawMessageIds.map(parsePositiveInt);
    if (messageIds.some((id) => id == null)) {
      return res.status(400).json({ error: "Every message id must be a positive integer." });
    }

    const uniqueMessageIds = [...new Set(messageIds)];
    const statuses = await messagesRepo.getDeliveryStatusesForContact(contactId, uniqueMessageIds);
    res.json(statuses);
  } catch (err) {
    console.error("Failed to resync delivery statuses:", err);
    res.status(500).json({ error: "Something went wrong refreshing delivery statuses." });
  }
});

router.post("/:contactId/messages/:messageId/retry", async (req, res) => {
  const contactId = parsePositiveInt(req.params.contactId);
  const messageId = parsePositiveInt(req.params.messageId);
  if (!contactId || !messageId) {
    return res.status(400).json({ error: "Invalid contact or message id." });
  }

  const retryKey = `${contactId}:${messageId}`;
  if (retryingMessageIds.has(retryKey)) {
    return res.status(409).json({ error: "This message is already being retried." });
  }
  retryingMessageIds.add(retryKey);

  try {
    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const message = await messagesRepo.getMessageForRetry(contactId, messageId);
    if (!message) return res.status(404).json({ error: "Message not found." });
    if (message.role !== "assistant") {
      return res.status(400).json({ error: "Only outbound messages can be retried." });
    }
    if (message.delivery_status !== "failed") {
      return res.status(409).json({ error: "Only failed messages can be retried." });
    }

    const sendResult = await sendStoredMessage(contact, message);
    const errorText = sendResult.error || SEND_REJECTED_ERROR;
    const updated = await persistSendOutcome(message, sendResult, errorText);

    if (sendResult.success) {
      await contactsRepo.clearDeliveryAttentionIfNoFailedMessages(contact.id);
    } else {
      await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${errorText}`);
    }

    res.json({
      ...updated,
      accepted: !!sendResult.success,
      retry_error: sendResult.success ? null : errorText,
    });
  } catch (err) {
    console.error("Failed to retry message:", err);
    res.status(500).json({ error: "Something went wrong retrying this message." });
  } finally {
    retryingMessageIds.delete(retryKey);
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
      await contactsRepo.setUnread(contact.id, false);
    }

    const saved = await conversationStore.appendMessage(
      contact.whatsapp_number,
      "assistant",
      text.trim(),
      null,
      req.session.username
    );

    const sendResult = await whatsapp.sendMessage(contact.whatsapp_number, text.trim());
    const finalMessage = await persistSendOutcome(saved, sendResult);
    if (!sendResult.success) {
      await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${SEND_REJECTED_ERROR}`);
    }

    res.status(201).json({ ...finalMessage, delivered: sendResult.success });
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
      await contactsRepo.setUnread(contact.id, false);
    }

    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype);
    if (!mediaId) {
      return res.status(502).json({ error: "Failed to upload image to WhatsApp. Please try again." });
    }

    const sendResult = await whatsapp.sendImageById(
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
    const finalMessage = await persistSendOutcome(saved, sendResult);
    if (!sendResult.success) {
      await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${SEND_REJECTED_ERROR}`);
    }

    res.status(201).json({ ...finalMessage, delivered: sendResult.success });
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

    await contactsRepo.setUnread(contact.id, false);

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

    const sendResult = await whatsapp.sendVoiceById(currentContact.whatsapp_number, mediaId);
    const finalMessage = await persistSendOutcome(saved, sendResult);
    try {
      if (sendResult.success) {
        await contactsRepo.setAttention(currentContact.id, false);
      } else {
        await contactsRepo.setDeliveryAttention(
          currentContact.id,
          `Delivery failed: ${SEND_REJECTED_ERROR}`
        );
      }
    } catch (attentionErr) {
      console.error("Failed to update attention after staff voice message:", attentionErr);
    }

    res.status(201).json({
      ...finalMessage,
      delivered: sendResult.success,
      transcribed: !!transcript,
    });
  } catch (err) {
    console.error("Failed to send staff voice message:", err);
    res.status(500).json({ error: "Something went wrong sending this voice message." });
  }
});

module.exports = router;
