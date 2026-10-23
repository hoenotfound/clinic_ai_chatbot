"use strict";

// The PR395 sandbox is deliberately an authorization-only environment unless
// an operator separately approves an isolated end-to-end trial. Defaults OFF
// and has zero effect on production Neutro without PR395_STAGING_MODE.
function isPr395Staging(env = process.env) {
  return env.PR395_STAGING_MODE === "true";
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
    if (env.NODE_ENV === "staging") {
      throw new Error("PR395 staging must explicitly set PR395_STAGING_MODE=true.");
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
  if (OUTBOUND_SWITCHES.some(key => env[key] === "true")) {
    throw new Error("PR395 staging forbids active WhatsApp sends, sync or follow-up/ingress flags.");
  }
  if (env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING === "true") {
    throw new Error("PR395 staging provider processing is prohibited until an isolated synthetic-data acceptance build is reviewed.");
  }
  return { staging: true, workersDisabled: true, providerProcessingDisabled: true };
}

function stagingWebhookGuard(req, res, next, env = process.env) {
  if (isPr395Staging(env)) {
    // No DB writes, no AI, no real customer responses on the sandbox URL.
    // Meta callbacks must never be configured to target this service until
    // a separate signed two-number test plan is authorized.
    res.set("Cache-Control", "no-store");
    return res.status(503).json({ error: "PR395 staging provider processing is disabled." });
  }
  return next();
}

module.exports = { isPr395Staging, assertPr395StagingSafety, stagingWebhookGuard, OUTBOUND_SWITCHES };
