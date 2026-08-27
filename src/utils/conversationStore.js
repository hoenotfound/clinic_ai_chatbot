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
 *   content is a plain string for ordinary messages (including voice notes —
 *   the transcript text already has the audio's content, so raw audio bytes
 *   are never re-attached for the AI, only for the Inbox player — see
 *   messagesRepo.js). For the most recent photo/photos (see
 *   MAX_PHOTOS_IN_AI_CONTEXT) content is instead an array of generic parts
 *   ([{type:'text',...}, {type:'image',...}]) that aiService/geminiService/
 *   claudeService already know how to read.
 *
 *   IMPORTANT (network transfer): the bulk history query below is fetched
 *   with includeMedia=false — metadata only (has_media_attachment,
 *   media_mime_type), no base64 bytes. Actual image bytes are then fetched
 *   with a second, targeted query, and only for the specific row(s) picked
 *   out below. Previously this was a single includeMedia=true query that
 *   pulled every stored photo AND voice-note recording (as base64) for the
 *   whole history window on every single inbound message — even though at
 *   most one photo was ever actually used, and voice-note audio was never
 *   used at all (the transcript in `content` already has that). That meant
 *   re-transferring the same media out of Postgres on every turn of every
 *   conversation for bytes that were immediately discarded.
 */
async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  const rows = await messagesRepo.getMessagesForContact(contact.id, MAX_MESSAGES_FOR_AI_CONTEXT, false);

  const isPhotoRow = (r) => r.has_media_attachment && r.media_mime_type?.startsWith("image/");

  // Indices (within `rows`, chronological order) of the last N photo
  // messages — only these get the actual image bytes fetched/attached below.
  const photoIndices = [];
  for (let i = rows.length - 1; i >= 0 && photoIndices.length < MAX_PHOTOS_IN_AI_CONTEXT; i--) {
    if (isPhotoRow(rows[i])) photoIndices.push(i);
  }

  // Only now, for those specific row(s), fetch the actual bytes — a
  // targeted lookup by id rather than part of the bulk history query, so we
  // transfer exactly what's about to be used and nothing else.
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

/**
 * @param {string} waId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {string|null} whatsappMessageId - only set for inbound patient messages
 * @param {string|null} sentByUsername - only set for outbound messages a staff member typed themselves
 * @param {string|null} mediaUrl - only set for image messages *we* send by public link (e.g. the promo graphic)
 * @param {{mimeType: string, data: string}|null} mediaAttachment - only set for a photo
 *   or voice note a *patient* sent us (mimeType tells getHistory which one it is)
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
