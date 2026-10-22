"use strict";

const { pool } = require("./db");
const { normalizeWhatsappNumber } = require("../utils/whatsappPhoneNormalization");

function digits(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]+$/.test(text)) throw new Error(label + " must be numeric.");
  return text;
}
function customerId(value) {
  if (typeof value !== "string" || !/^[+\d\s().-]+$/.test(value)) {
    throw new Error("Invalid WhatsApp customer number.");
  }
  const normalized = normalizeWhatsappNumber(value);
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new Error("Invalid WhatsApp customer number.");
  }
  return normalized;
}
function positiveId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("A positive integer ID is required.");
  }
  return number;
}

// Pending is not an Inbox contact. Do NOT initiate AI, follow-up, billing or
// outbound work from this reservation. No fallback to the legacy number.
async function reservePendingConversation({ accountId, phoneNumberId, customerPhone }, database = pool) {
  const account = digits(accountId, "Meta WhatsApp account ID");
  const phone = digits(phoneNumberId, "Meta receiving phone ID");
  const customer = customerId(customerPhone);
  const result = await database.query(
    "INSERT INTO whatsapp_sender_conversations (sender_id, customer_wa_id) " +
    "SELECT id, $3 FROM whatsapp_sender_accounts " +
    "WHERE meta_account_id = $1 AND meta_phone_number_id = $2 " +
    "AND state IN ('testing', 'active') " +
    "ON CONFLICT (sender_id, customer_wa_id) DO UPDATE " +
    "SET updated_at = whatsapp_sender_conversations.updated_at RETURNING *",
    [account, phone, customer]
  );
  return result.rows[0] || null;
}

async function findConversationBySender({ accountId, phoneNumberId, customerPhone }, database = pool) {
  const result = await database.query(
    "SELECT sc.*, sa.sender_key, sa.display_name, sa.meta_phone_number_id, " +
    "sa.meta_account_id, sa.state AS sender_state " +
    "FROM whatsapp_sender_conversations sc " +
    "JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE sa.meta_account_id = $1 AND sa.meta_phone_number_id = $2 " +
    "AND sc.customer_wa_id = $3",
    [digits(accountId, "Meta WhatsApp account ID"),
      digits(phoneNumberId, "Meta receiving phone ID"), customerId(customerPhone)]
  );
  return result.rows[0] || null;
}

// Explicitly bind only a matching WhatsApp contact, after the verified
// legacy backfill. UNIQUE(contact_id) refuses cross-sender contact reuse.
async function bindExistingContact(conversationId, existingContactId, database = pool) {
  const result = await database.query(
    "UPDATE whatsapp_sender_conversations AS sc " +
    "SET contact_id = $2, state = 'bound', updated_at = NOW() " +
    "FROM contacts AS c " +
    "WHERE sc.id = $1 AND c.id = $2 AND c.channel = 'whatsapp' " +
    "AND regexp_replace(c.whatsapp_number, '[^0-9]', '', 'g') = sc.customer_wa_id " +
    "AND (sc.contact_id IS NULL OR sc.contact_id = c.id) RETURNING sc.*",
    [positiveId(conversationId), positiveId(existingContactId)]
  );
  return result.rows[0] || null;
}

async function senderForContact(existingContactId, database = pool) {
  const result = await database.query(
    "SELECT sc.id AS conversation_id, sc.customer_wa_id, sa.sender_key, " +
    "sa.meta_phone_number_id, sa.meta_account_id, sa.display_name, " +
    "sa.state AS sender_state FROM whatsapp_sender_conversations sc " +
    "JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE sc.contact_id = $1 AND sc.state = 'bound'",
    [positiveId(existingContactId)]
  );
  return result.rows[0] || null;
}

module.exports = {
  reservePendingConversation,
  findConversationBySender,
  bindExistingContact,
  senderForContact,
};
