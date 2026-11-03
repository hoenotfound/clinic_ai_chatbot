"use strict";

// The legacy ads-only rule still protects media, follow-ups and marketing.
// Under a SEPARATE explicit rollout setting, conversational text AI may reply
// to any secondary-number contact who sends a new inbound after activation.
// Staff ownership, opt-outs, provider-bound sender and billing checks remain.
// Neither setting grants permission to replay earlier customer messages.
const { pool } = require("../db/db");

function originalAdsOnlyCutoff(env = process.env) {
  const raw = String(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > 0
    ? parsed.toISOString() : null;
}
function adsOnlyActivation(env = process.env) {
  return env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE === "ads_only"
    ? originalAdsOnlyCutoff(env) : null;
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
      AND (
        (${contactSql}.created_at >= ${cutoffSql}::timestamptz
         AND ${contactSql}.whatsapp_coexistence_imported_at IS NULL)
        OR EXISTS (
          -- A contact-only sync is not proof of a prior conversation, but
          -- cannot be auto-cleared: six-month import omits older conversations.
          -- Only an explicit review of BOTH sender histories can
          -- authorize future inbound AI on a verified first ad.
          SELECT 1 FROM whatsapp_secondary_ad_eligibility_reviews ads_review
          WHERE ads_review.contact_id=${contactSql}.id
            AND ads_review.origin_message_id=ads_first.id
            AND ads_review.decision='no_prior_conversation_verified'
            AND ads_review.secondary_app_history_checked=TRUE
            AND ads_review.primary_history_checked=TRUE
            AND ads_review.reviewed_at >= ads_first.created_at
        )
      )
      -- Only genuinely new Neutro patients may enter secondary AI.
      -- Look up older primary contacts by indexed E.164 or legacy local 01x.
      -- Never modify those contacts or their existing conversations.
      AND NOT EXISTS (
        SELECT 1 FROM contacts earlier_clinic_contact
        WHERE earlier_clinic_contact.id <> ${contactSql}.id
          AND earlier_clinic_contact.channel='whatsapp'
          AND (
            earlier_clinic_contact.created_at < ads_first.created_at
            OR EXISTS (
              -- A primary chat imported later can still have occurred before
              -- the secondary ad. Honor original provider timestamps.
              SELECT 1 FROM messages earlier_primary_message
              WHERE earlier_primary_message.contact_id=earlier_clinic_contact.id
                AND earlier_primary_message.role IN ('user','assistant')
                AND COALESCE(earlier_primary_message.source_created_at,
                             earlier_primary_message.created_at)
                    < ads_first.source_created_at
            )
          )
          AND earlier_clinic_contact.whatsapp_number IN (
            ${contactSql}.whatsapp_number,
            CASE WHEN ${contactSql}.whatsapp_number ~ '^601[0-9]{8,9}$'
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

// A reviewed, pre-activation contact must not suddenly receive a delayed
// 2h/6h/20h/48h+ reminder for the unanswered ad sent BEFORE staff reviewed it.
// Follow-up anchors on later customer messages can proceed under normal
// consent, billing, mode and treatment rules.
function reviewedContactFollowupGuardSql(contactSql = "c", anchorSql = "inbound") {
  return `NOT EXISTS (
    SELECT 1 FROM whatsapp_secondary_ad_eligibility_reviews reviewed
    WHERE reviewed.contact_id=${contactSql}.id
      AND reviewed.decision='no_prior_conversation_verified'
      AND ${anchorSql}.created_at <= reviewed.reviewed_at
  )`;
}

async function isSecondaryAdsOnlyEligible(contactId, {
  database = pool, env = process.env,
} = {}) {
  const cutoff = adsOnlyActivation(env);
  const id = Number(contactId);
  // The same operational gates as Inbox batching: secondary AI OFF means
  // no per-message audience queries, including during inbound preparation,
  // lead scoring, Telegram filtering and media enqueue checks.
  if (!cutoff || !Number.isSafeInteger(id) || id <= 0 ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED !== "true") return false;
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
      // Nothing to query on each Inbox refresh while secondary AI is OFF.
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

/**
 * Neutro may allow conversational AI replies to all contacts on its secondary
 * number WITHOUT enlarging its separately approved ads-only follow-up audience.
 * This is a separately opted-in setting with a UTC switch-on time, so pre-
 * activation webhook work cannot become a retroactive AI reply.
 */
function secondaryAllContactReplyActivation(env = process.env) {
  if (env.WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE !== "all_contacts" ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED !== "true") return null;
  const raw = String(env.WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) && d.getTime() > 0 ? d.toISOString() : null;
}

// Only use this for replies to incoming customer messages. It deliberately
// does NOT replace the ads-only SQL for follow-ups, marketing, or media jobs.
async function isSecondaryAiReplyEligible(contactId, {
  database = pool, env = process.env, inboundMessageId = null,
} = {}) {
  if (env.WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE !== "all_contacts")
    return isSecondaryAdsOnlyEligible(contactId, { database, env });
  const cutoff = secondaryAllContactReplyActivation(env);
  const id = Number(contactId);
  const mid = inboundMessageId == null ? null : Number(inboundMessageId);
  if (!cutoff || !Number.isSafeInteger(id) || id <= 0 ||
      (mid != null && (!Number.isSafeInteger(mid) || mid <= 0)) ||
      !env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || !env.WHATSAPP_SECONDARY_WABA_ID)
    return false;
  try {
    const proof = mid == null ? "" : `
      AND EXISTS (
        SELECT 1 FROM messages inbound
        JOIN whatsapp_sender_message_context mc
          ON mc.message_id=inbound.id AND mc.conversation_id=sc.id
        WHERE inbound.id=$5
          AND inbound.contact_id=c.id
          AND inbound.role='user'
          AND inbound.whatsapp_message_id IS NOT NULL
          AND inbound.created_at >= $4::timestamptz
          AND inbound.source_created_at >= $4::timestamptz
      )`;
    const result = await database.query(
      `SELECT EXISTS (
         SELECT 1
         FROM contacts c
         JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
         JOIN whatsapp_sender_conversations sc
           ON sc.sender_id=sa.id AND sc.contact_id=c.id
          AND sc.state='bound' AND sc.customer_wa_id=c.whatsapp_number
         WHERE c.id=$1 AND c.channel='whatsapp'
           AND sa.sender_key='neutro_secondary' AND sa.state='active'
           AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
           AND c.mode='ai' AND (
           c.needs_attention IS NOT TRUE OR (
             c.attention_reason LIKE 'Booking ready:%'
             AND NOT EXISTS (SELECT 1 FROM ai_review_items booking_review
               WHERE booking_review.contact_id=c.id
                 AND booking_review.status='pending'
                 AND booking_review.category <> 'information')
           )
         )
           AND c.whatsapp_opt_out_at IS NULL
           ${proof}
       ) AS eligible`,
      mid == null ? [id,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID] :
        [id,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
          env.WHATSAPP_SECONDARY_WABA_ID,cutoff,mid]
    );
    return result.rows?.[0]?.eligible === true;
  } catch (err) {
    console.error("[secondary all-contact reply] Eligibility failed closed:", err?.message);
    return false;
  }
}

// The Inbox needs one batched query, not one DB round trip per contact.
// This is an AI-ownership indicator, not permission to replay old messages.
async function eligibleSecondaryAiReplyContactIds(ids, {
  database = pool, env = process.env,
} = {}) {
  if (env.WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE !== "all_contacts")
    return eligibleSecondaryAdsOnlyContactIds(ids, {database,env});
  const result = new Set();
  if (!secondaryAllContactReplyActivation(env) || !Array.isArray(ids)) return result;
  const valid = [...new Set(ids.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (!valid.length || !env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
      !env.WHATSAPP_SECONDARY_WABA_ID) return result;
  try {
    const rows = await database.query(
      `SELECT c.id FROM contacts c
       JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
       JOIN whatsapp_sender_conversations sc
         ON sc.sender_id=sa.id AND sc.contact_id=c.id
        AND sc.state='bound' AND sc.customer_wa_id=c.whatsapp_number
       WHERE c.id=ANY($1::integer[]) AND c.channel='whatsapp'
         AND sa.sender_key='neutro_secondary' AND sa.state='active'
         AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
         AND c.mode='ai' AND (
           c.needs_attention IS NOT TRUE OR (
             c.attention_reason LIKE 'Booking ready:%'
             AND NOT EXISTS (SELECT 1 FROM ai_review_items booking_review
               WHERE booking_review.contact_id=c.id
                 AND booking_review.status='pending'
                 AND booking_review.category <> 'information')
           )
         )
         AND c.whatsapp_opt_out_at IS NULL`,
      [valid,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
    );
    for (const row of rows.rows || []) result.add(Number(row.id));
  } catch (err) {
    console.error("[secondary all-contact reply] Inbox eligibility failed closed:", err?.message);
  }
  return result;
}


/**
 * A distinct cutover for secondary automatic media and follow-ups.
 * It never backfills a previously received message and is intentionally
 * later than, or equal to, the conversational AI reply cutover.
 */
function secondaryAutomationActivation(env = process.env) {
  if (env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE === "ads_only")
    return adsOnlyActivation(env);
  if (env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE !== "all_contacts")
    return null;
  const replyCutoff = secondaryAllContactReplyActivation(env);
  if (!originalAdsOnlyCutoff(env)) return null;
  const raw = String(env.WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT || "");
  if (!replyCutoff ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw))
    return null;
  const cutoff = new Date(raw);
  if (!Number.isFinite(cutoff.getTime()) ||
      cutoff.getTime() < new Date(replyCutoff).getTime()) return null;
  return cutoff.toISOString();
}

// The *anchor inbound* is mandatory for non-ad automation. No imported,
// echo-only, unbound, or pre-cutover message can create a fresh marketing
// campaign, result-media job or reminder. Legacy ads-only rules remain intact.
// audienceSql is a bound SQL parameter, never an untrusted SQL string.
function secondaryAutomationEligibleSql(
  contactSql = "c", cutoffSql = "$6", anchorSql = "inbound",
  audienceSql = "$7", legacyCutoffSql = "$8"
) {
  return `(
    (${audienceSql}::text='ads_only'
      AND ${adsOnlyEligibleSql(contactSql,cutoffSql)})
    OR
    (${audienceSql}::text='all_contacts'
      AND (${adsOnlyEligibleSql(contactSql,legacyCutoffSql)}
      OR (
      ${contactSql}.channel='whatsapp'
      AND ${anchorSql}.role='user'
      AND ${anchorSql}.whatsapp_message_id IS NOT NULL
      AND ${anchorSql}.source_created_at IS NOT NULL
      AND ${anchorSql}.source_created_at >= ${cutoffSql}::timestamptz
      AND ${anchorSql}.created_at >= ${cutoffSql}::timestamptz
      AND EXISTS (
        SELECT 1 FROM whatsapp_sender_accounts verified_sa
        JOIN whatsapp_sender_conversations verified_sc
          ON verified_sc.sender_id=verified_sa.id
         AND verified_sc.contact_id=${contactSql}.id
         AND verified_sc.customer_wa_id=${contactSql}.whatsapp_number
         AND verified_sc.state='bound'
        JOIN whatsapp_sender_message_context verified_context
          ON verified_context.conversation_id=verified_sc.id
         AND verified_context.message_id=${anchorSql}.id
        WHERE verified_sa.id=${contactSql}.whatsapp_sender_id
          AND verified_sa.sender_key='neutro_secondary'
          AND verified_sa.state='active'
      )
      AND NOT EXISTS(
        SELECT 1 FROM whatsapp_sender_coexistence_history_messages old_sync
        WHERE old_sync.message_id=${anchorSql}.id
      )
      ))
    )
  )`;
}

async function isSecondaryAutomationEligible(contactId, {
  database = pool, env = process.env, inboundMessageId,
} = {}) {
  const cutoff = secondaryAutomationActivation(env);
  const cid = Number(contactId);
  const mid = Number(inboundMessageId);
  if (!cutoff || !Number.isSafeInteger(cid) || cid <= 0 ||
      !Number.isSafeInteger(mid) || mid <= 0 ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED !== "true") return false;
  try {
    const out = await database.query(
      `SELECT ${secondaryAutomationEligibleSql("c","$3","inbound","$4","$5")} AS eligible
         FROM contacts c
         JOIN messages inbound ON inbound.contact_id=c.id AND inbound.id=$2
        WHERE c.id=$1 AND c.mode='ai' AND c.needs_attention IS NOT TRUE
          AND c.whatsapp_opt_out_at IS NULL`,
      [cid,mid,cutoff,env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
        originalAdsOnlyCutoff(env)]
    );
    return out.rows?.length === 1 && out.rows[0].eligible === true;
  } catch (error) {
    console.error("[secondary automation] Eligibility failed closed:",error?.message);
    return false;
  }
}

module.exports = { adsOnlyActivation, adsOnlyEligibleSql, isSecondaryAdsOnlyEligible,
  eligibleSecondaryAdsOnlyContactIds, reviewedContactFollowupGuardSql,
  secondaryAllContactReplyActivation, isSecondaryAiReplyEligible,
  eligibleSecondaryAiReplyContactIds, secondaryAutomationActivation,
  secondaryAutomationEligibleSql, isSecondaryAutomationEligible,
  originalAdsOnlyCutoff };
