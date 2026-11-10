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

function verifiedAdTreatment(incoming, config = {}) {
  const ref = incoming?.attribution;
  if (ref?.source !== "meta_ads" || String(ref?.sourceType || "").toLowerCase() !== "ad" ||
      !/^\d{5,30}$/.test(String(ref?.adId || ""))) return null;
  const treatment = resolveMetaAdCreativeService(
    { headline: ref.headline, body: ref.body },
    config.services || [], config.serviceAliases || []
  );
  return typeof treatment === "string" && treatment.length <= 80 ? treatment : null;
}

function build131060RecoveryReply(incoming, config = {}) {
  const treatment = verifiedAdTreatment(incoming, config);
  const greeting = treatment
    ? "Hi 😊 您刚才通过「" + treatment + "」广告联系我们。"
    : "Hi 😊";
  return greeting +
    "\n不好意思，WhatsApp 没有成功传送您刚才的讯息。麻烦您重新发送一次问题好吗？" +
    "\nSorry, we couldn't read your first message. Could you please resend it?" +
    "\nMaaf, mesej pertama anda tidak dapat dibaca. Boleh hantar sekali lagi?";
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
};
