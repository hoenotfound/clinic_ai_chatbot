const { pool } = require("./db");

// Staff-only audit trail. Never expose skip reasons to customers and never
// affect the AI text reply or provider delivery if audit storage fails.
async function recordDecision({
  contactId,
  inboundMessageId,
  status,
  reason = null,
  promotionCount = 0,
  selectedCount = 0,
  sentCount = 0,
}) {
  if (!Number.isSafeInteger(Number(contactId)) || Number(contactId) <= 0 ||
      !Number.isSafeInteger(Number(inboundMessageId)) || Number(inboundMessageId) <= 0) {
    throw new Error("Result media audit requires persisted message/contact IDs");
  }
  await pool.query(
    `INSERT INTO result_media_decisions (
       contact_id, inbound_message_id, status, reason,
       promotion_images_sent, result_images_selected, result_images_sent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (inbound_message_id) DO UPDATE SET
       status = CASE
         WHEN EXCLUDED.status='deferred'
           AND result_media_decisions.status <> 'deferred'
           AND result_media_decisions.reason IS DISTINCT FROM 'awaiting_meta_free_billing'
           THEN result_media_decisions.status
         ELSE EXCLUDED.status END,
       reason = CASE
         WHEN EXCLUDED.status='deferred'
           AND result_media_decisions.status <> 'deferred'
           AND result_media_decisions.reason IS DISTINCT FROM 'awaiting_meta_free_billing'
           THEN result_media_decisions.reason
         ELSE EXCLUDED.reason END,
       promotion_images_sent = EXCLUDED.promotion_images_sent,
       result_images_selected = EXCLUDED.result_images_selected,
       result_images_sent = GREATEST(result_media_decisions.result_images_sent, EXCLUDED.result_images_sent),
       updated_at = now()`,
    [contactId, inboundMessageId, status, reason,
      promotionCount, selectedCount, sentCount]
  );
}

module.exports = { recordDecision };
