"use strict";

// An Inbox CRM audit flag is not automatically evidence of an unanswered
// customer message. Real human takeovers always retain their existing alert
// behavior; only AI-owned attention flags receive these safeguards.
const STAFF_WAITING_AI_ATTENTION_MAX_AGE_HOURS = 48;

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
      -- Historic CRM/booking audits are administrative, not customer requests.
      AND COALESCE(c.attention_reason, '') NOT ILIKE 'Historical %'
      -- Avoid cold-start alerts for abandoned, long-closed AI conversations.
      AND ${waitingAlias}.created_at >=
          now() - interval '${STAFF_WAITING_AI_ATTENTION_MAX_AGE_HOURS} hours'
      -- An actual AI response after the customer's most recent message means
      -- they are not waiting for a customer-facing answer from staff.
      -- Automated follow-ups and provider-failed messages do not count.
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
  )`;
}

module.exports = {
  STAFF_WAITING_AI_ATTENTION_MAX_AGE_HOURS,
  staffWaitingOwnershipSql,
};
