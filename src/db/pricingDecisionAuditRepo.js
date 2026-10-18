"use strict";
const { pool } = require("./db");

// Durable, staff-only stage summary. Optional sales-media diagnostics must
// never cause a paid-treatment reply to be retried or affect a provider send.
async function recordDecision({
  contactId, inboundMessageId, mode, observed, approved,
  treatment = null, decisionSource = null, replyStatus,
  mediaStatus, mediaReason = null, mediaPackagesSelected = 0,
}, query = pool.query.bind(pool)) {
  if (!Number.isSafeInteger(Number(contactId)) || Number(contactId) <= 0 ||
      !Number.isSafeInteger(Number(inboundMessageId)) || Number(inboundMessageId) <= 0 ||
      !["off","shadow","enabled"].includes(mode) ||
      !["selected","skipped"].includes(mediaStatus) ||
      !Number.isSafeInteger(mediaPackagesSelected) || mediaPackagesSelected < 0 ||
      mediaPackagesSelected > 3 || !replyStatus) {
    throw new Error("Invalid pricing audit stage");
  }
  await query(
    `INSERT INTO pricing_decision_audit (
      contact_id, inbound_message_id, mode, observed, approved,
      treatment, decision_source, reply_status,
      media_status, media_reason, media_packages_selected
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (inbound_message_id) DO UPDATE SET
      observed = EXCLUDED.observed,
      approved = EXCLUDED.approved,
      treatment = EXCLUDED.treatment,
      decision_source = EXCLUDED.decision_source,
      reply_status = EXCLUDED.reply_status,
      media_status = EXCLUDED.media_status,
      media_reason = EXCLUDED.media_reason,
      media_packages_selected = EXCLUDED.media_packages_selected,
      updated_at = now()`,
    [contactId,inboundMessageId,mode,observed===true,approved===true,
      treatment,decisionSource,replyStatus,mediaStatus,mediaReason,mediaPackagesSelected]
  );
}
module.exports = { recordDecision };
