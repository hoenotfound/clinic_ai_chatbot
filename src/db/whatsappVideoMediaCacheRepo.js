"use strict";
const { pool } = require("./db");

const METRIC_COLUMNS = Object.freeze({
  hit: "cache_hits",
  miss: "cache_misses",
  upload: "uploads",
  fallback: "fallbacks",
  invalid: "invalid_ids",
  recovered: "recovered_sends",
});

function createRepository(database = pool) {
  async function get(phoneNumberId, fingerprint) {
    const result = await database.query(
      "SELECT media_id FROM whatsapp_video_media_cache " +
      "WHERE phone_number_id=$1 AND content_fingerprint=$2 " +
      "AND media_id IS NOT NULL AND expires_at > NOW()",
      [phoneNumberId, fingerprint]
    );
    return result.rows[0]?.media_id || null;
  }

  // DB-leased per-phone, per-content claim. No connection remains checked out
  // during the R2 transfer or Meta upload. Stale uploads cannot overwrite winners.
  async function claim(phoneNumberId, fingerprint, mimeType, claimId) {
    const sql = [
      "INSERT INTO whatsapp_video_media_cache",
      "(phone_number_id,content_fingerprint,mime_type,upload_claim,upload_claim_expires_at)",
      "VALUES ($1,$2,$3,$4,NOW() + INTERVAL '35 seconds')",
      "ON CONFLICT (phone_number_id,content_fingerprint) DO UPDATE SET",
      "mime_type=EXCLUDED.mime_type,upload_claim=EXCLUDED.upload_claim,",
      "upload_claim_expires_at=EXCLUDED.upload_claim_expires_at,updated_at=NOW()",
      "WHERE (whatsapp_video_media_cache.media_id IS NULL",
      "OR whatsapp_video_media_cache.expires_at <= NOW())",
      "AND (whatsapp_video_media_cache.upload_claim IS NULL",
      "OR whatsapp_video_media_cache.upload_claim_expires_at <= NOW())",
      "RETURNING upload_claim"
    ].join(" ");
    const result = await database.query(sql, [phoneNumberId, fingerprint, mimeType, claimId]);
    return result.rows[0]?.upload_claim === claimId;
  }

  async function save(phoneNumberId, fingerprint, claimId, mediaId) {
    const result = await database.query(
      "UPDATE whatsapp_video_media_cache SET media_id=$4, " +
      "expires_at=NOW() + INTERVAL '25 days',upload_claim=NULL, " +
      "upload_claim_expires_at=NULL,updated_at=NOW() " +
      "WHERE phone_number_id=$1 AND content_fingerprint=$2 AND upload_claim=$3 " +
      "AND upload_claim_expires_at > NOW()",
      [phoneNumberId, fingerprint, claimId, mediaId]
    );
    return result.rowCount === 1;
  }

  async function release(phoneNumberId, fingerprint, claimId) {
    await database.query(
      "UPDATE whatsapp_video_media_cache SET upload_claim=NULL, " +
      "upload_claim_expires_at=NULL,updated_at=NOW() " +
      "WHERE phone_number_id=$1 AND content_fingerprint=$2 AND upload_claim=$3",
      [phoneNumberId, fingerprint, claimId]
    );
  }

  async function invalidate(phoneNumberId, fingerprint, mediaId) {
    const result = await database.query(
      "UPDATE whatsapp_video_media_cache SET media_id=NULL,expires_at=NULL, " +
      "updated_at=NOW() WHERE phone_number_id=$1 AND content_fingerprint=$2 " +
      "AND media_id=$3",
      [phoneNumberId, fingerprint, mediaId]
    );
    return result.rowCount === 1;
  }

  // Aggregated, privacy-safe events. Never log object keys, recipients, signed URLs or media IDs.
  async function recordEvent(phoneNumberId, event, bytes = 0) {
    const column = METRIC_COLUMNS[event];
    if (!column) return false;
    const safeBytes = event === "hit" && Number.isFinite(bytes) && bytes > 0
      ? Math.floor(bytes) : 0;
    await database.query(
      "INSERT INTO whatsapp_video_media_cache_daily_stats " +
      "(event_day, phone_number_id, " + column + ", upload_bytes_avoided) " +
      "VALUES ((NOW() AT TIME ZONE 'UTC')::date, $1, 1, $2) " +
      "ON CONFLICT (event_day, phone_number_id) DO UPDATE SET " +
      column + "=whatsapp_video_media_cache_daily_stats." + column + "+1, " +
      "upload_bytes_avoided=whatsapp_video_media_cache_daily_stats.upload_bytes_avoided " +
      "+EXCLUDED.upload_bytes_avoided",
      [phoneNumberId, safeBytes]
    );
    return true;
  }
  return { get, claim, save, release, invalidate, recordEvent };
}

module.exports = { ...createRepository(), createRepository };
