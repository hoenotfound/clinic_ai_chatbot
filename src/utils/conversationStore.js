/**
 * Same getHistory/appendMessage interface as the old in-memory version,
 * but now backed by Postgres — so conversation history survives restarts
 * and the management portal can read the exact same data.
 */

const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const realtimeEvents = require("./realtimeEvents");

const MAX_MESSAGES_FOR_AI_CONTEXT = 20; // bounds prompt size/cost, not what's shown in the portal
const MAX_PHOTOS_IN_AI_CONTEXT = 1;

async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  const rows = await messagesRepo.getMessagesForContact(contact.id, MAX_MESSAGES_FOR_AI_CONTEXT, false);

  const isPhotoRow = (r) => r.has_media_attachment && r.media_mime_type?.startsWith("image/");
  const photoIndices = [];
  for (let i = rows.length - 1; i >= 0 && photoIndices.length < MAX_PHOTOS_IN_AI_CONTEXT; i--) {
    if (isPhotoRow(rows[i])) photoIndices.push(i);
  }

  const photoMedia = new Map();
  for (const i of photoIndices) {
    const media = await messagesRepo.getMessageMediaForContact(contact.id, rows[i].id);
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
  const saved = await messagesRepo.saveMessage(
    contact.id,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null
  );

  realtimeEvents.publish("conversation_changed", {
    contactId: contact.id,
    messageId: saved.id,
    reason: "message",
  });

  return saved;
}

module.exports = { getHistory, appendMessage };
