"use strict";

const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { sessionLateralSql } = require("../db/whatsappFreeEntrySessionSql");

// Strict mode intentionally refuses to spend the unobservable 1,000-message
// service allowance. No Meta API provides an atomic "will be free" quote.
// The only allowed outbound path is an already-established, provider-priced
// free-entry period. Use 72h and a one-hour safety margin, even if an account
// is enrolled in the newer seven-day rollout.
const CONSERVATIVE_HOURS = 72;
const BUFFER_HOURS = 1;

function settings() {
  return clinicConfig.automatedFollowUp?.whatsappFreeOnly || {};
}

function enabled() {
  return settings().enabled === true;
}

function deny(code, message) {
  return { allowed: false, code, message };
}

function blockedResult(check) {
  return {
    success: false, wamid: null, externalMessageId: null,
    policyBlocked: true, policyCode: check.code,
    error: check.message,
    retryable: false,
  };
}

const VERIFIED_WINDOW_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM contacts c
    ${sessionLateralSql({ contactAlias: "c", ceilingParam: "$1" })}
    JOIN messages origin ON origin.id=referral.origin_message_id
      AND origin.contact_id=c.id AND origin.role='user'
    JOIN LATERAL (
      SELECT reply.id, reply.created_at, reply.whatsapp_message_id
      FROM messages reply
      WHERE reply.contact_id=c.id AND reply.role='assistant'
        AND reply.whatsapp_message_id IS NOT NULL
        AND reply.created_at>=origin.created_at
        AND reply.created_at<origin.created_at + interval '24 hours'
      ORDER BY reply.created_at, reply.id LIMIT 1
    ) first_reply ON TRUE
    JOIN whatsapp_free_entry_pricing_evidence start_bill ON
      start_bill.wamid=first_reply.whatsapp_message_id
      AND start_bill.pricing_type='free_entry_point'
      AND start_bill.billable=false
      AND start_bill.delivery_status IN ('sent','delivered','read')
    WHERE c.channel='whatsapp'
      AND regexp_replace(c.whatsapp_number, '[^0-9]', '', 'g')=$3::text
      AND (referral.ctwa_clid IS NOT NULL OR referral.meta_ad_id IS NOT NULL)
      AND $2::timestamptz >= first_reply.created_at
      AND $2::timestamptz < first_reply.created_at
            + (($1::integer - ${BUFFER_HOURS}) * interval '1 hour')
      -- If Meta has not confirmed that a previously accepted message was
      -- free, never gamble on sending another. Pricing callbacks arrive late.
      AND NOT EXISTS (
        SELECT 1
        FROM messages earlier
        LEFT JOIN whatsapp_free_entry_pricing_evidence priced
          ON priced.wamid=earlier.whatsapp_message_id
        WHERE earlier.contact_id=c.id AND earlier.role='assistant'
          AND earlier.created_at>=first_reply.created_at
          AND earlier.created_at<$2::timestamptz
          AND earlier.whatsapp_message_id IS NOT NULL
          AND (priced.wamid IS NULL OR priced.pricing_type<>'free_entry_point'
               OR priced.billable IS DISTINCT FROM false
               OR priced.delivery_status NOT IN ('sent','delivered','read'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_free_entry_followup_attempts attempt
        WHERE attempt.contact_id=c.id AND
          attempt.first_reply_message_id=first_reply.id AND
          attempt.status IN ('sending','failed','unknown')
      )
  ) AS eligible
`;

async function authorize(to, { now = new Date(), database = pool } = {}) {
  if (!enabled()) return { allowed: true };
  const mode = settings();
  const activatedAt = new Date(mode.activatedAt).getTime();
  const clock = new Date(now);
  if (!Number.isFinite(activatedAt) || !Number.isFinite(clock.getTime())) {
    return deny("zero_cost_configuration_invalid",
      "WhatsApp message blocked: Free Messaging Only configuration or clock is invalid.");
  }
  const number = String(to || "").replace(/\D/g, "");
  if (!number || number.length < 8) {
    return deny("zero_cost_recipient_unknown",
      "WhatsApp message blocked: recipient cannot be verified for free billing.");
  }
  try {
    // Account-wide brake: any billable callback since activation means the
    // observed billing rules differ from the assumptions of this mode.
    const alarm = await database.query(
      `SELECT EXISTS (
         SELECT 1 FROM whatsapp_free_entry_pricing_evidence
         WHERE billable=true AND updated_at >= $1::timestamptz
       ) AS tripped`, [new Date(activatedAt).toISOString()]
    );
    if (alarm.rows?.[0]?.tripped !== false) {
      return deny("zero_cost_billing_alarm",
        "WhatsApp message blocked: Meta reported a billable message since Free Messaging Only was enabled. Review billing evidence before resuming.");
    }
    const result = await database.query(VERIFIED_WINDOW_SQL,
      [CONSERVATIVE_HOURS, clock.toISOString(), number]);
    if (result.rows?.[0]?.eligible !== true) {
      return deny("zero_cost_unverified_free_entry",
        "WhatsApp message blocked: no active, fully priced free-entry period is proven for this contact. A 24-hour reply window or an ad click alone is not enough.");
    }
    return { allowed: true };
  } catch (err) {
    console.error("[WhatsApp free-only] Unable to verify billing eligibility:", err);
    return deny("zero_cost_database_unavailable",
      "WhatsApp message blocked: free-entry billing evidence could not be checked.");
  }
}

module.exports = { authorize, blockedResult, enabled, settings, VERIFIED_WINDOW_SQL };
