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

module.exports = { acceptedDirectReplySql, failedMediaSql };
