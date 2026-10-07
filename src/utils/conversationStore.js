/**
 * Same getHistory/appendMessage interface as the old in-memory version,
 * but now backed by Postgres — so conversation history survives restarts
 * and the management portal can read the exact same data.
 */

const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const staffOwnershipService = require("../services/staffOwnershipService");
const realtimeEvents = require("./realtimeEvents");

const MAX_MESSAGES_FOR_AI_CONTEXT = 20; // bounds prompt size/cost, not what's shown in the portal
const MAX_PHOTOS_IN_AI_CONTEXT = 1;

function publishMessageChange(contactId, messageId) {
  realtimeEvents.publish("conversation_changed", {
    contactId,
    messageId,
    reason: "message",
  });
}

function isStickerRow(row) {
  return /sent a sticker\]$/i.test(String(row?.content || "").trim());
}

function aiVisibleRows(rows) {
  return (rows || []).filter(
    (row) =>
      !isStickerRow(row) &&
      (
        row.role !== "assistant" ||
        row.delivery_status == null ||
        !["failed", "unknown"].includes(row.delivery_status)
      )
  );
}

async function getHistoryForContact(contactId, { throughMessageId = null } = {}) {
  let rows;
  if (throughMessageId != null) {
    const boundary = Number(throughMessageId);
    if (!Number.isSafeInteger(boundary) || boundary < 1) {
      throw new TypeError("throughMessageId must be a positive safe integer.");
    }

    // Inbound webhook payloads are now durably stored before the typing
    // debounce. A later customer message can therefore already exist in the DB
    // while the previous burst is generating its reply. Limit this AI snapshot
    // to the last message that belongs to the current burst so the model cannot
    // "see ahead" and answer the next burst twice.
    const page = await messagesRepo.getMessagePageForContact(contactId, {
      limit: MAX_MESSAGES_FOR_AI_CONTEXT,
      beforeId: boundary + 1,
      includeMedia: false,
    });
    rows = aiVisibleRows(page.rows);
  } else {
    rows = aiVisibleRows(
      await messagesRepo.getMessagesForContact(
        contactId,
        MAX_MESSAGES_FOR_AI_CONTEXT,
        false
      )
    );
  }

  const isPhotoRow = (r) =>
    r.has_media_attachment &&
    r.media_mime_type?.startsWith("image/");
  const photoIndices = [];
  for (let i = rows.length - 1; i >= 0 && photoIndices.length < MAX_PHOTOS_IN_AI_CONTEXT; i--) {
    if (isPhotoRow(rows[i])) photoIndices.push(i);
  }

  const photoMedia = new Map();
  for (const i of photoIndices) {
    const media = await messagesRepo.getMessageMediaForContact(contactId, rows[i].id);
    if (media) photoMedia.set(i, media);
  }

  return rows.map((r, i) => {
    const media = photoMedia.get(i);
    if (!media) return { role: r.role, content: r.content };
    return {
      role: r.role,
      content: [
        { type: "text", text: r.content || "" },
        { type: "image", mimeType: media.media_mime_type, data: media.media_base64 },
      ],
    };
  });
}

async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  return getHistoryForContact(contact.id);
}

async function appendMessageForContact(
  contactId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaAttachment = null,
  options = {}
) {
  // Claim a synthetic AI handoff before the staff-authored row is
  // inserted. The ownership claim also writes the durable cancellation for the
  // previous AI anchor under the same conversation advisory lock used by the
  // follow-up worker. Keeping this before save prevents the new staff row from
  // replacing the AI anchor before it can be cancelled.
  //
  // Ownership bookkeeping remains best-effort: a transient failure must not
  // prevent staff from sending the message itself.
  if (sentByUsername) {
    try {
      await staffOwnershipService.claimAiHandoffOwnership(contactId, sentByUsername);
    } catch (err) {
      console.error(`Failed to claim AI handoff for contact ${contactId}:`, err);
    }
  }

  const saved = await messagesRepo.saveMessage(
    contactId,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment?.buffer || mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null,
    {
      whatsappTemplate: options.whatsappTemplate || null,
      initialDeliveryStatus: options.initialDeliveryStatus || null,
      initialDeliveryError: options.initialDeliveryError || null,
      replyToProviderMessageId: options.replyToProviderMessageId || null,
      isForwarded: options.isForwarded === true,
      mediaKey: options.mediaKey || null,
      mediaFilename: options.mediaFilename || null,
    }
  );

  if (options.publish !== false) {
    publishMessageChange(contactId, saved.id);
  }
  return saved;
}

async function appendMessage(
  waId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaAttachment = null
) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  return appendMessageForContact(
    contact.id,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment
  );
}

async function appendInboundMessageIfNew(contactId, content, whatsappMessageId) {
  const saved = await messagesRepo.saveInboundMessageIfNew(
    contactId,
    content,
    whatsappMessageId
  );
  if (saved) publishMessageChange(contactId, saved.id);
  return saved;
}

async function attachStoredMediaForContact(
  contactId,
  messageId,
  mediaKey,
  mediaMimeType,
  { publish = true } = {}
) {
  const updated = await messagesRepo.setMessageMediaKeyById(
    messageId,
    contactId,
    mediaKey,
    mediaMimeType
  );
  if (updated && publish) {
    realtimeEvents.publish("conversation_changed", {
      contactId,
      messageId: updated.id,
      message: updated,
      reason: "message_updated",
    });
  }
  return updated;
}

async function updateInboundMessage(contactId, messageId, content, mediaAttachment = null) {
  const updated = await messagesRepo.updateInboundMessage(
    messageId,
    contactId,
    content,
    mediaAttachment?.buffer || mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null
  );
  if (updated) {
    // Include the lightweight row because an incremental `id > cursor` fetch
    // cannot see an update to a message the Inbox already loaded.
    realtimeEvents.publish("conversation_changed", {
      contactId,
      messageId: updated.id,
      message: updated,
      reason: "message_updated",
    });
  }
  return updated;
}

module.exports = {
  aiVisibleRows,
  getHistory,
  getHistoryForContact,
  appendMessage,
  appendMessageForContact,
  appendInboundMessageIfNew,
  attachStoredMediaForContact,
  updateInboundMessage,
};