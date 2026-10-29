"use strict";

// These switches may NOT be enabled piecemeal. The existing single-number
// deployment remains unchanged when sender-scoped ingress is disabled.
// The secondary number must be independently verified and authorized.
// Approvals for a previous secondary number never transfer automatically.
// Sharing clinic content requires explicit approval, never token/ledger reuse.
function secondaryUsesPrimaryClinicContent(env = process.env) {
  return env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE === "primary" &&
    env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED === "true" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_PRIMARY_SENDER_KEY || "")) &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_SECONDARY_SENDER_KEY || "")) &&
    env.WHATSAPP_PRIMARY_SENDER_KEY !== env.WHATSAPP_SECONDARY_SENDER_KEY;
}
// An optional operator-pinned target identity prevents a stale Ariel/previous
// phone configuration from being accidentally enabled for the new number.
function assertExpectedSecondaryTarget(env=process.env) {
  const configuredPhone=String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"").trim();
  const configuredAccount=String(env.WHATSAPP_SECONDARY_WABA_ID||"").trim();
  for (const [key,value] of [
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID",configuredPhone],
    ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID",configuredAccount],
  ]) {
    const expected=String(env[key]||"").trim();
    if (expected && (!/^[0-9]+$/.test(expected) || expected!==value))
      throw new Error("Unsafe secondary target: "+key+" does not match verified receiving identity.");
  }
}
function assertSecondaryLifecyclePin(env = process.env) {
  // A coexistence account_update may contain only the phone's E164 number.
  // Without this independently approved pin a signed disconnect would be
  // quietly quarantined and secondary sends could remain enabled.
  if (env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true") return;
  const pin = String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 || "").trim();
  const primary = String(env.WHATSAPP_PHONE_NUMBER || "").replace(/\D/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(pin) ||
      (primary && primary === pin.slice(1))) {
    throw new Error("Unsafe WhatsApp secondary lifecycle pin: set the verified secondary E164 phone number before activation.");
  }
}
function assertSecondaryOperationalSafety(env = process.env) {
  assertExpectedSecondaryTarget(env);
  assertSecondaryLifecyclePin(env);
  const receiptIngress = env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true";
  const autoReconcile = env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true";
  const billedReview = env.WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED === "true";
  const staff = env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED === "true";
  const media = env.WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED === "true";
  const template = env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED === "true";
  const templateMedia = env.WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED === "true";
  const ai = env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true";
  const aiMedia = env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED === "true";
  const followups = env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED === "true";
  const aiTextOnly = env.WHATSAPP_PAID_SECONDARY_AI_TEXT_MODE_ENABLED === "true";
  // Phase A must not silently become staff sending, media or follow-ups.
  // Keep automatic reconciliation separately gated pending live receipt proof.
  if (aiTextOnly && (!ai || staff || media || template || templateMedia ||
      aiMedia || followups || autoReconcile || billedReview ||
      env.WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED === "true" ||
      env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED === "true" ||
      env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED !== "true")) {
    throw new Error("Unsafe WhatsApp secondary AI text-only activation: enable only verified AI text with signed live receipts; keep staff, media, templates and follow-ups off.");
  }
  // The AI prompt, business facts, offers and pricing are intentionally
  // shared with the primary Neutro clinic ONLY for its approved second number.
  // Sending and billing still use separately verified secondary credentials.
  if ((ai || aiMedia || followups) && !secondaryUsesPrimaryClinicContent(env)) {
    throw new Error("Unsafe WhatsApp secondary operational activation: secondary AI requires approved primary Neutro clinic-content binding.");
  }
  // The secondary sender is a WhatsApp Business App coexistence number. AI must
  // wait for sender-scoped Business App echoes to cancel competing replies.
  if ((ai || aiMedia || followups) &&
      env.WHATSAPP_COEXISTENCE_ENABLED !== "true") {
    throw new Error("Unsafe WhatsApp secondary operational activation: secondary AI needs Business App coexistence echo collision protection.");
  }
  // From 1 Oct 2026, a 24-hour WhatsApp service window no longer guarantees
  // zero charge. Meta grants a shared 1,000-service-message monthly allowance
  // per number but provides no atomic pre-send reservation in this code.
  // Receipt settlement happens AFTER delivery. Never let an operator enable
  // any secondary outbound class without explicitly accepting possible charges.
  const sendingEnabled = staff || media || template || templateMedia || ai || aiMedia || followups;
  if (sendingEnabled &&
      env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED !== "true") {
    throw new Error("Unsafe WhatsApp secondary operational activation: possible Meta service-message charges require explicit sender-specific acknowledgment.");
  }
  if (!receiptIngress && !autoReconcile && !billedReview && !staff && !media && !template && !templateMedia && !ai && !aiMedia && !followups) return;

  const common = [
    "WHATSAPP_MULTI_NUMBER_READ_ENABLED",
    "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
    "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
    "WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED",
  ];
  const sending = [
    "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
    "WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED",
    "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
    "WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED",
    "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
  ];
  if ((aiMedia && (!ai || !autoReconcile || !receiptIngress ||
                   env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED !== "true")) ||
      (followups && (!ai || !autoReconcile || !receiptIngress)) ||
      (media && !staff) || (template && !staff) ||
      (templateMedia && !template) ||
      (billedReview && (!template || !receiptIngress)) ||
      (autoReconcile && !receiptIngress) ||
      [...common,...((staff || ai || media) ? sending : [])]
      .some(key => env[key] !== "true") ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID || "")) ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_SECONDARY_SENDER_KEY || "")) ||
      !String(env.WHATSAPP_SECONDARY_TOKEN || "").trim() ||
      !String(env.WHATSAPP_APP_SECRET || "").trim() ||
      env.WHATSAPP_PHONE_NUMBER_ID === env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
      env.WHATSAPP_PRIMARY_SENDER_KEY === env.WHATSAPP_SECONDARY_SENDER_KEY) {
    throw new Error("Unsafe WhatsApp secondary operational activation: verify sender isolation, signed receipts, billing gates and account credentials before activation.");
  }
}

function assertSenderIngressSafety(env = process.env) {
  assertSecondaryOperationalSafety(env);
  if (env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED !== "true") return;
  if (env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_STRICT_METADATA !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED !== "true" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_PRIMARY_SENDER_KEY || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_WABA_ID || ""))) {
    throw new Error("Unsafe WhatsApp sender activation: scoped ingress requires verified " +
      "primary sender key/account/phone and strict Meta metadata/account guards.");
  }
}
// Called after versioned migrations, before workers and readiness go live.
// A former dual-number deployment must never silently revert to a single-
// sender send path while any non-primary conversation remains bound.
async function assertStoredSenderSafety({
  database = require("../db/db").pool,
  env = process.env,
} = {}) {
  assertSenderIngressSafety(env);
  const phone = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const account = String(env.WHATSAPP_WABA_ID || "").trim();
  const key = String(env.WHATSAPP_PRIMARY_SENDER_KEY || "").trim();
  const readEnabled = env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true";
  const ingressEnabled = env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true";
  // Even a flag rollback must inspect durable identity before workers start.
  const scope = await database.query(
    "SELECT COUNT(*)::int AS total, " +
    "COUNT(*) FILTER (WHERE sa.meta_phone_number_id IS DISTINCT FROM $1 " +
    "OR sa.meta_account_id IS DISTINCT FROM $2 " +
    "OR sa.state IS DISTINCT FROM 'active')::int AS nonprimary " +
    "FROM contacts c LEFT JOIN whatsapp_sender_accounts sa " +
    "ON sa.id=c.whatsapp_sender_id " +
    "WHERE c.channel='whatsapp' AND c.whatsapp_sender_id IS NOT NULL",
    [phone, account]
  );
  const total = Number(scope.rows?.[0]?.total);
  const nonprimary = Number(scope.rows?.[0]?.nonprimary);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(nonprimary)) {
    throw new Error("Cannot verify durable WhatsApp sender bindings at startup.");
  }
  // QA archive viewing only: the protected staging webhook refuses inbound
  // provider processing and all outbound workers are off. This exception is
  // intentionally limited to already-imported, sender-qualified QA history.
  // Production and any actual provider-enabled staging still require BOTH
  // sender-aware reads and sender-scoped ingress as before.
  const isolatedArchiveOnly =
    env.PR395_STAGING_MODE === "true" &&
    env.PR414_QA_HISTORY_ARCHIVE_VIEW_ENABLED === "true" &&
    readEnabled && !ingressEnabled &&
    env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED !== "true" &&
    env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true" &&
    env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED !== "true" &&
    env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED !== "true" &&
    env.PR414_QA_REAL_HISTORY_ACTION !== "import" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true" &&
    ![
      "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
      "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
      "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
      "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
      "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
      "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
      "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
      "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
      "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
      "WHATSAPP_FEP_FOLLOWUPS_ENABLED"
    ].some(flag => env[flag] === "true") &&
    (() => {
      try {
        const url = new URL(env.DATABASE_URL);
        return url.hostname.endsWith(".neon.tech") &&
          decodeURIComponent(url.pathname) === "/pr414_forward_qa" &&
          url.hostname.toLowerCase() === String(env.PR395_STAGING_EXPECTED_DATABASE_HOST || "").toLowerCase();
      } catch (_) { return false; }
    })();
  if (nonprimary > 0 && (!readEnabled || !ingressEnabled) && !isolatedArchiveOnly) {
    throw new Error("Unsafe WhatsApp rollback: secondary-number contacts are " +
      "bound; sender-aware reads AND sender-scoped ingress must remain enabled. " +
      "Disable secondary sends/workers instead, not the permanent identity boundary.");
  }
  if (env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true") {
    if (!ingressEnabled || !readEnabled ||
        !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"")) ||
        !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID||"")) ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_SECONDARY_SENDER_KEY||"")) ||
        // HMAC-verified, sender-pinned Inbox reception does not use a Meta
        // bearer credential. Never install one merely to receive text or echoes.
        // Any secondary sending or operational settlement is separately blocked
        // by assertSecondaryOperationalSafety unless its own token exists.
        // Inbound media remains unavailable until a secondary credential is
        // explicitly wired to the media fetcher (never fall back to primary).
        (env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED === "true" &&
          !String(env.WHATSAPP_SECONDARY_TOKEN || "").trim()) ||
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID===phone ||
        env.WHATSAPP_SECONDARY_SENDER_KEY===key) {
      throw new Error("Secondary WhatsApp Inbox configuration is incomplete or unsafe.");
    }
    const secondary = await database.query(
      "SELECT sender_key,state FROM whatsapp_sender_accounts " +
      "WHERE meta_phone_number_id=$1 AND meta_account_id=$2",
      [env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if (secondary.rows?.length !== 1 ||
        secondary.rows[0].sender_key !== env.WHATSAPP_SECONDARY_SENDER_KEY ||
        !["active", "disabled"].includes(secondary.rows[0].state)) {
      throw new Error("Secondary WhatsApp Inbox needs an exact verified sender registration.");
    }
    // A signed PARTNER_REMOVED deliberately disables the second sender.
    // Startup MUST continue serving Neutro while all secondary send/AI/media
    // paths fail closed on the disabled sender state.
    // Never accept 'testing' as a substitute for authorized activation.
  }
  if (ingressEnabled) {
    const registered = await database.query(
      "SELECT id, sender_key, state FROM whatsapp_sender_accounts " +
      "WHERE meta_phone_number_id=$1 AND meta_account_id=$2",
      [phone, account]
    );
    const sender = registered.rows?.[0];
    if (!sender || sender.state !== "active" || sender.sender_key !== key) {
      throw new Error("Unsafe WhatsApp activation: primary sender does not " +
        "match an active persisted Neutro account and business phone.");
    }
  }
  return { verified: true, scopedContacts: total, nonprimaryContacts: nonprimary };
}

module.exports = { assertSenderIngressSafety, assertStoredSenderSafety, assertSecondaryOperationalSafety, secondaryUsesPrimaryClinicContent, assertExpectedSecondaryTarget, assertSecondaryLifecyclePin };
