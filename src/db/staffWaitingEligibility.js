"use strict";

// Keep human-owned work eligible until a valid staff reply. In AI mode,
// actionable needs_attention means staff still owes a resolution even if the
// AI sends an acknowledgement. Administrative CRM audits are different: they
// cannot turn pre-audit customer messages into new staff-waiting episodes.
function staffWaitingOwnershipSql(waitingAlias) {
  if (!["latest_waiting", "waiting_message"].includes(waitingAlias)) {
    throw new TypeError("Invalid staff-waiting customer-message SQL alias");
  }
  return `(
    c.mode = 'human'
    OR (
      c.mode = 'ai'
      AND c.needs_attention = true
      AND COALESCE(c.attention_reason, '') NOT LIKE 'AI review requested:%'
      AND (
        COALESCE(c.attention_reason, '') NOT ILIKE 'Historical %'
        OR (
          -- A historical CRM review is an admin task. Suppress only
          -- pre-review customer-message episodes, not any new enquiries.
          -- Use the immutable audit note, never contacts.updated_at (which
          -- changes when later customer messages arrive).
          NOT EXISTS (
            SELECT 1 FROM contact_notes admin_review
            WHERE admin_review.contact_id = c.id
              AND admin_review.author = 'System audit'
              AND admin_review.content ILIKE 'Historical booking%'
              AND admin_review.created_at >= ${waitingAlias}.created_at
          )
          -- A subsequent customer enquiry handled by the AI is not a fresh
          -- staff request merely because the old CRM flag remains active.
          AND NOT EXISTS (
            SELECT 1 FROM messages ai_answer
            WHERE ai_answer.contact_id = c.id
              AND ai_answer.role = 'assistant'
              AND ai_answer.sent_by_username IS NULL
              AND ai_answer.is_automated_follow_up = false
              AND (
                ai_answer.delivery_status IS NULL
                OR ai_answer.delivery_status NOT IN ('failed', 'unknown')
              )
              AND (ai_answer.created_at, ai_answer.id) >
                  (${waitingAlias}.created_at, ${waitingAlias}.id)
          )
        )
      )
    )
  )`;
}

module.exports = {
  staffWaitingOwnershipSql,
};
