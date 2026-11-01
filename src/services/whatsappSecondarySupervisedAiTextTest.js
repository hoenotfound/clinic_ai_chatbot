"use strict";

// Temporary, fail-closed AI TEXT-only supervised test for the single contact
// the operator already verified in the Neutro secondary Inbox.
// This intentionally does NOT modify the Ads-Only SQL or any other automation
// eligibility (media, lead scoring, summaries, follow-ups, templates).
const {pool} = require("../db/db");
const CONTACT_ID = 8871;
const MAX_WINDOW_MS = 60 * 60 * 1000;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NO_OTHER_SENDS = [
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED",
  "WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED",
];

function supervisedTestWindow(env = process.env, now = new Date()) {
  if (env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE !== "test_only" ||
      env.WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_CONTACT_ID !== String(CONTACT_ID) ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID !== "1318355951360575" ||
      env.WHATSAPP_SECONDARY_WABA_ID !== "1852014482431209" ||
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED !== "true" ||
      env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED !== "true" ||
      env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED !== "true" ||
      env.WHATSAPP_COEXISTENCE_ENABLED !== "true" ||
      env.WHATSAPP_PRIMARY_SENDER_KEY !== "neutro" ||
      env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE !== "primary" ||
      env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED !== "true" ||
      env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED !== "true" ||
      NO_OTHER_SENDS.some(key => env[key] === "true")) return null;

  const start = String(env.WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_STARTS_AT || "");
  const end = String(env.WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_EXPIRES_AT || "");
  if (!UTC.test(start) || !UTC.test(end)) return null;
  const started = Date.parse(start);
  const expires = Date.parse(end);
  const current = now instanceof Date ? now.getTime() : NaN;
  if (![started, expires, current].every(Number.isFinite) ||
      expires <= started || expires - started > MAX_WINDOW_MS ||
      current < started || current >= expires) return null;
  return {started, expires};
}

// Only this one known, newly bound direct-inbound secondary contact can be a
// supervised AI text target after the explicitly owner-authorized, audited
// historical billing hold release. It must have a fresh incoming message.
// No manual insertion of an ad referral, no opt-in backfill or imported chat
// promotion is permitted. All billing/Meta provider guards remain elsewhere.
async function isSecondarySupervisedAiTextTestEligible(contactId, {
  database = pool, env = process.env, now = new Date(),
} = {}) {
  if (Number(contactId) !== CONTACT_ID ||
      !Number.isSafeInteger(Number(contactId)) ||
      !supervisedTestWindow(env, now)) return false;
  try {
    const result = await database.query(`
      SELECT EXISTS (
        SELECT 1
        FROM contacts c
        JOIN whatsapp_sender_accounts sa
          ON sa.id=c.whatsapp_sender_id AND sa.id=2
          AND sa.state='active' AND sa.sender_key='neutro_secondary'
          AND sa.meta_phone_number_id='1318355951360575'
          AND sa.meta_account_id='1852014482431209'
        JOIN whatsapp_sender_conversations sc
          ON sc.sender_id=sa.id AND sc.contact_id=c.id
          AND sc.customer_wa_id=c.whatsapp_number AND sc.state='bound'
        WHERE c.id=$1 AND c.channel='whatsapp'
          AND c.mode='ai' AND c.needs_attention=FALSE
          AND c.whatsapp_opt_out_at IS NULL
          AND c.whatsapp_marketing_opt_out_at IS NULL
          AND c.whatsapp_coexistence_imported_at IS NULL
          -- Pin the exact re-created test contact verified at 18:54 MYT.
          -- Do not authorize a subsequent re-creation or another customer.
          AND c.created_at >= '2026-11-01T10:53:00Z'::timestamptz
          AND c.created_at < '2026-11-01T10:55:00Z'::timestamptz
          -- The old UNKNOWN attempts were not reconciled or retried.
          -- The owner-exception record makes the risk explicit and durable.
          AND EXISTS (SELECT 1 FROM whatsapp_sender_owner_risk_override_audit o
            WHERE o.sender_id=sa.id AND o.owner_authorized=TRUE
              AND o.delivery_outcome='unknown' AND o.charge_outcome='unknown'
              AND o.old_message_retry_prohibited=TRUE
              AND o.possible_future_charge_accepted=TRUE)
          AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_billing_attempts attempt
            WHERE attempt.sender_id=sa.id AND attempt.contact_id=c.id)
          AND EXISTS (
            SELECT 1 FROM messages m
            JOIN whatsapp_sender_message_context mc
              ON mc.message_id=m.id AND mc.conversation_id=sc.id
            WHERE m.contact_id=c.id AND m.role='user'
              AND m.whatsapp_message_id IS NOT NULL
              AND m.created_at <= $2::timestamptz
              AND m.created_at > $2::timestamptz - INTERVAL '24 hours'
              AND NOT EXISTS (
                SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
                WHERE h.sender_id=sa.id AND h.message_id=m.id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
            JOIN messages im ON im.id=h.message_id
            WHERE h.sender_id=sa.id AND im.contact_id=c.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM contacts earlier
            WHERE earlier.id<>c.id AND earlier.channel='whatsapp'
              AND earlier.created_at<c.created_at
              AND earlier.whatsapp_number IN (
                c.whatsapp_number,
                CASE WHEN c.whatsapp_number ~ '^601[0-9]{8,9}$'
                  THEN '0' || SUBSTRING(c.whatsapp_number FROM 3)
                  ELSE NULL END
              )
              AND (earlier.whatsapp_sender_id IS NULL OR
                   EXISTS (SELECT 1 FROM whatsapp_sender_accounts primary_sa
                     WHERE primary_sa.id=earlier.whatsapp_sender_id
                       AND primary_sa.sender_key='neutro'))
          )
      ) AS eligible
    `, [CONTACT_ID, now.toISOString()]);
    return result.rows?.length===1 && result.rows[0].eligible===true;
  } catch (error) {
    console.error("[secondary supervised test] Eligibility unavailable; test AI blocked:",error?.message);
    return false;
  }
}

module.exports = {supervisedTestWindow, isSecondarySupervisedAiTextTestEligible};
