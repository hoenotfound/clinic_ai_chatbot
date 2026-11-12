"use strict";

// Opt-in, read-only diagnostics for signed WhatsApp callbacks. NEVER log raw
// webhook bytes, customer identifiers, content, usernames, phone numbers,
// signatures, referral IDs, or access tokens. A local receipt cannot prove
// that Meta attempted delivery when no signed callback was observed.
const crypto = require("node:crypto");

const MAX_ENTRIES = 32;
const MAX_CHANGES = 64;
const MAX_PROVIDER_REFS = 8;
const MAX_INSPECTED_MESSAGES = 128;
const MAX_INSPECTED_STATUSES = 128;
const PATHS = Object.freeze({
  "/webhook": "primary_endpoint",
  "/whatsapp/default": "app_default_endpoint",
});
const PHASES = new Set([
  "request", "signature_verified", "payload_parsed", "sender_routed",
  "durable_claim", "receiver_exception",
]);
const REASONS = new Set([
  "receiver_config", "sender_identity", "unauthorized_batch",
  "signature_proof", "storage_timeout", "receiver_exception",
]);

function enabled(env = process.env) {
  return env.WHATSAPP_WEBHOOK_INGRESS_DIAGNOSTICS_ENABLED === "true";
}

function providerRef(value) {
  // Provider message/status IDs are high-entropy IDs. The raw value is never
  // logged; a stable short SHA-256 prefix allows matching redelivery attempts.
  if (typeof value !== "string" || !value || value.length > 512) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function customerKind(message) {
  if (!message || typeof message !== "object") return "unknown";
  const from = typeof message.from === "string" ? message.from : "";
  const scoped = typeof message.from_user_id === "string"
    ? message.from_user_id
    : typeof message.user_id === "string" ? message.user_id : "";
  const isBsuid = (value) => /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(value);
  if (isBsuid(from) || (!from && isBsuid(scoped))) return "bsuid_only";
  if (/^\d{8,15}$/.test(from)) return scoped ? "phone_and_user_id" : "phone";
  return from || scoped ? "unrecognized" : "missing";
}

function senderKind(account, phone, env = process.env) {
  if (account === env.WHATSAPP_SECONDARY_WABA_ID &&
      phone === env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) return "secondary";
  if (account === env.WHATSAPP_WABA_ID &&
      phone === env.WHATSAPP_PHONE_NUMBER_ID) return "primary";
  if (account === env.WHATSAPP_SECONDARY_WABA_ID ||
      account === env.WHATSAPP_WABA_ID) return "known_account_wrong_or_missing_phone";
  return "foreign_or_unknown";
}

function ageBucket(value, nowMs) {
  if (!/^\d{9,11}$/.test(String(value ?? ""))) return ["unknown", null];
  const age = Math.round((nowMs - Number(value) * 1000) / 1000);
  if (!Number.isFinite(age)) return ["unknown", null];
  if (age < -30) return ["future", null];
  if (age < 60) return ["under_1m", Math.max(0, age)];
  if (age < 300) return ["1m_to_5m", age];
  if (age < 3600) return ["5m_to_1h", age];
  if (age < 86400) return ["1h_to_24h", age];
  return ["over_24h", age];
}

function summarizeSignedPayload(body, env = process.env, nowMs = Date.now()) {
  const summary = {
    entriesSeen: 0, changesSeen: 0, messageCount: 0, statusCount: 0,
    senderKinds: {}, identityKinds: {}, ageBuckets: {}, adReferrals: 0,
    providerRefs: [], maxAgeSeconds: null, truncated: false,
  };
  if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    return summary;
  }
  const refs = new Set();
  let inspectedMessages = 0;
  let inspectedStatuses = 0;
  const addRef = value => {
    if (refs.size >= MAX_PROVIDER_REFS) return;
    const digest = providerRef(value);
    if (digest) refs.add(digest);
  };
  for (const entry of body.entry.slice(0, MAX_ENTRIES)) {
    summary.entriesSeen++;
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes.slice(0, MAX_CHANGES)) {
      summary.changesSeen++;
      const phone = change?.value?.metadata?.phone_number_id;
      const sender = senderKind(entry.id, phone, env);
      summary.senderKinds[sender] = (summary.senderKinds[sender] || 0) + 1;
      if (change?.field !== "messages") continue;
      const messages = Array.isArray(change.value?.messages) ? change.value.messages : [];
      const statuses = Array.isArray(change.value?.statuses) ? change.value.statuses : [];
      summary.messageCount += messages.length;
      summary.statusCount += statuses.length;
      const remainingMessages = Math.max(0, MAX_INSPECTED_MESSAGES - inspectedMessages);
      const remainingStatuses = Math.max(0, MAX_INSPECTED_STATUSES - inspectedStatuses);
      for (const message of messages.slice(0, remainingMessages)) {
        inspectedMessages++;
        addRef(message?.id);
        const kind = customerKind(message);
        summary.identityKinds[kind] = (summary.identityKinds[kind] || 0) + 1;
        if (message?.referral?.source_type === "ad") summary.adReferrals++;
        const [bucket, age] = ageBucket(message?.timestamp, nowMs);
        summary.ageBuckets[bucket] = (summary.ageBuckets[bucket] || 0) + 1;
        if (age !== null) summary.maxAgeSeconds = Math.max(summary.maxAgeSeconds ?? 0, age);
      }
      for (const status of statuses.slice(0, remainingStatuses)) {
        inspectedStatuses++;
        addRef(status?.id);
      }
      if (messages.length > remainingMessages || statuses.length > remainingStatuses) {
        summary.truncated = true;
      }
    }
    if (entry.changes.length > MAX_CHANGES) summary.truncated = true;
  }
  if (body.entry.length > MAX_ENTRIES) summary.truncated = true;
  summary.providerRefs = [...refs];
  return summary;
}

function observe(req, res, next, env = process.env) {
  const route = PATHS[req.path];
  if (!route || req.method !== "POST" || !enabled(env)) return next();
  const trace = {
    route, signed: false, phase: "request", reason: null,
    claimAttempts: 0, claimsInserted: 0, summary: null,
  };
  req.whatsappIngressTrace = trace;
  let logged = false;
  const finish = (disconnected = false) => {
    if (logged) return;
    logged = true;
    // A signed customer turn is logged regardless of HTTP outcome. A 5xx is
    // logged even before signature verification, but without ANY body metadata.
    const isFailure = res.statusCode >= 400 || disconnected;
    if (!isFailure && !(trace.signed && trace.summary?.messageCount > 0)) return;
    const safe = {
      route: trace.route,
      signature: trace.signed ? "verified" : "not_verified",
      phase: trace.phase,
      httpStatus: disconnected ? null : res.statusCode,
      disconnected,
      ...(trace.reason ? { reason: trace.reason } : {}),
      ...(trace.signed && trace.summary ? {
        ...trace.summary, claimAttempts: trace.claimAttempts,
        claimsInserted: trace.claimsInserted,
      } : {}),
    };
    console.info("[WhatsApp signed ingress] " + JSON.stringify(safe));
  };
  res.once("finish", () => finish(false));
  res.once("close", () => {
    if (!res.writableFinished) finish(true);
  });
  next();
}

function markVerified(req, env = process.env) {
  if (req.whatsappIngressTrace && env.WHATSAPP_APP_SECRET &&
      req.headers?.["x-hub-signature-256"]) {
    req.whatsappIngressTrace.signed = true;
    req.whatsappIngressTrace.phase = "signature_verified";
  }
}

function captureSignedEvent(req, _res, next, env = process.env) {
  const trace = req.whatsappIngressTrace;
  if (trace?.signed) {
    trace.summary = summarizeSignedPayload(req.body, env);
    trace.phase = "payload_parsed";
  }
  next();
}

function markPhase(req, phase) {
  if (req.whatsappIngressTrace && PHASES.has(phase)) {
    req.whatsappIngressTrace.phase = phase;
  }
}

function markClaim(req, inserted) {
  if (!req.whatsappIngressTrace) return;
  req.whatsappIngressTrace.claimAttempts++;
  if (inserted) req.whatsappIngressTrace.claimsInserted++;
  req.whatsappIngressTrace.phase = "durable_claim";
}

function markRejected(req, error) {
  const trace = req.whatsappIngressTrace;
  if (!trace) return;
  const message = String(error?.message || "");
  const reason = message.includes("Unverified Neutro second-number live receiver configuration")
    ? "receiver_config"
    : message.includes("Signed live sender identity mismatch")
      ? "sender_identity"
      : message.includes("No authorized WhatsApp event in signed batch")
        ? "unauthorized_batch"
        : message.includes("signed Meta raw-body proof")
          ? "signature_proof"
          : error?.code === "SECONDARY_WEBHOOK_TIMEOUT"
            ? "storage_timeout"
            : "receiver_exception";
  trace.reason = REASONS.has(reason) ? reason : "receiver_exception";
  trace.phase = "receiver_exception";
}

module.exports = {
  enabled, providerRef, customerKind, senderKind, ageBucket,
  summarizeSignedPayload, observe, markVerified, captureSignedEvent,
  markPhase, markClaim, markRejected,
};
