"use strict";

// Only opaque event hashes and business-side metadata are stored.
// One bounded database statement avoids serial writes ahead of patient traffic.
const { pool } = require("./db");
const MAX_EVENTS_PER_BATCH = 200;
const QUARANTINE_QUERY_TIMEOUT_MS = 1500;

async function recordQuarantinedWhatsAppChanges(quarantined, db = pool) {
  if (!Array.isArray(quarantined) || !quarantined.length) return 0;
  if (quarantined.length > MAX_EVENTS_PER_BATCH) {
    throw new Error("Too many quarantined WhatsApp changes");
  }
  // A replayed change may occur twice in one payload. PostgreSQL ON CONFLICT
  // cannot update the same target row twice within a single INSERT statement.
  const unique = [...new Map(quarantined.map(item => [item.fingerprint, item])).values()];
  const rows = unique.map(item => ({
    fingerprint: item.fingerprint,
    reason: item.reason,
    event_field: item.field,
    meta_account_id: item.accountId,
    meta_phone_number_id: item.phoneNumberId,
  }));
  await db.query({
    text: `INSERT INTO whatsapp_sender_quarantined_events
      (fingerprint, reason, event_field, meta_account_id, meta_phone_number_id)
      SELECT fingerprint, reason, event_field, meta_account_id, meta_phone_number_id
      FROM jsonb_to_recordset($1::jsonb)
        AS item(fingerprint text, reason text, event_field text,
                meta_account_id text, meta_phone_number_id text)
      ON CONFLICT (fingerprint) DO UPDATE SET
        last_seen_at = now(),
        seen_count = whatsapp_sender_quarantined_events.seen_count + 1`,
    values: [JSON.stringify(rows)],
    query_timeout: QUARANTINE_QUERY_TIMEOUT_MS,
  });
  return unique.length;
}

module.exports = {
  MAX_EVENTS_PER_BATCH,
  QUARANTINE_QUERY_TIMEOUT_MS,
  recordQuarantinedWhatsAppChanges,
};
