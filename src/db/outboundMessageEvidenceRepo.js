const { pool } = require("./db");

const ALLOWED_CHANNELS = new Set(["whatsapp", "facebook", "instagram"]);
const ALLOWED_ORIGINS = new Set(["ai_reply", "system_fallback"]);

async function recordOutcome({
  messageId,
  contactId,
  channel,
  origin,
  accepted,
  providerMessageId = null,
  attemptedAt = new Date(),
} = {}, queryable = pool) {
  const safeMessageId = Number(messageId);
  const safeContactId = Number(contactId);
  const safeChannel = String(channel || "").trim().toLowerCase();
  const safeOrigin = String(origin || "").trim().toLowerCase();
  const safeProviderMessageId = providerMessageId == null
    ? null
    : String(providerMessageId).trim() || null;
  const wasAccepted = accepted === true;

  if (!Number.isSafeInteger(safeMessageId) || safeMessageId < 1) {
    throw new TypeError("Outbound evidence requires a positive messageId.");
  }
  if (!Number.isSafeInteger(safeContactId) || safeContactId < 1) {
    throw new TypeError("Outbound evidence requires a positive contactId.");
  }
  if (!ALLOWED_CHANNELS.has(safeChannel)) {
    throw new TypeError(`Unsupported outbound evidence channel "${channel || ""}".`);
  }
  if (!ALLOWED_ORIGINS.has(safeOrigin)) {
    throw new TypeError(`Unsupported outbound evidence origin "${origin || ""}".`);
  }
  if (wasAccepted && !safeProviderMessageId) {
    throw new TypeError("Accepted outbound evidence requires a provider message ID.");
  }

  const result = await queryable.query(
    `INSERT INTO outbound_message_evidence (
       message_id,
       contact_id,
       channel,
       origin,
       accepted,
       provider_message_id,
       attempted_at,
       accepted_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 THEN $7 ELSE NULL END, NOW())
     ON CONFLICT (message_id) DO UPDATE SET
       contact_id = EXCLUDED.contact_id,
       channel = EXCLUDED.channel,
       origin = EXCLUDED.origin,
       accepted = EXCLUDED.accepted,
       provider_message_id = EXCLUDED.provider_message_id,
       attempted_at = EXCLUDED.attempted_at,
       accepted_at = EXCLUDED.accepted_at,
       updated_at = NOW()
     RETURNING message_id, contact_id, channel, origin, accepted,
               provider_message_id, attempted_at, accepted_at`,
    [
      safeMessageId,
      safeContactId,
      safeChannel,
      safeOrigin,
      wasAccepted,
      safeProviderMessageId,
      attemptedAt,
    ]
  );
  return result.rows[0] || null;
}

module.exports = {
  ALLOWED_CHANNELS,
  ALLOWED_ORIGINS,
  recordOutcome,
};
