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
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string}>>}
 */
async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  const rows = await messagesRepo.getMessagesForContact(contact.id, MAX_MESSAGES_FOR_AI_CONTEXT);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

/**
 * @param {string} waId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {string|null} whatsappMessageId - only set for inbound patient messages
 * @returns {Promise<void>}
 */
async function appendMessage(waId, role, content, whatsappMessageId = null) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  await messagesRepo.saveMessage(contact.id, role, content, whatsappMessageId);
}

module.exports = { getHistory, appendMessage };
