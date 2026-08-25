/**
 * Same getHistory/appendMessage interface as the old in-memory version,
 * but now backed by Postgres — so conversation history survives restarts
 * and the management portal can read the exact same data.
 */

const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");

const MAX_MESSAGES_FOR_AI_CONTEXT = 20; // bounds prompt size/cost, not what's shown in the portal

// How many of the most recent photos to re-attach as actual image data when
// building AI context. Only the latest photo(s) are re-sent on every future
// turn (each one costs real tokens/latency, repeated on every single call) —
// older photos still show up as their placeholder text (e.g. "📷 [Patient
// sent a photo]"), so the AI knows a photo was sent, just not what's in it.
const MAX_PHOTOS_IN_AI_CONTEXT = 1;

/**
 * @param {string} waId - patient's WhatsApp number
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string|Array<object>}>>}
 *   content is a plain string for ordinary messages; for the most recent
 *   photo/photos (see MAX_PHOTOS_IN_AI_CONTEXT) it's an array of generic
 *   parts ([{type:'text',...}, {type:'image',...}]) that aiService/
 *   geminiService/claudeService already know how to read — see
 *   transcriptionService.js and the AI services for the other side of this.
 */
async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  const rows = await messagesRepo.getMessagesForContact(contact.id, MAX_MESSAGES_FOR_AI_CONTEXT);

  // Indices (within `rows`, chronological order) of the last N photo
  // messages — only these get the actual image bytes attached below.
  const photoIndices = new Set();
  for (let i = rows.length - 1; i >= 0 && photoIndices.size < MAX_PHOTOS_IN_AI_CONTEXT; i--) {
    if (rows[i].media_base64) photoIndices.add(i);
  }

  return rows.map((r, i) => {
    if (!r.media_base64 || !photoIndices.has(i)) return { role: r.role, content: r.content };
    return {
      role: r.role,
      content: [
        { type: "text", text: r.content || "" },
        { type: "image", mimeType: r.media_mime_type || "image/jpeg", data: r.media_base64 },
      ],
    };
  });
}

/**
 * @param {string} waId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {string|null} whatsappMessageId - only set for inbound patient messages
 * @param {string|null} sentByUsername - only set for outbound messages a staff member typed themselves
 * @param {string|null} mediaUrl - only set for image messages *we* send by public link (e.g. the promo graphic)
 * @param {{mimeType: string, data: string}|null} mediaAttachment - only set for a photo a *patient* sent us
 * @returns {Promise<object>} the saved message row
 */
async function appendMessage(waId, role, content, whatsappMessageId = null, sentByUsername = null, mediaUrl = null, mediaAttachment = null) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  return messagesRepo.saveMessage(
    contact.id,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null
  );
}

module.exports = { getHistory, appendMessage };
