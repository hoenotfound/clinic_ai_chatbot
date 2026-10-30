"use strict";

// Neutro's second WhatsApp remains manual unless the very FIRST customer
// message is a verified, new Click-to-WhatsApp ad entry after activation.
// Never promote imported contacts or older/direct chats after a later ad click.
// All consumers use the same read-only Neon evidence; no extra worker/ledger.
const { pool } = require("../db/db");

function adsOnlyActivation(env = process.env) {
  if (env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE !== "ads_only") return null;
  const raw = String(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > 0
    ? parsed.toISOString() : null;
}

// contactSql must be a trusted server-authored SQL alias. cutoffSql is a bound
// timestamp parameter, never a caller-provided SQL literal.
function adsOnlyEligibleSql(contactSql = "c", cutoffSql = "$2") {
  return `EXISTS (
    SELECT 1
    FROM whatsapp_sender_accounts ads_sa
    JOIN whatsapp_sender_conversations ads_sc
      ON ads_sc.sender_id=ads_sa.id
     AND ads_sc.contact_id=${contactSql}.id
     AND ads_sc.state='bound'
     AND ads_sc.customer_wa_id=${contactSql}.whatsapp_number
    JOIN messages ads_first
      ON ads_first.contact_id=${contactSql}.id
     AND ads_first.role='user'
     AND ads_first.whatsapp_message_id IS NOT NULL
    JOIN whatsapp_sender_message_context ads_context
      ON ads_context.message_id=ads_first.id
     AND ads_context.conversation_id=ads_sc.id
    JOIN whatsapp_free_entry_referrals ads_ref
      ON ads_ref.origin_message_id=ads_first.id
     AND ads_ref.contact_id=${contactSql}.id
     AND ads_ref.source_type='ad'
     AND (NULLIF(BTRIM(ads_ref.ctwa_clid),'') IS NOT NULL
          OR NULLIF(BTRIM(ads_ref.meta_ad_id),'') IS NOT NULL)
    WHERE ads_sa.id=${contactSql}.whatsapp_sender_id
      AND ads_sa.sender_key='neutro_secondary'
      AND ads_sa.state='active'
      AND ${contactSql}.channel='whatsapp'
      AND ${contactSql}.created_at >= ${cutoffSql}::timestamptz
      AND ads_first.created_at >= ${cutoffSql}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM messages ads_prior
        WHERE ads_prior.contact_id=${contactSql}.id
          AND (ads_prior.created_at, ads_prior.id)
              < (ads_first.created_at, ads_first.id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM whatsapp_sender_coexistence_history_messages ads_import
        JOIN messages ads_old ON ads_old.id=ads_import.message_id
        WHERE ads_old.contact_id=${contactSql}.id
      )
  )`;
}

async function isSecondaryAdsOnlyEligible(contactId, {
  database = pool, env = process.env,
} = {}) {
  const cutoff = adsOnlyActivation(env);
  const id = Number(contactId);
  if (!cutoff || !Number.isSafeInteger(id) || id <= 0 ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary") return false;
  try {
    const result = await database.query(
      `SELECT ${adsOnlyEligibleSql("c", "$2")} AS eligible
       FROM contacts c WHERE c.id=$1 AND c.channel='whatsapp'`,
      [id, cutoff]
    );
    return result.rows?.length === 1 && result.rows[0].eligible === true;
  } catch (err) {
    console.error("[secondary ads-only] Eligibility unavailable; automation blocked:", err?.message);
    return false;
  }
}

module.exports = { adsOnlyActivation, adsOnlyEligibleSql, isSecondaryAdsOnlyEligible };
