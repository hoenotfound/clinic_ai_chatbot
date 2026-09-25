const { pool } = require("./db");

function text(value, max = 1000) {
  const cleaned = String(value || "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

async function recordValidated({
  wabaId,
  phoneNumberId,
  displayPhoneNumber = null,
  verifiedName = null,
  coexistenceReady = false,
  eventVersion = null,
  tokenExpiresAt = null,
  startedBy = null,
} = {}) {
  const result = await pool.query(
    `INSERT INTO whatsapp_coexistence_onboarding_attempts (
       status, waba_id, phone_number_id, display_phone_number, verified_name,
       coexistence_ready, event_version, token_expires_at, started_by
     )
     VALUES ('validated', $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      text(wabaId, 128),
      text(phoneNumberId, 128),
      text(displayPhoneNumber, 128),
      text(verifiedName, 256),
      coexistenceReady === true,
      Number.isInteger(Number(eventVersion)) ? Number(eventVersion) : null,
      tokenExpiresAt || null,
      text(startedBy, 128),
    ]
  );
  return result.rows[0] || null;
}

async function recordFailed({
  wabaId = null,
  eventVersion = null,
  errorCode = null,
  errorMessage = null,
  startedBy = null,
} = {}) {
  const result = await pool.query(
    `INSERT INTO whatsapp_coexistence_onboarding_attempts (
       status, waba_id, event_version, error_code, error_message, started_by
     )
     VALUES ('failed', $1, $2, $3, $4, $5)
     RETURNING *`,
    [
      text(wabaId, 128),
      Number.isInteger(Number(eventVersion)) ? Number(eventVersion) : null,
      text(errorCode, 128),
      text(errorMessage, 1000),
      text(startedBy, 128),
    ]
  );
  return result.rows[0] || null;
}

async function getLatest() {
  const result = await pool.query(
    `SELECT id, status, waba_id, phone_number_id, display_phone_number,
            verified_name, coexistence_ready, event_version, token_expires_at,
            error_code, error_message, started_by, created_at
     FROM whatsapp_coexistence_onboarding_attempts
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

module.exports = {
  getLatest,
  recordFailed,
  recordValidated,
};
