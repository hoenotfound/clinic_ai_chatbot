"use strict";

// Store only an opaque event digest and business-side metadata. Never persist
// raw customer messages, phone numbers, access tokens or webhook bodies.
const { pool } = require("./db");

async function recordQuarantinedWhatsAppChanges(quarantined) {
  if (!Array.isArray(quarantined) || !quarantined.length) return 0;
  for (const item of quarantined) {
    await pool.query(
      `INSERT INTO whatsapp_sender_quarantined_events
         (fingerprint, reason, event_field, meta_account_id, meta_phone_number_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fingerprint) DO UPDATE SET
         last_seen_at = now(),
         seen_count = whatsapp_sender_quarantined_events.seen_count + 1`,
      [
        item.fingerprint,
        item.reason,
        item.field,
        item.accountId,
        item.phoneNumberId,
      ]
    );
  }
  return quarantined.length;
}

module.exports = { recordQuarantinedWhatsAppChanges };
