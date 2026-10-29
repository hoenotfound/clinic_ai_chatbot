"use strict";

// The PR395 sandbox is deliberately an authorization-only environment unless
// an operator separately approves an isolated end-to-end trial. Defaults OFF
// and has zero effect on production Neutro without PR395_STAGING_MODE.
function isPr395Staging(env = process.env) {
  return env.PR395_STAGING_MODE === "true";
}
function providerRehearsalEnabled(env = process.env) {
  return isPr395Staging(env) && env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED === "true";
}
// Manual staff QA is deliberately a separate, recipient-pinned opt-in.
// Never allow this in Neutro production or for unattended AI/marketing sends.
function controlledStaffTestEnabled(env = process.env) {
  return providerRehearsalEnabled(env) &&
    env.PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED === "true";
}
const CONTROLLED_STAFF_FLAGS = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED"
];
function approvedStaffTestRecipient(env = process.env) {
  if (!controlledStaffTestEnabled(env) ||
      env.PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED !== "true" ||
      env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED !== "true") {
    throw new Error("Staging manual staff send requires explicit operator and charge approval.");
  }
  const recipient = String(env.PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164 || "");
  if (!/^\+[1-9]\d{7,14}$/.test(recipient) ||
      recipient !== env.PR395_STAGING_APPROVED_TEST_RECIPIENT_E164 ||
      recipient === env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 ||
      recipient === env.WHATSAPP_PHONE_NUMBER ||
      recipient === CLINIC_SECOND_NUMBER_E164) {
    throw new Error("Staging staff test needs the independently pinned, distinct QA recipient.");
  }
  return recipient;
}
const REHEARSAL_INGRESS_SWITCHES = [
  "WHATSAPP_MULTI_NUMBER_READ_ENABLED",
  "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
  "WHATSAPP_COEXISTENCE_ENABLED",
  "WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED",
  "WHATSAPP_SINGLE_SENDER_STRICT_METADATA",
  "WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED",
];
const REHEARSAL_OUTBOUND_FORBIDDEN = [
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED",
  "WHATSAPP_FEP_FOLLOWUPS_ENABLED",
];
function digits(value) { return String(value || "").replace(/\D/g, ""); }
const CLINIC_SECOND_NUMBER_E164 = "+60174831336";
function clinicSecondNumberApproved(env) {
  return env.PR395_STAGING_MODE === "true" &&
    env.PR395_STAGING_REAL_CLINIC_ENABLED === "true" &&
    env.PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED === "true" &&
    env.PR395_STAGING_REAL_CLINIC_E164_PIN === CLINIC_SECOND_NUMBER_E164 &&
    env.PR395_STAGING_APPROVED_TEST_PHONE_E164 === CLINIC_SECOND_NUMBER_E164 &&
    env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 === CLINIC_SECOND_NUMBER_E164;
}
function verifiedRehearsalTarget(env) {
  const waba = String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim();
  const expectedWaba = String(env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID || "").trim();
  const phone = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim();
  const expectedPhone = String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID || "").trim();
  const e164 = String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 || "");
  const privateQaPin = String(env.PR395_STAGING_APPROVED_TEST_PHONE_E164 || "");
  if (!/^\d+$/.test(waba) || waba !== expectedWaba ||
      waba === String(env.WHATSAPP_WABA_ID || "") ||
      !/^\d+$/.test(phone) || phone !== expectedPhone ||
      (phone === "1318355951360575" && !clinicSecondNumberApproved(env)) || // Only permitted in separately approved real-clinic QA mode.
      phone === String(env.WHATSAPP_PHONE_NUMBER_ID || "") ||
      !/^\+[1-9]\d{7,14}$/.test(e164) ||
      e164 !== privateQaPin ||
      (e164 === CLINIC_SECOND_NUMBER_E164 && !clinicSecondNumberApproved(env)) ||
      digits(e164) === digits(env.WHATSAPP_PHONE_NUMBER || "") ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "coexistence_qa") {
    throw new Error("Provider rehearsal requires a separately verified secondary account, phone, E164 and sender key.");
  }
  return { waba, phone, e164 };
}


const OUTBOUND_SWITCHES = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_COEXISTENCE_ENABLED",
  "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
  "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_FEP_FOLLOWUPS_ENABLED",
];

function assertPr395StagingSafety(env = process.env) {
  if (!isPr395Staging(env)) {
    if (env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED === "true" ||
        env.PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED === "true" ||
        env.PR395_STAGING_LEGACY_LIFECYCLE_ENABLED === "true" ||
        env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING === "true" ||
        env.PR395_STAGING_REAL_CLINIC_ENABLED === "true" ||
        env.PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED === "true" ||
        env.PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED === "true" ||
        env.PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED === "true") {
      throw new Error("Provider rehearsal must never run outside PR395's isolated staging mode.");
    }
    if (env.NODE_ENV === "staging" ||
        env.PR395_STAGING_BASIC_AUTH_ENABLED === "true" ||
        String(env.PR395_STAGING_EXPECTED_DATABASE_HOST || "").trim()) {
      throw new Error("PR395 staging safeguards must never be partially enabled or silently disabled.");
    }
    return { staging: false };
  }
  if (env.NODE_ENV !== "production" && env.NODE_ENV !== "staging") {
    throw new Error("PR395 staging requires production-grade NODE_ENV to enforce secure webhook and session behavior.");
  }
  if (env.PR395_STAGING_BASIC_AUTH_ENABLED !== "true" ||
      !String(env.PR395_STAGING_BASIC_AUTH_USERNAME || "").trim() ||
      String(env.PR395_STAGING_BASIC_AUTH_PASSWORD || "").length < 32) {
    throw new Error("PR395 staging requires a dedicated Basic Auth username and 32+-character password.");
  }
  const secondaryId = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim();
  const expectedId = String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID || "").trim();
  const expectedNumber = String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 || "").replace(/[^0-9]/g, "");
  // Before Meta authorization, protected staging may deliberately carry NO
  // secondary Meta IDs. Never retain the previous clinic's ID as a stand-in
  // for the owner's personal QA number. Live provider rehearsal still requires
  // a complete, independently verified phone + account identity.
  const noSecondaryPhoneId = !secondaryId && !expectedId;
  if ((providerRehearsalEnabled(env) && noSecondaryPhoneId) ||
      (!noSecondaryPhoneId && (!/^\d+$/.test(secondaryId) || secondaryId !== expectedId ||
        expectedId === String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim())) ||
      !/^\d{9,15}$/.test(expectedNumber) ||
      (!providerRehearsalEnabled(env) && String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim())) {
    throw new Error("PR395 staging requires either both matching verified phone IDs or neither while provider ingress is disabled.");
  }
  for (const key of ["SESSION_SECRET", "WHATSAPP_APP_SECRET", "META_APP_SECRET"]) {
    if (String(env[key] || "").length < 24) {
      throw new Error("PR395 staging requires configured secrets: " + key);
    }
  }
  const dbUrl = String(env.DATABASE_URL || "");
  const pin = String(env.PR395_STAGING_EXPECTED_DATABASE_HOST || "").trim().toLowerCase();
  let hostname;
  try { hostname = new URL(dbUrl).hostname.toLowerCase(); } catch (_) {}
  if (!hostname || !pin || hostname !== pin ||
      !/\.neon\.tech$/.test(hostname)) {
    throw new Error("PR395 staging DATABASE_URL must match its explicitly pinned isolated Neon endpoint host.");
  }
  if(env.PR395_STAGING_LEGACY_LIFECYCLE_ENABLED==="true"){
    const {enabled:legacyAuditEnabled}=require("./pr395LegacyLifecycleReceiver");
    if(!legacyAuditEnabled(env) ||
       env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED==="true" ||
       env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING==="true" ||
       OUTBOUND_SWITCHES.some(k=>env[k]==="true") ||
       REHEARSAL_OUTBOUND_FORBIDDEN.some(k=>env[k]==="true") ||
       (String(env.WHATSAPP_TOKEN||"").trim() &&
        !String(env.WHATSAPP_TOKEN).startsWith("pr395-inert-"))){
      throw new Error("Legacy lifecycle audit requires isolated, HMAC-verified and outbound-disabled staging.");
    }
  }
  if (env.PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED === "true") {
    const {enabled:preidentityEnabled} = require("./pr395PreidentityReceiver");
    if (!preidentityEnabled(env) ||
        env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING === "true" ||
        env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED === "true" ||
        OUTBOUND_SWITCHES.some(key=>env[key]==="true") ||
        REHEARSAL_OUTBOUND_FORBIDDEN.some(key=>env[key]==="true") ||
        String(env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID||"").trim() ||
        String(env.WHATSAPP_TOKEN||"").trim() &&
          !String(env.WHATSAPP_TOKEN).startsWith("pr395-inert-")) {
      throw new Error("PR395 preidentity receiver requires unassigned QA IDs, isolated database, verified app HMAC, and no provider sending.");
    }
  }
  if (env.PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED === "true" &&
      !providerRehearsalEnabled(env)) {
    throw new Error("Controlled staff test requires isolated, signed provider rehearsal.");
  }
  if (providerRehearsalEnabled(env)) {
    verifiedRehearsalTarget(env);
    const staffTest = controlledStaffTestEnabled(env);
    if (staffTest) {
      approvedStaffTestRecipient(env);
      if (CONTROLLED_STAFF_FLAGS.some(key => env[key] !== "true") ||
          env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED !== "true" ||
          env.WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED !== "true") {
        throw new Error("Staging staff test requires receipt, billing and manual-reconciliation guards.");
      }
    }
    if (env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true" ||
        REHEARSAL_INGRESS_SWITCHES.some(key => env[key] !== "true") ||
        REHEARSAL_OUTBOUND_FORBIDDEN.some(key => env[key] === "true" &&
          (!staffTest || !CONTROLLED_STAFF_FLAGS.includes(key))) ||
        OUTBOUND_SWITCHES.some(key => env[key] === "true" &&
          !REHEARSAL_INGRESS_SWITCHES.includes(key) &&
          (!staffTest || !CONTROLLED_STAFF_FLAGS.includes(key))) ||
        !String(env.WHATSAPP_SECONDARY_TOKEN || "").trim() ||
        // The staging binary must not possess production primary Cloud API
        // sending credentials. This is enforced even if the portal is accessed.
        (String(env.WHATSAPP_TOKEN || "").trim() &&
          !String(env.WHATSAPP_TOKEN).startsWith("pr395-inert-")) ||
        String(env.WHATSAPP_APP_SECRET) !== String(env.META_APP_SECRET)) {
      throw new Error("PR395 provider rehearsal requires verified inbound configuration and forbids all outbound traffic.");
    }
    return staffTest
      ? { staging: true, workersDisabled: true, providerProcessingDisabled: false,
          historyImporterOnly: true, controlledStaffTest: true }
      : { staging: true, workersDisabled: true, providerProcessingDisabled: false,
          historyImporterOnly: true };
  }
  if (OUTBOUND_SWITCHES.some(key => env[key] === "true") ||
      env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING === "true") {
    throw new Error("PR395 protected staging forbids active WhatsApp provider processing or sends.");
  }
  return { staging: true, workersDisabled: true, providerProcessingDisabled: true };
}

function validProviderRehearsalEvent(body, path, env) {
  const { waba, phone, e164 } = verifiedRehearsalTarget(env);
  if (body?.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || body.entry.length < 1 || body.entry.length > 200) return false;
  const regular = new Set(["messages", "smb_message_echoes", "history", "smb_app_state_sync"]);
  return body.entry.every(entry =>
    String(entry?.id || "") === waba && Array.isArray(entry.changes) &&
    entry.changes.length > 0 && entry.changes.length <= 200 &&
    entry.changes.every(change => {
      if (!change?.value || typeof change.value !== "object" || Array.isArray(change.value)) return false;
      if (path === "/meta-webhook" && change.field !== "account_update") return false;
      if (change.field === "account_update") {
        const n = change.value.phone_number;
        return n == null || (typeof n === "string" && digits(n) === digits(e164));
      }
      return path === "/webhook" && regular.has(change.field) &&
        change.value.metadata?.phone_number_id === phone &&
        !(change.field === "messages" && Array.isArray(change.value.statuses) &&
          change.value.statuses.length > 0 && !controlledStaffTestEnabled(env));
    })
  );
}
function stagingWebhookGuard(req, res, next, env = process.env) {
  if (isPr395Staging(env)) {
    if (providerRehearsalEnabled(env) && validProviderRehearsalEvent(req.body, req.path, env)) {
      // The request body has already passed the raw-body HMAC parser upstream.
      return next();
    }
    // No DB writes, no AI, no real customer responses on the sandbox URL.
    // Meta callbacks must never be configured to target this service until
    // a separate signed two-number test plan is authorized.
    res.set("Cache-Control", "no-store");
    return res.status(503).json({ error: "PR395 staging provider processing is disabled." });
  }
  return next();
}

module.exports = { isPr395Staging, providerRehearsalEnabled, controlledStaffTestEnabled, approvedStaffTestRecipient, clinicSecondNumberApproved, verifiedRehearsalTarget, validProviderRehearsalEvent, assertPr395StagingSafety, stagingWebhookGuard, OUTBOUND_SWITCHES };
