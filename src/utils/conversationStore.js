/**
 * Same getHistory/appendMessage interface as the old in-memory version,
 * but now backed by Postgres — so conversation history survives restarts
 * and the management portal can read the exact same data.
 */

const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");

const MAX_MESSAGES_FOR_AI_CONTEXT = 20; // bounds prompt size/cost, not what's shown in the portal

/**
 * @param {string} waId - patient's WhatsApp number
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string|Array<object>}>>}
 *   content is a plain string for ordinary messages; for a patient photo it's
 *   an array of generic parts ([{type:'text',...}, {type:'image',...}]) that
 *   aiService/geminiService/claudeService already know how to read — see
 *   transcriptionService.js and the AI services for the other side of this.
 */
async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  const rows = await messagesRepo.getMessagesForContact(contact.id, MAX_MESSAGES_FOR_AI_CONTEXT);
  return rows.map((r) => {
    if (!r.media_base64) return { role: r.role, content: r.content };
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
