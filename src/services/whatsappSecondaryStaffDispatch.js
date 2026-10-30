"use strict";

// Single guarded path for sender-specific *staff text only*. Nothing calls this
// for primary Neutro, AI, follow-ups, media or templates. Every flag defaults
// OFF; a saved draft is never itself authorization to send.
const { pool } = require("../db/db");
const templateTools = require("./whatsappTemplateService");
const senderRepo = require("../db/whatsappSenderConversationRepo");
const policy = require("./whatsappSecondaryPolicyService");
const billing = require("../db/whatsappSenderBillingGateRepo");
const { createVerifiedSecondaryOutboundTransport } =
  require("./whatsappSenderOutboundTransport");
const { secondaryUsesPrimaryClinicContent } =
  require("./whatsappSenderActivationGate");

function block(code) {
  return {
    success: false, wamid: null, policyBlocked: true,
    retryable: false, code,
    error: "This WhatsApp number is not ready to send, or the sender-specific policy check failed.",
  };
}
const ALLOWED_RESERVATION_SQL = `
 SELECT g.reservation_id
 FROM whatsapp_sender_billing_gates g
 JOIN whatsapp_sender_accounts sa ON sa.id=g.sender_id
 WHERE sa.sender_key=$1 AND sa.meta_phone_number_id=$2
   AND sa.meta_account_id=$3 AND sa.state='active'
   AND g.state='reserved' AND g.reservation_id=$4::uuid
   AND g.contact_id=$5 AND g.message_id=$6
   AND NOT EXISTS(
     SELECT 1 FROM whatsapp_sender_billing_alarms alarm
     WHERE alarm.sender_id=g.sender_id
   )
`;

async function sendSecondaryStaffText({
  contact, messageId, text, replyToProviderMessageId = null,
  origin = "staff", preSendCheck = null, dispatchTransport = null,
  templateRequest = null,
}, {
  env = process.env, database = pool,
  fetchImpl = global.fetch,
  createTransport = createVerifiedSecondaryOutboundTransport,
  policyService = policy, billingRepo = billing, conversationRepo = senderRepo,
  now = () => new Date(),
} = {}) {
  const aiTextOnly = env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED === "true";
  const parityRequested = env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED === "true";
  const parity = aiTextOnly && parityRequested &&
    env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true";
  const aiTextAuthorized = aiTextOnly &&
    env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED === "true" &&
    env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED !== "true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED === "true" &&
    env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true" &&
    (parity || env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED !== "true") &&
    (parity || env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED !== "true") &&
    (parity || (env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED === "true") ===
      (env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true")) &&
    (parity || env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED !== "true") &&
    env.WHATSAPP_COEXISTENCE_ENABLED === "true" &&
    secondaryUsesPrimaryClinicContent(env);
  const authorizedOrigin = origin === "staff"
    ? env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED === "true" &&
      (!aiTextOnly || (parity && aiTextAuthorized))
    : (["ai_reply","system_fallback"].includes(origin) && aiTextAuthorized) ||
      ((!aiTextOnly || (parity && aiTextAuthorized)) && origin === "ai_media" &&
        env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true") ||
      (origin === "followup" &&
        env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED === "true" &&
        (!aiTextOnly || aiTextAuthorized) &&
        env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true") ||
      (origin === "marketing_followup" && parity && aiTextAuthorized &&
        env.WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED === "true" &&
        env.WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED === "true" &&
        env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED === "true" &&
        templateRequest?.automatedMarketingApproved === true);
  if ((parityRequested && !parity) ||
      !authorizedOrigin ||
      // AI text-only and Phase B text follow-ups must not use a callback
      // capable of uploading media or sending non-text Graph payloads.
      (aiTextOnly && typeof dispatchTransport === "function" &&
        (!parity || !aiTextAuthorized ||
         (origin === "ai_media" && env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED !== "true") ||
         (origin === "followup" && env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED !== "true") ||
         (origin === "staff" && !templateRequest &&
           env.WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED !== "true") ||
         !["staff","ai_media","followup","marketing_followup"].includes(origin))) ||
      // Neither the existing follow-up sender nor an optional transport
      // callback may upload/dispatch media while sender media is disabled.
      (origin === "followup" && typeof dispatchTransport === "function" &&
        env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED !== "true") ||
      (templateRequest && (!["staff","marketing_followup"].includes(origin) ||
        env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED !== "true" ||
        typeof dispatchTransport !== "function" ||
        templateRequest.billingConfirmed !== true)) ||
      env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED !== "true") {
    return block("secondary_staff_send_disabled");
  }
  const cid = Number(contact?.id);
  const mid = Number(messageId);
  if (contact?.channel !== "whatsapp" ||
      !Number.isSafeInteger(cid) || cid <= 0 ||
      !Number.isSafeInteger(mid) || mid <= 0 ||
      typeof text !== "string" || !text.trim() ||
      text.trim().length > 4096 ||
      (replyToProviderMessageId != null &&
       !/^wamid\.[A-Za-z0-9._:-]{1,450}$/.test(replyToProviderMessageId))) {
    return block("secondary_staff_send_invalid_input");
  }

  if (typeof preSendCheck === "function" && await preSendCheck() !== true) {
    return { ...block("secondary_send_cancelled"), cancelled: true };
  }
  const preview = async () => {
    const result = templateRequest
      ? await policyService.previewSecondaryTemplatePolicy(contact, {
          name: templateRequest.name,
          languageCode: templateRequest.languageCode,
          treatmentInterest: templateRequest.treatmentInterest || null,
          database, env, now: now(), fetchImpl,
        })
      : await policyService.previewSecondaryFreeformPolicy(contact, {
          database, env, now: now(), purpose: "service",
        });
    if (templateRequest && result.policyAllowed === true) {
      const verified = result.template?.definition;
      if (!verified ||
          templateTools.templateSignature(templateTools.normalizeTemplate(verified))
            !== templateRequest.expectedSignature) {
        return { policyAllowed: false, code: "secondary_template_definition_changed" };
      }
    }
    return result;
  };
  const before = await preview();
  if (before.policyAllowed !== true) return block(before.code || "secondary_staff_policy_blocked");

  let conversation, transport;
  try {
    conversation = await conversationRepo.senderForContact(cid, database);
    if (!conversation || String(conversation.conversation_id) !==
        String(before.row?.sender_conversation_id)) {
      // Preview does not return raw row to external callers. An exact
      // sender-specific identity is separately checked below and again by
      // the transport before Graph API use.
      const snapshot = await policyService.secondaryPolicySnapshot(contact, { database, env });
      if (!snapshot.row ||
          String(conversation?.conversation_id) !==
            String(snapshot.row.sender_conversation_id)) {
        return block("secondary_staff_sender_mismatch");
      }
    }
    if (conversation?.sender_key !== env.WHATSAPP_SECONDARY_SENDER_KEY ||
        conversation?.sender_state !== "active" ||
        conversation?.meta_phone_number_id !== env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
        conversation?.meta_account_id !== env.WHATSAPP_SECONDARY_WABA_ID ||
        conversation?.customer_wa_id !== contact.whatsapp_number) {
      return block("secondary_staff_sender_mismatch");
    }
    const attached = await conversationRepo.attachMessageContext({
      messageId: mid, contactId: cid, conversationId: conversation.conversation_id,
    }, database);
    if (!attached || String(attached.conversation_id) !== String(conversation.conversation_id)) {
      return block("secondary_staff_message_not_owned");
    }
    transport = await createTransport(contact, { database, env, fetchImpl });
  } catch {
    return block("secondary_staff_sender_verification_failed");
  }

  const justBefore = await preview();
  if (justBefore.policyAllowed !== true) return block(justBefore.code || "secondary_staff_policy_blocked");

  const reserved = await billingRepo.reserveSecondaryBillingAttempt({
    contactId: cid, messageId: mid,
    // Freeform service messages may be charged after Meta's monthly free
    // allowance. Operator acknowledgment is separate from a template's
    // individual staff review and must be captured in the durable attempt.
    billableAuthorized: Boolean(templateRequest) ||
      env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED === "true",
    expectedTemplateSignature: templateRequest?.expectedSignature || null,
  }, { database, env });
  if (!reserved.reserved || !reserved.reservationId) {
    return block(reserved.code || "secondary_staff_billing_blocked");
  }
  // Once reserved, fail/timeout/connection errors cannot silently unlock it.
  // This prevents accidental second sends after an ambiguous Meta response.
  const markUnknown = async () => {
    await billingRepo.recordSecondaryProviderOutcome({
      reservationId: reserved.reservationId,
    }, { database, env }).catch(() => {});
  };
  try {
    const fresh = await preview();
    if (typeof preSendCheck === "function" && await preSendCheck() !== true) {
      await markUnknown();
      return { ...block("secondary_send_cancelled_after_reservation"),
        unknown: true, ambiguous: true };
    }
    if (fresh.policyAllowed !== true) {
      await markUnknown();
      return block(fresh.code || "secondary_staff_policy_changed");
    }
    const state = await database.query(ALLOWED_RESERVATION_SQL, [
      env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID,
      reserved.reservationId, cid, mid,
    ]);
    if (state.rows?.length !== 1) {
      await markUnknown();
      return block("secondary_staff_reservation_unverified");
    }
    // An app-originated staff echo can arrive during the final reservation
    // check. Recheck the sender-qualified cancellation epoch at the last
    // possible point before calling Meta. The consumed billing hold stays
    // unknown even when cancellation prevents the provider call.
    if (typeof preSendCheck === "function" && await preSendCheck() !== true) {
      await markUnknown();
      return {...block("secondary_send_cancelled_before_provider"),
        unknown:true, ambiguous:true};

    }

    const send = typeof dispatchTransport === "function"
      ? await dispatchTransport(transport)
      : await transport.sendText(text.trim(), { replyToProviderMessageId });
    const accepted = send?.success === true && /^wamid\./.test(String(send.wamid || ""));
    const evidence = await billingRepo.recordSecondaryProviderOutcome({
      reservationId: reserved.reservationId,
      acceptedWamid: accepted ? send.wamid : null,
      definitivelyRejected: !accepted && send?.definitivelyRejected === true,
    }, { database, env });
    if (!evidence?.recorded) {
      // A provider may have accepted the message even though Neon could not
      // persist the billing transition; never advertise a safe retry.
      return {
        // A Meta WAMID is not proof the sender-specific billing ledger
        // committed. Do not tell the AI pipeline a completed send occurred.
        success: false, wamid: accepted ? send.wamid : null,
        unknown: true, ambiguous: true, retryable: false,
        code: "secondary_staff_billing_outcome_unverified",
        error: "Provider outcome requires staff review; do not resend.",
      };
    }
    if (accepted) return { ...send, retryable:false, secondarySender:true };
    if (evidence.state === "rejected") return {
      ...send, success:false, wamid:null,
      unknown:false, ambiguous:false, retryable:false,
      code:"secondary_provider_definitively_rejected",
      error:"Meta rejected this message. Review the error before composing a new send.",
    };
    return { ...send, success: false, wamid: null,
      unknown: true, ambiguous: true, retryable: false,
      code: "secondary_staff_provider_outcome_unverified",
      error: "Delivery needs staff review; do not resend." };
  } catch {
    await markUnknown();
    return {
      success: false, wamid: null, unknown: true, ambiguous: true,
      retryable: false, code: "secondary_staff_unconfirmed",
      error: "Delivery outcome is unknown; do not resend without review.",
    };
  }
}

module.exports = { sendSecondaryStaffText, ALLOWED_RESERVATION_SQL };
