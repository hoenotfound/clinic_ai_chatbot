const { pool } = require("./db");
const {
  MAX_ATTEMPTS,
  PROCESSING_STALE_MINUTES,
} = require("./leadScoringRepo");

async function recoverStaleTerminalProcessingFailures() {
  const result = await pool.query(
    `UPDATE lead_temperature_scores
     SET status = 'failed',
         error_text = COALESCE(
           NULLIF(error_text, ''),
           'Lead scoring attempt timed out before completion.'
         ),
         updated_at = now()
     WHERE status = 'processing'
       AND attempts >= ${MAX_ATTEMPTS}
       AND updated_at <= now() - (${PROCESSING_STALE_MINUTES} * interval '1 minute')
     RETURNING id, lead_id, through_message_id, attempts`,
  );
  return result.rows;
}

module.exports = {
  recoverStaleTerminalProcessingFailures,
};
