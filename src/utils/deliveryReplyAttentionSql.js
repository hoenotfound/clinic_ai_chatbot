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

// An explicit Inbox dismissal acknowledges earlier failures without rewriting
// the provider audit. A failed attachment remains actionable throughout its
// customer-message episode: later text in the same episode cannot clear it.
// But after the customer sends a NEW message, the old attachment cannot
// interfere with routine Staff Assist for that new episode when there is no
// explicitly open delivery-failure attention reason. Keep an explicit delivery
// warning protected across episodes until staff deliberately dismisses it.
// Failed text can also be superseded by a newer provider-accepted direct reply.
// Share these rules with draft cleanup and post-send reconciliation.
function unresolvedFailedOutboundSql(messageAlias, contactAlias) {
  const m = checkedAlias(messageAlias);
  const c = checkedAlias(contactAlias);
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
          -- An already-flagged delivery task must not disappear merely
          -- because another customer message arrived.
          (
            ${c}.needs_attention IS TRUE
            AND (
              ${c}.attention_reason LIKE 'Delivery failed:%'
              OR ${c}.attention_reason LIKE 'Delivery unconfirmed:%'
            )
          )
          OR NOT EXISTS (
            SELECT 1 FROM messages later_customer
            WHERE later_customer.contact_id = ${m}.contact_id
              AND later_customer.role = 'user'
              AND (later_customer.created_at, later_customer.id) >
                  (${m}.created_at, ${m}.id)
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
