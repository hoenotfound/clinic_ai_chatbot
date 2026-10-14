"use strict";

const { acceptedNormalOutboundSql } = require("./normalOutboundProofSql");

function checkedAlias(alias) {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) {
    throw new TypeError("Invalid delivery-attention SQL alias");
  }
  return alias;
}

// A staff/AI reply must really have reached the provider. Templates, scheduled
// messages, follow-ups and pricing reminders are not evidence that a customer's
// latest question was personally answered. Use the same provider proof as the
// Inbox Unreplied filter, including genuine Business App echoes (NULL status).
function acceptedDirectReplySql(alias) {
  const m = checkedAlias(alias);
  return `(${m}.role = 'assistant'
    AND ${m}.is_automated_follow_up IS NOT TRUE
    AND ${m}.whatsapp_template IS NULL
    AND ${m}.pricing_reminder_anchor_id IS NULL
    AND ${m}.automated_follow_up_for_message_id IS NULL
    AND ${m}.automated_follow_up_parent_message_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_messages scheduled
      WHERE scheduled.message_id = ${m}.id
    )
    AND ${acceptedNormalOutboundSql(m)})`;
}

// A failed media send is its own staff task. Later text cannot prove the photo,
// voice note, video or document was sent. Keep the failed row visible until the
// exact attempt is recovered, or staff explicitly dismiss the old task.
function failedMediaSql(alias) {
  const m = checkedAlias(alias);
  return `(${m}.media_key IS NOT NULL
    OR ${m}.media_url IS NOT NULL
    OR ${m}.media_base64 IS NOT NULL
    OR ${m}.media_mime_type IS NOT NULL)`;
}

// A delivery alert is an individual task. A failed image in the latest
// customer-message episode remains actionable even if a staff text follows.
// Old photos require a direct provider-accepted reply to a *newer* customer
// turn before they stop blocking unlinked attention. Explicit delivery alerts
// never disappear through a new inbound or an unrelated text: an anchored
// alert protects its particular failed message, and a legacy alert (NULL
// anchor) stays conservative until staff dismisses it.
// 
// When an alert is anchored to a DIFFERENT failure in a newer episode, do not
// let other older failed media poison that alert after the newer send recovers.
// Historic delivery_status rows are not edited; the existing explicit staff
// dismissal timestamp remains authoritative for all messages before it.
function unresolvedFailedOutboundSql(messageAlias, contactAlias) {
  const m = checkedAlias(messageAlias);
  const c = checkedAlias(contactAlias);
  const deliveryReason = `(
    ${c}.needs_attention IS TRUE
    AND (
      ${c}.attention_reason LIKE 'Delivery failed:%'
      OR ${c}.attention_reason LIKE 'Delivery unconfirmed:%'
    )
  )`;
  return `(${m}.role = 'assistant'
    AND ${m}.delivery_status IN ('failed', 'unknown')
    AND (
      ${c}.delivery_attention_dismissed_at IS NULL
      OR ${m}.created_at > ${c}.delivery_attention_dismissed_at
    )
    AND (
      (
        ${failedMediaSql(m)}
        AND (
          -- A specifically flagged failed image remains open until retry or
          -- explicit dismissal, regardless of later customer messages.
          (
            ${deliveryReason}
            AND (
              ${c}.delivery_attention_message_id = ${m}.id
              OR ${c}.delivery_attention_message_id IS NULL
            )
          )
          OR NOT EXISTS (
            SELECT 1 FROM messages later_customer
            WHERE later_customer.contact_id = ${m}.contact_id
              AND later_customer.role = 'user'
              AND (later_customer.created_at, later_customer.id) >
                  (${m}.created_at, ${m}.id)
          )
          OR (
            -- Unlinked historical media remains relevant until someone
            -- actually answers the most recent newer customer turn. Merely
            -- receiving another customer message does not count as recovery.
            NOT ${deliveryReason}
            AND NOT EXISTS (
              SELECT 1 FROM messages reply_to_new_turn
              WHERE reply_to_new_turn.contact_id = ${m}.contact_id
                AND ${acceptedDirectReplySql("reply_to_new_turn")}
                AND (reply_to_new_turn.created_at, reply_to_new_turn.id) >
                    (${m}.created_at, ${m}.id)
                AND EXISTS (
                  SELECT 1 FROM messages newer_customer
                  WHERE newer_customer.contact_id = ${m}.contact_id
                    AND newer_customer.role = 'user'
                    AND (newer_customer.created_at, newer_customer.id) >
                        (${m}.created_at, ${m}.id)
                    AND (newer_customer.created_at, newer_customer.id) <
                        (reply_to_new_turn.created_at, reply_to_new_turn.id)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM messages unanswered_after_reply
                  WHERE unanswered_after_reply.contact_id = ${m}.contact_id
                    AND unanswered_after_reply.role = 'user'
                    AND (unanswered_after_reply.created_at, unanswered_after_reply.id) >
                        (reply_to_new_turn.created_at, reply_to_new_turn.id)
                )
            )
          )
        )
      )
      OR (
        NOT ${failedMediaSql(m)}
        AND NOT EXISTS (
          SELECT 1 FROM messages accepted_later_reply
          WHERE accepted_later_reply.contact_id = ${m}.contact_id
            AND ${acceptedDirectReplySql("accepted_later_reply")}
            AND (accepted_later_reply.created_at, accepted_later_reply.id) >
                (${m}.created_at, ${m}.id)
        )
      )
    )
  )`;
}

module.exports = {
  acceptedDirectReplySql,
  failedMediaSql,
  unresolvedFailedOutboundSql,
};
