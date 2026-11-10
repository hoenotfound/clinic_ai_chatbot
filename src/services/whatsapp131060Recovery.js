"use strict";

// An unavailable Coexistence message has no trustworthy customer text.
// A one-time service reply may ask the customer to resend, but must never
// fabricate an ad attribution, consent, price request or clinical intent.
const { pool } = require("../db/db");
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

function recoveryTreatmentButtons() {
  return RECOVERY_TREATMENTS.map(button => ({...button}));
}

function validRecoveryTreatmentButtons(buttons) {
  return Array.isArray(buttons) &&
    buttons.length === RECOVERY_TREATMENTS.length &&
    buttons.every((button,index) =>
      button?.id === RECOVERY_TREATMENTS[index].id &&
      button?.title === RECOVERY_TREATMENTS[index].title);
}

function build131060RecoveryReply(incoming, config = {}) {
  // A natural clinic receptionist prompt. Never expose the unsupported Meta
  // message, fabricate a patient's treatment or claim an unknown ad source.
  // We cannot infer language from an unreadable first message, so use the
  // Coexistence number's default Chinese greeting until a readable reply.
  const treatment = verifiedAdTreatment(incoming, config);
  return "Hi～欢迎来到 Neutro Sense 😊\n\n" +
    (treatment
      ? "想了解" + treatment + "对吗？也可以选择其他护理～"
      : "想了解哪方面的护理呢？") +
    "\n\n可以点下面的选项，其他护理（例如脉冲波）也可以直接告诉我们～";
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
       JOIN inbound_processing_jobs original_job ON original_job.message_id=initial.id
         AND original_job.channel='whatsapp'
         AND original_job.incoming_payload->>'unsupportedType'='unsupported'
         AND original_job.incoming_payload->'unsupportedErrors'
             @> '[{"code":131060}]'::jsonb
       JOIN inbound_outbound_attempts recovery_attempt
         ON recovery_attempt.inbound_message_id=initial.id
         AND recovery_attempt.contact_id=c.id
         AND recovery_attempt.origin='system_fallback'
         AND recovery_attempt.outcome='accepted'
         AND recovery_attempt.provider_message_id IS NOT NULL
       JOIN messages recovery ON recovery.id=recovery_attempt.assistant_message_id
         AND recovery.contact_id=c.id AND recovery.role='assistant'
         AND recovery.whatsapp_message_id IS NOT NULL
         AND recovery.id>initial.id AND recovery.id<current_inbound.id
         AND recovery.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
         AND recovery.content LIKE '%可以点下面的选项%'
       JOIN whatsapp_sender_message_context recovery_ctx
         ON recovery_ctx.message_id=recovery.id
         AND recovery_ctx.conversation_id=sc.id
       WHERE c.id=$1 AND c.channel='whatsapp'
         AND NOT EXISTS (
           SELECT 1 FROM messages before_first
           WHERE before_first.contact_id=c.id AND before_first.id<initial.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages between_first_and_menu
           WHERE between_first_and_menu.contact_id=c.id
             AND between_first_and_menu.id>initial.id
             AND between_first_and_menu.id<recovery.id
         )
       LIMIT 1`,
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
  if (!Array.isArray(history) || !proof?.unavailable_message_id ||
      history.length < 3 || history[0]?.role !== "user" ||
      !/^📎 \[[^\]]{1,100} sent a WhatsApp message that could not be displayed\]$/u.test(
        String(history[0]?.content || ""))) return history;
  return history.slice(1);
}

async function canSend131060Recovery({
  contactId, inboundMessageId, ignoreOutboundMessageId = null,
  database = pool, env = process.env,
} = {}) {
  const cutoff = recoveryActivation(env);
  const cid = Number(contactId);
  const mid = Number(inboundMessageId);
  const ignore = ignoreOutboundMessageId == null ? null : Number(ignoreOutboundMessageId);
  if (!cutoff || !Number.isSafeInteger(cid) || cid <= 0 ||
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
      " AND NOT EXISTS (SELECT 1 FROM messages older",
      "  WHERE older.contact_id=c.id AND older.id<inbound.id)",
      " AND NOT EXISTS (SELECT 1 FROM messages newer",
      "  WHERE newer.contact_id=c.id AND newer.id>inbound.id",
      "   AND ($3::integer IS NULL OR newer.id<>$3::integer))",
      ") AS eligible",
    ].join("\n");
    const result = await database.query(sql, [
      cid, mid, ignore, env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID, cutoff,
    ]);
    return result.rows?.[0]?.eligible === true;
  } catch (err) {
    console.error("[Meta 131060 recovery] Eligibility check failed closed:", err?.message);
    return false;
  }
}

module.exports = {
  RECOVERY_DELAY_MS, is131060Message, recoveryActivation,
  verifiedAdTreatment, build131060RecoveryReply, canSend131060Recovery,
  recoveryTreatmentButtons, validRecoveryTreatmentButtons,
  readableHistoryForRecoverySelection, getVerifiedRecoveryHistoryProof,
};
