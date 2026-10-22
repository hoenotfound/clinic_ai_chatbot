"use strict";

const { pool } = require("../db/db");
const {
  blockUnverifiedOutgoingSender,
  senderMismatchResult,
} = require("./whatsappSenderOutgoingGuard");

// Always evaluate the explicit caller identity first. When sender-aware
// reads are enabled, independently verify the saved contact's sender before
// any policy reservation, media upload, template or Meta provider request.
// This catches scheduler/retry paths that reconstruct a bare {id,number}.
// Nothing is changed for legacy deployments with the read flag unset.
async function checkWhatsAppDispatchContact(contact, options = {}, {
  database = pool,
  env = process.env,
} = {}) {
  const explicit = blockUnverifiedOutgoingSender(contact, options, env);
  if (explicit) return explicit;
  if (contact?.channel && contact.channel !== "whatsapp") return null;
  if (String(env.WHATSAPP_MULTI_NUMBER_READ_ENABLED || "") !== "true") {
    return null;
  }
  const id = Number(contact?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return senderMismatchResult();
  let result;
  try {
    result = await database.query(
      "SELECT c.whatsapp_sender_id, c.whatsapp_number, " +
      "sc.id AS sender_conversation_id, sa.sender_key, " +
      "sa.meta_phone_number_id, sa.meta_account_id, sa.state AS sender_state " +
      "FROM contacts c LEFT JOIN whatsapp_sender_conversations sc " +
      "ON sc.contact_id=c.id AND sc.state='bound' " +
      "LEFT JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id " +
      "WHERE c.id=$1",
      [id]
    );
  } catch (error) {
    // Do not turn an unavailable isolation check into permission to send.
    console.error("[WhatsApp sender guard] Authoritative lookup failed:", error);
    return senderMismatchResult();
  }
  const row = result.rows?.[0];
  if (!row || String(row.whatsapp_number) !== String(contact.whatsapp_number)) {
    return senderMismatchResult();
  }
  const scoped = row.whatsapp_sender_id != null;
  if (!scoped) {
    // Legacy contact must NOT have a stray sender binding and must not accept
    // caller-provided sender fields on a normally untagged legacy contact.
    if (row.sender_conversation_id || contact.whatsapp_sender_key ||
        contact.whatsapp_sender_phone_number_id || contact.whatsapp_sender_account_id) {
      return senderMismatchResult();
    }
    return null;
  }
  if (!row.sender_conversation_id ||
      String(row.whatsapp_sender_id) === "" ||
      row.sender_state !== "active") {
    return senderMismatchResult();
  }
  return blockUnverifiedOutgoingSender({
    ...contact,
    whatsapp_sender_key: row.sender_key,
    whatsapp_sender_phone_number_id: row.meta_phone_number_id,
    whatsapp_sender_account_id: row.meta_account_id,
  }, options, env);
}

module.exports = { checkWhatsAppDispatchContact };
