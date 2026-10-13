"use strict";
const { pool } = require("./db");

async function get(phoneNumberId, fingerprint) {
  const result = await pool.query(
    "SELECT media_id FROM whatsapp_video_media_cache " +
    "WHERE phone_number_id=$1 AND content_fingerprint=$2 " +
    "AND media_id IS NOT NULL AND expires_at > NOW()",
    [phoneNumberId, fingerprint]
  );
  return result.rows[0]?.media_id || null;
}

// One short database claim prevents duplicate uploads across Render instances.
// Never hold a pooled DB connection while transferring bytes to Meta.
async function claim(phoneNumberId, fingerprint, mimeType, claimId) {
  const sql = [
    "INSERT INTO whatsapp_video_media_cache",
    "(phone_number_id,content_fingerprint,mime_type,upload_claim,upload_claim_expires_at)",
    "VALUES ($1,$2,$3,$4,NOW() + INTERVAL '90 seconds')",
    "ON CONFLICT (phone_number_id,content_fingerprint) DO UPDATE SET",
    "mime_type=EXCLUDED.mime_type,upload_claim=EXCLUDED.upload_claim,",
    "upload_claim_expires_at=EXCLUDED.upload_claim_expires_at,updated_at=NOW()",
    "WHERE (whatsapp_video_media_cache.media_id IS NULL",
    "OR whatsapp_video_media_cache.expires_at <= NOW())",
    "AND (whatsapp_video_media_cache.upload_claim IS NULL",
    "OR whatsapp_video_media_cache.upload_claim_expires_at <= NOW())",
    "RETURNING upload_claim"
  ].join(" ");
  const result = await pool.query(sql, [phoneNumberId, fingerprint, mimeType, claimId]);
  return result.rows[0]?.upload_claim === claimId;
}

async function save(phoneNumberId, fingerprint, claimId, mediaId) {
  // Refresh conservatively before Meta's normal 30-day uploaded-media lifetime.
  const result = await pool.query(
    "UPDATE whatsapp_video_media_cache SET media_id=$4, " +
    "expires_at=NOW() + INTERVAL '25 days',upload_claim=NULL, " +
    "upload_claim_expires_at=NULL,updated_at=NOW() " +
    "WHERE phone_number_id=$1 AND content_fingerprint=$2 AND upload_claim=$3",
    [phoneNumberId, fingerprint, claimId, mediaId]
  );
  return result.rowCount === 1;
}

async function release(phoneNumberId, fingerprint, claimId) {
  await pool.query(
    "UPDATE whatsapp_video_media_cache SET upload_claim=NULL, " +
    "upload_claim_expires_at=NULL,updated_at=NOW() " +
    "WHERE phone_number_id=$1 AND content_fingerprint=$2 AND upload_claim=$3",
    [phoneNumberId, fingerprint, claimId]
  );
}

async function invalidate(phoneNumberId, fingerprint, mediaId) {
  await pool.query(
    "UPDATE whatsapp_video_media_cache SET media_id=NULL,expires_at=NULL, " +
    "updated_at=NOW() WHERE phone_number_id=$1 AND content_fingerprint=$2 " +
    "AND media_id=$3",
    [phoneNumberId, fingerprint, mediaId]
  );
}

module.exports = { get, claim, save, release, invalidate };
