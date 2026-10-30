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
      AND ${contactSql}.whatsapp_coexistence_imported_at IS NULL
      -- Never silently turn an existing Neutro patient on the PRIMARY number
      -- (including legacy local 01x phone storage) into a new secondary ad lead.
      -- The other contact must predate this secondary contact: later legitimate
      -- primary activity never revokes an already-qualified secondary first ad.
      -- Exact phone lookups use the existing contact phone index.
      AND NOT EXISTS (
        SELECT 1 FROM contacts earlier_clinic_contact
        WHERE earlier_clinic_contact.id <> ${contactSql}.id
          AND earlier_clinic_contact.channel='whatsapp'
          AND earlier_clinic_contact.created_at < ${contactSql}.created_at
          AND earlier_clinic_contact.whatsapp_number IN (
            ${contactSql}.whatsapp_number,
            CASE WHEN ${contactSql}.whatsapp_number ~ '^601[0-9]{8,9}
      AND ads_first.source_created_at IS NOT NULL
      AND ads_first.source_created_at >= ${cutoffSql}::timestamptz
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


async function eligibleSecondaryAdsOnlyContactIds(ids, {
  database=pool,env=process.env,
}={}) {
  const result=new Set();
  const cutoff=adsOnlyActivation(env);
  if (!cutoff || env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
      // Avoid an indexed ad/referral scan on every Inbox refresh when
      // automated secondary replies are still disabled.
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED!=="true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED!=="true" ||
      !Array.isArray(ids) || ids.length===0)return result;
  const valid=[...new Set(ids.map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
  if (!valid.length)return result;
  try {
    // Drive the list from ad referrals, not thousands of imported contacts.
    // One indexed batch query per Inbox refresh, never one per conversation.
    const rows=await database.query(
      `SELECT DISTINCT c.id
       FROM whatsapp_free_entry_referrals ads_candidate
       JOIN contacts c ON c.id=ads_candidate.contact_id
       WHERE c.id=ANY($1::integer[])
         AND ads_candidate.recorded_at >= $2::timestamptz
         AND ${adsOnlyEligibleSql("c","$2")}`,
      [valid,cutoff]
    );
    for(const row of rows.rows||[])result.add(Number(row.id));
  }catch(err){
    console.error("[secondary ads-only] Inbox eligibility unavailable:",err?.message);
  }
  return result;
}
module.exports = { adsOnlyActivation, adsOnlyEligibleSql, isSecondaryAdsOnlyEligible,
  eligibleSecondaryAdsOnlyContactIds };

              THEN '0' || SUBSTRING(${contactSql}.whatsapp_number FROM 3)
              ELSE NULL END
          )
          AND (
            earlier_clinic_contact.whatsapp_sender_id IS NULL
            OR EXISTS (
              SELECT 1 FROM whatsapp_sender_accounts primary_sender
              WHERE primary_sender.id=earlier_clinic_contact.whatsapp_sender_id
                AND primary_sender.sender_key='neutro'
            )
          )
      )
      AND ads_first.created_at >= ${cutoffSql}::timestamptz
      AND ads_first.source_created_at IS NOT NULL
      AND ads_first.source_created_at >= ${cutoffSql}::timestamptz
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


async function eligibleSecondaryAdsOnlyContactIds(ids, {
  database=pool,env=process.env,
}={}) {
  const result=new Set();
  const cutoff=adsOnlyActivation(env);
  if (!cutoff || env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
      !Array.isArray(ids) || ids.length===0)return result;
  const valid=[...new Set(ids.map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
  if (!valid.length)return result;
  try {
    // Drive the list from ad referrals, not thousands of imported contacts.
    // One indexed batch query per Inbox refresh, never one per conversation.
    const rows=await database.query(
      `SELECT DISTINCT c.id
       FROM whatsapp_free_entry_referrals ads_candidate
       JOIN contacts c ON c.id=ads_candidate.contact_id
       WHERE c.id=ANY($1::integer[])
         AND ads_candidate.recorded_at >= $2::timestamptz
         AND ${adsOnlyEligibleSql("c","$2")}`,
      [valid,cutoff]
    );
    for(const row of rows.rows||[])result.add(Number(row.id));
  }catch(err){
    console.error("[secondary ads-only] Inbox eligibility unavailable:",err?.message);
  }
  return result;
}
module.exports = { adsOnlyActivation, adsOnlyEligibleSql, isSecondaryAdsOnlyEligible,
  eligibleSecondaryAdsOnlyContactIds };
