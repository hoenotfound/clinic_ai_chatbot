"use strict";

// An unavailable Coexistence message has no trustworthy customer text.
// A one-time service reply may ask the customer to resend, but must never
// fabricate an ad attribution, consent, price request or clinical intent.
const { pool } = require("../db/db");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
const {
  secondaryAllContactReplyActivation,
  secondaryReplyAttentionAllowedSql,
} = require("./whatsappSecondaryAdsOnlyEligibility");
const { resolveMetaAdCreativeService } = require("./metaAdReplyContextService");

const RECOVERY_DELAY_MS = 3500;

function is131060Message(incoming) {
  return incoming && (incoming.channel == null || incoming.channel === "whatsapp") &&
    incoming.unsupportedType === "unsupported" &&
    Array.isArray(incoming.unsupportedErrors) &&
    incoming.unsupportedErrors.some(error => Number(error?.code) === 131060);
}

function recoveryActivation(env = process.env) {
  if (env.WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED !== "true" ||
      !secondaryAllContactReplyActivation(env)) return null;
  const raw = String(env.WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw))
    return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms > Date.now()) return null;
  return new Date(ms).toISOString();
}

// The configured creative matcher requires a full service name. A real ad
// can instead mention shortened names like "9D 逆龄", which must still make
// a pelvic + 9D creative ambiguous. This applies ONLY to the unverified
// recovery greeting, not the normal ad attribution or treatment resolver.
function conflictingRecoveryTreatments(creative) {
  const text = String(creative || "").normalize("NFKC");
  const mentions = [
    /骨盆|盆骨|骨盤|pelvi(?:s|c)/iu,
    /(?:^|[^a-z0-9])3\s*d(?![a-z0-9])|小[颜顏]/iu,
    /(?:^|[^a-z0-9])9\s*d(?![a-z0-9])|逆[龄齡]/iu,
    /脉冲|脈衝|pulse\s*wave/iu,
  ];
  return mentions.filter(pattern => pattern.test(text)).length > 1;
}

function verifiedAdTreatment(incoming, config = {}) {
  const ref = incoming?.attribution;
  if (ref?.source !== "meta_ads" || String(ref?.sourceType || "").toLowerCase() !== "ad" ||
      !/^\d{5,30}$/.test(String(ref?.adId || ""))) return null;
  // Fail closed even when one creative mention is an abbreviated service
  // name that the exact configured matcher would otherwise miss.
  if (conflictingRecoveryTreatments([ref.headline, ref.body].filter(Boolean).join(" ")))
    return null;
  const treatment = resolveMetaAdCreativeService(
    { headline: ref.headline, body: ref.body },
    config.services || [], config.serviceAliases || []
  );
  return typeof treatment === "string" && treatment.length <= 80 ? treatment : null;
}

// Three WhatsApp reply buttons is the provider maximum. Another treatment,
// including 脉冲波, remains selectable by typing its name. Button IDs are
// fixed, independent of ad metadata, and each title is a configured treatment.
// A button tap is first-party CUSTOMER interest, never proof of ad attribution.
const RECOVERY_TREATMENTS = Object.freeze([
  Object.freeze({id:"neutro_131060_pelvic",title:"骨盆调理"}),
  Object.freeze({id:"neutro_131060_3d",title:"3D 小颜术"}),
  Object.freeze({id:"neutro_131060_9d",title:"9D 逆龄抗衰"}),
]);

const RECOVERY_OPTIONS = Object.freeze([
  ...RECOVERY_TREATMENTS,
  Object.freeze({id:"neutro_131060_pulse",title:"脉冲波调理"}),
  Object.freeze({id:"neutro_131060_breast",title:"胸部护理"}),
  Object.freeze({id:"neutro_131060_other",title:"其他护理"}),
]);
const DEFAULT_RECOVERY_ORDER = Object.freeze([0,3,1,2,4,5].map(i=>RECOVERY_OPTIONS[i].id));
const RECOVERY_SECOND_TEXT = "我们也有提供以下护理哦 🥰\n\n可以点下面的选项，或直接告诉我们想了解的护理～";

function validRecoveryOrder(order) {
  return Array.isArray(order) && order.length===6 && new Set(order).size===6 &&
    order.every(id=>RECOVERY_OPTIONS.some(option=>option.id===id));
}
function recoveryTreatmentGroups(config = {}) {
  const order=validRecoveryOrder(config.recoveryTreatmentOrder)
    ? config.recoveryTreatmentOrder : DEFAULT_RECOVERY_ORDER;
  const buttons=order.map(id=>({...RECOVERY_OPTIONS.find(option=>option.id===id)}));
  return [buttons.slice(0,3),buttons.slice(3)];
}
function recoveryTreatmentButtons() {
  return RECOVERY_TREATMENTS.map(button => ({...button}));
}

function validRecoveryTreatmentButtons(buttons) {
  return Array.isArray(buttons) &&
    buttons.length === 3 && new Set(buttons.map(button=>button?.id)).size===3 &&
    buttons.every(button => RECOVERY_OPTIONS.some(option =>
      button?.id === option.id && button?.title === option.title));
}

function build131060RecoveryReply(incoming, config = {}, twoGroups = false) {
  // A natural clinic receptionist prompt. Never expose the unsupported Meta
  // message, fabricate a patient's treatment or claim an unknown ad source.
  // We cannot infer language from an unreadable first message, so use the
  // Coexistence number's default Chinese greeting until a readable reply.
  const treatment = verifiedAdTreatment(incoming, config);
  return "Hi～欢迎来到 Neutro Sense 😊\n\n" +
    (treatment
      ? "想了解" + treatment + "对吗？也可以选择其他护理～"
      : "想了解哪方面的护理呢？") +
    (twoGroups ? "\n\n可以点下面的选项，或直接告诉我们想了解的护理～" :
      "\n\n可以点下面的选项，其他护理（例如脉冲波）也可以直接告诉我们～");
}

// This is a narrow, read-only proof for AI prompt cleanup, not permission to
// send messages or assign an ad. Require an actual Meta 131060 first message,
// the secondary sender binding, and an accepted recovery menu backed by the
// SAME inbound's durable outbound attempt. Customer typing another treatment
// is just as valid as pressing a button.
async function getVerifiedRecoveryHistoryProof({
  contactId, inboundMessageId, database = pool,
} = {}) {
  const cid = Number(contactId);
  const mid = Number(inboundMessageId);
  if (!Number.isSafeInteger(cid) || cid <= 0 ||
      !Number.isSafeInteger(mid) || mid <= 0) return null;
  try {
    const result = await database.query(
      String.raw`SELECT initial.id AS unavailable_message_id,
              recovery.id AS recovery_message_id
       FROM contacts c
       JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
         AND sa.sender_key='neutro_secondary' AND sa.state='active'
       JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
         AND sc.contact_id=c.id AND sc.state='bound'
         AND sc.customer_wa_id=c.whatsapp_number
       JOIN messages current_inbound ON current_inbound.id=$2
         AND current_inbound.contact_id=c.id
         AND current_inbound.role='user'
         AND current_inbound.whatsapp_message_id IS NOT NULL
         AND current_inbound.source_created_at IS NOT NULL
       JOIN whatsapp_sender_message_context current_ctx
         ON current_ctx.message_id=current_inbound.id
         AND current_ctx.conversation_id=sc.id
       JOIN messages initial ON initial.contact_id=c.id
         AND initial.role='user' AND initial.whatsapp_message_id IS NOT NULL
         AND initial.id<current_inbound.id
       JOIN whatsapp_sender_message_context initial_ctx
         ON initial_ctx.message_id=initial.id
         AND initial_ctx.conversation_id=sc.id
       JOIN messages recovery ON recovery.contact_id=c.id
         AND recovery.role='assistant'
         AND recovery.whatsapp_message_id IS NOT NULL
         AND recovery.id>initial.id AND recovery.id<current_inbound.id
         AND recovery.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
         AND recovery.content LIKE '%可以点下面的选项%'
       LEFT JOIN inbound_processing_jobs original_job ON original_job.message_id=initial.id
       LEFT JOIN inbound_outbound_attempts recovery_attempt
         ON recovery_attempt.assistant_message_id=recovery.id
         AND recovery_attempt.inbound_message_id=initial.id
         AND recovery_attempt.contact_id=c.id
         AND recovery_attempt.origin='system_fallback'
         AND recovery_attempt.outcome='accepted'
         AND recovery_attempt.provider_message_id=recovery.whatsapp_message_id
       -- The 24h inbound-job cleanup cascades recovery_attempt. The
       -- independent accepted-send evidence can prove this prompt-only
       -- cleanup afterwards without creating ad attribution or consent.
       LEFT JOIN outbound_message_evidence accepted_outbound
         ON accepted_outbound.message_id=recovery.id
         AND accepted_outbound.contact_id=c.id
         AND accepted_outbound.channel='whatsapp'
         AND accepted_outbound.origin='system_fallback'
         AND accepted_outbound.accepted=TRUE
         AND accepted_outbound.provider_message_id=recovery.whatsapp_message_id
       JOIN whatsapp_sender_message_context recovery_ctx
         ON recovery_ctx.message_id=recovery.id
         AND recovery_ctx.conversation_id=sc.id
       WHERE c.id=$1 AND c.channel='whatsapp'
         AND initial.content LIKE
          '📎 [% sent a WhatsApp message that could not be displayed]'
         AND initial.source_created_at IS NOT NULL
         AND initial.created_at>=current_inbound.created_at-INTERVAL '7 days'
         AND recovery.created_at<initial.created_at+INTERVAL '24 hours'
         AND recovery.delivery_status IN('sent','delivered','read')
         AND (
           (
             original_job.channel='whatsapp'
             AND original_job.incoming_payload->>'unsupportedType'='unsupported'
             AND original_job.incoming_payload->'unsupportedErrors'
                 @> '[{"code":131060}]'::jsonb
             AND recovery_attempt.processing_job_id IS NOT NULL
           )
           OR (
             original_job.id IS NULL
             AND recovery_attempt.processing_job_id IS NULL
             AND accepted_outbound.message_id IS NOT NULL
             AND initial.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages between_first_and_menu
           WHERE between_first_and_menu.contact_id=c.id
             AND between_first_and_menu.id>initial.id
             AND between_first_and_menu.id<recovery.id
         )
       ORDER BY initial.created_at DESC,initial.id DESC LIMIT 1`,
      [cid, mid]
    );
    return result.rows?.[0] || null;
  } catch (err) {
    // Missing evidence leaves the stored history intact and never blocks a
    // customer reply. DB errors cannot turn arbitrary text into ad proof.
    console.warn("[Meta 131060 recovery] Prompt cleanup proof unavailable:",
      err?.message);
    return null;
  }
}

// Prompt-only cleanup. Exact first-message/accepted-send evidence is fetched
// above, so this cannot be triggered merely by spoofing a button ID or by
// typing "9D". Keep the actual Inbox history, staff messages and later
// customer texts unchanged.
function readableHistoryForRecoverySelection(history, proof) {
  if(!Array.isArray(history) || !proof?.unavailable_message_id || history.length<3)
    return history;
  const originalId=Number(proof.unavailable_message_id);
  const unreadable=/^📎 \[[^\]]{1,100} sent a WhatsApp message that could not be displayed\]$/u;
  const matched=history.some(entry =>
    entry?.role==='user' && Number(entry.contextMessageId)===originalId &&
    unreadable.test(String(entry.content||'')));
  if(matched){
    // Remove ONLY the provider-verified unreadable turn, even when this
    // patient has older conversations. Preserve staff and readable history.
    return history.filter(entry=>!(entry?.role==='user' &&
      Number(entry.contextMessageId)===originalId &&
      unreadable.test(String(entry.content||''))));
  }
  // Compatibility for existing callers/tests that provide a history without
  // internal message IDs and have the original unreadable FIRST message.
  return history[0]?.role==='user' && history[0].contextMessageId==null &&
    unreadable.test(String(history[0]?.content||''))
    ? history.slice(1) : history;
}

async function canSend131060Recovery({
  contactId, inboundMessageId, ignoreOutboundMessageId = null,
  firstRecoveryMessageId = null, database = pool, env = process.env,
} = {}) {
  const cutoff = recoveryActivation(env);
  const cid = Number(contactId);
  const mid = Number(inboundMessageId);
  const ignore = ignoreOutboundMessageId == null ? null : Number(ignoreOutboundMessageId);
  const first = firstRecoveryMessageId == null ? null : Number(firstRecoveryMessageId);
  if (first != null && (!Number.isSafeInteger(first) || first<=mid || first===ignore)) return false;
  if (!automatedRepliesEnabled(env) || !cutoff || !Number.isSafeInteger(cid) || cid <= 0 ||
      !Number.isSafeInteger(mid) || mid <= 0 ||
      (ignore != null && (!Number.isSafeInteger(ignore) || ignore <= 0)) ||
      !env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || !env.WHATSAPP_SECONDARY_WABA_ID)
    return false;
  try {
    // The two sender IDs, provider error, first-message status and newest
    // customer/staff activity must all be verified from persisted records.
    // Excluding only our own reserved outbound row makes this guard safe to
    // re-run immediately before Meta dispatch, after an outbound reservation.
    const sql = [
      "SELECT EXISTS (",
      " SELECT 1 FROM contacts c",
      " JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id",
      " JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id",
      "  AND sc.contact_id=c.id AND sc.state='bound'",
      "  AND sc.customer_wa_id=c.whatsapp_number",
      " JOIN messages inbound ON inbound.contact_id=c.id AND inbound.id=$2",
      " JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id",
      "  AND mc.conversation_id=sc.id",
      " JOIN inbound_processing_jobs job ON job.message_id=inbound.id",
      " WHERE c.id=$1 AND c.channel='whatsapp' AND c.mode='ai'",
      " AND (" + secondaryReplyAttentionAllowedSql("c") + ")",
      " AND c.whatsapp_opt_out_at IS NULL",
      " AND sa.sender_key='neutro_secondary' AND sa.state='active'",
      " AND sa.meta_phone_number_id=$4 AND sa.meta_account_id=$5",
      " AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL",
      " AND inbound.created_at >= $6::timestamptz",
      " AND inbound.source_created_at >= $6::timestamptz",
      " AND job.channel='whatsapp'",
      " AND job.incoming_payload->>'unsupportedType'='unsupported'",
      " AND job.incoming_payload->'unsupportedErrors' @> '[{\"code\":131060}]'::jsonb",
      " AND job.incoming_payload->>'businessPhoneNumberId'=$4",
      " AND job.incoming_payload->>'businessAccountId'=$5",
      // A genuine, new signed Meta 131060 event gets one neutral menu even
      // for an old customer; the missing content is never treated as an ad.
      // Only the newest customer turn qualifies. Prevent menu loops for a
      // patient who has already received a confirmed recovery this week.
      // Second group requires the durable, same-inbound first acceptance.
      ...(first == null ? [] : [
        " AND EXISTS (SELECT 1 FROM inbound_outbound_attempts a",
        " JOIN messages first_menu ON first_menu.id=a.assistant_message_id",
        " JOIN whatsapp_sender_message_context first_ctx ON first_ctx.message_id=first_menu.id AND first_ctx.conversation_id=sc.id",
        " WHERE a.processing_job_id=job.id AND a.inbound_message_id=inbound.id AND a.contact_id=c.id",
        " AND a.assistant_message_id=$7 AND a.origin='system_fallback' AND a.outcome='accepted'",
        " AND a.provider_message_id=first_menu.whatsapp_message_id AND first_menu.contact_id=c.id",
        " AND first_menu.role='assistant' AND first_menu.sent_by_username IS NULL",
        " AND first_menu.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'",
        " AND first_menu.content LIKE '%可以点下面的选项%'",
        " AND first_menu.whatsapp_interactive->>'type'='button'",
        " AND first_menu.delivery_status IS DISTINCT FROM 'failed')",
      ]),
      " AND NOT EXISTS (",
      "  SELECT 1 FROM outbound_message_evidence prior_evidence",
      "  JOIN messages prior_menu ON prior_menu.id=prior_evidence.message_id",
      "  WHERE prior_evidence.contact_id=c.id",
      "    AND prior_evidence.channel='whatsapp'",
      "    AND prior_evidence.origin='system_fallback'",
      "    AND prior_evidence.accepted=TRUE",
      "    AND prior_menu.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'",
      "    AND prior_menu.content LIKE '%可以点下面的选项%'",
      "    AND prior_menu.created_at>=inbound.created_at-INTERVAL '7 days'",
      ...(first == null ? [] : ["    AND prior_menu.id<>$7"]),
      " )",
      " AND NOT EXISTS (SELECT 1 FROM messages newer",
      "  WHERE newer.contact_id=c.id AND newer.id>inbound.id",
      "   AND ($3::integer IS NULL OR newer.id<>$3::integer)",
      ...(first == null ? [] : ["   AND newer.id<>$7"]),
      " )",
      ") AS eligible",
    ].join("\n");
    const result = await database.query(sql, [
      cid, mid, ignore, env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID, cutoff,
      ...(first == null ? [] : [first]),
    ]);
    return result.rows?.[0]?.eligible === true;
  } catch (err) {
    console.error("[Meta 131060 recovery] Eligibility check failed closed:", err?.message);
    return false;
  }
}

// Lock the original one-shot attempt while reserving the second group. A
// crash leaves a visible unknown row and never authorizes an automatic replay.
async function reserveRecoveryContinuation({contactId,inboundMessageId,firstRecoveryMessageId,buttons,database=pool,env=process.env}) {
  if (!validRecoveryTreatmentButtons(buttons)) return null;
  const client=database===pool ? await pool.connect() : database;
  try {
    await client.query("BEGIN");
    const locked=await client.query(`SELECT a.assistant_message_id,m.whatsapp_interactive
      FROM inbound_outbound_attempts a JOIN messages m ON m.id=a.assistant_message_id
      WHERE a.inbound_message_id=$1 AND a.contact_id=$2 AND a.assistant_message_id=$3
        AND a.origin='system_fallback' AND a.outcome='accepted' FOR UPDATE OF a`,
      [inboundMessageId,contactId,firstRecoveryMessageId]);
    const firstButtons=locked.rows[0]?.whatsapp_interactive?.buttons;
    if (!validRecoveryTreatmentButtons(firstButtons) || buttons.some(b=>firstButtons.some(f=>f.id===b.id)) ||
        !await canSend131060Recovery({contactId,inboundMessageId,firstRecoveryMessageId,database:client,env})) {
      await client.query("ROLLBACK"); return null;
    }
    const saved=await client.query(`INSERT INTO messages(contact_id,role,content,whatsapp_interactive,delivery_status,delivery_error)
      VALUES($1,'assistant',$2,$3::jsonb,'unknown','Recovery continuation reserved; delivery not confirmed.')
      RETURNING id,contact_id,role,content,whatsapp_interactive,delivery_status,created_at`,
      [contactId,RECOVERY_SECOND_TEXT,JSON.stringify({type:"button",buttons})]);
    await client.query("COMMIT"); return saved.rows[0] || null;
  } catch(err) { await client.query("ROLLBACK").catch(()=>{}); throw err; }
  finally { if(database===pool) client.release(); }
}

// Only a proven pre-provider cancellation may delete the reserved continuation.
async function cancelRecoveryContinuation(messageId,contactId,database=pool) {
  const result=await database.query(`DELETE FROM messages m
    WHERE m.id=$1 AND m.contact_id=$2 AND m.role='assistant'
      AND m.content=$3 AND m.delivery_status='unknown' AND m.whatsapp_message_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_billing_attempts b WHERE b.message_id=m.id)
    RETURNING m.id`,[messageId,contactId,RECOVERY_SECOND_TEXT]);
  return result.rows[0] || null;
}

function isOtherRecoverySelection(text) {
  return String(text||"").normalize("NFKC").trim()==="其他护理";
}
function scopeRecoveryCommercialHistory(history) {
  if (!Array.isArray(history)) return history;
  const index=history.findLastIndex(row=>row?.role==="user" && isOtherRecoverySelection(row.content));
  return index<0 ? history : history.slice(index);
}

module.exports = {
  RECOVERY_DELAY_MS, is131060Message, recoveryActivation,
  verifiedAdTreatment, build131060RecoveryReply, canSend131060Recovery,
  recoveryTreatmentButtons, validRecoveryTreatmentButtons,
  recoveryTreatmentGroups, validRecoveryOrder, RECOVERY_SECOND_TEXT, reserveRecoveryContinuation, cancelRecoveryContinuation,
  readableHistoryForRecoverySelection, getVerifiedRecoveryHistoryProof,
  isOtherRecoverySelection, scopeRecoveryCommercialHistory,
};
