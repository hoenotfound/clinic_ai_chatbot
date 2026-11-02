"use strict";

// Passive, fixed-label diagnostics only. No SQL, timers, network calls,
// raw event payloads, customer identifiers, message text or user identity.
// Counters reset on process restart. The ops endpoint is token protected.
const nowMinute = () => Math.floor(Date.now() / 60000);
const rows = new Map();
const STARTED_AT = new Date().toISOString();
const MAX_KEYS = 512;

const INBOX_REASONS = new Set([
  "startup", "reconnect", "summary_fallback", "multi_contact_event",
  "unknown_conversation_event", "pipeline_unknown_event",
  "pipeline_multi_contact", "pipeline_summary_fallback",
  "stale_summary_retry", "staff_action",
]);

const EVENT_REASONS = new Set([
  "message", "contact_state", "delivery_status", "reaction",
  "booking_confirmed", "whatsapp_opt_out", "appointment_set",
  "lead_scored", "meta_ad_enriched", "lead_assignment_recovered",
  "lead_assignment_changed", "scheduled_message",
  "free_entry_template_accepted", "config_changed", "rules_changed",
]);
const LANES = new Set(["primary", "secondary_service", "secondary_marketing"]);
const OUTCOMES = new Set(["queued", "coalesced", "ignored"]);
const TYPES = new Set(["conversation_changed", "pipeline_changed",
  "config_changed", "secondary_followup_rules_changed"]);
const CHANNELS = new Set(["primary_whatsapp", "secondary_whatsapp",
  "social", "unknown_whatsapp", "unknown"]);

function count(key) {
  const minute = nowMinute();
  let row = rows.get(key);
  if (!row) {
    if (rows.size >= MAX_KEYS) return;
    row = { total: 0, byMinute: new Map() };
    rows.set(key, row);
  }
  row.total++;
  row.byMinute.set(minute, (row.byMinute.get(minute) || 0) + 1);
  for (const previous of row.byMinute.keys()) {
    if (previous < minute - 14) row.byMinute.delete(previous);
  }
}

function classifyChannel(payload, env = process.env) {
  if (payload?.channel === "facebook" || payload?.channel === "instagram") return "social";
  if (payload?.channel && payload.channel !== "whatsapp") return "unknown";
  const sender = payload?.businessPhoneNumberId;
  if (sender != null) {
    if (env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
      String(sender) === String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) {
      return "secondary_whatsapp";
    }
    if (env.WHATSAPP_PHONE_NUMBER_ID &&
      String(sender) === String(env.WHATSAPP_PHONE_NUMBER_ID)) {
      return "primary_whatsapp";
    }
    return "unknown_whatsapp";
  }
  return "unknown";
}

function recordWorkerWake(lane, type, payload, outcome, env = process.env) {
  if (!LANES.has(lane) || !OUTCOMES.has(outcome)) return;
  const safeType = TYPES.has(type) ? type : "other";
  const rawReason = type === "config_changed" ? "config_changed"
    : type === "secondary_followup_rules_changed" ? "rules_changed"
      : payload?.reason;
  const reason = EVENT_REASONS.has(rawReason) ? rawReason : "other";
  const channel = classifyChannel(payload, env);
  count(["wake", lane, safeType, reason, channel, outcome].join("|"));
}

function recordInboxFullList(reason) {
  count("inbox|" + (INBOX_REASONS.has(reason) ? reason : "other"));
}

// Counters only. No usernames, patient IDs, request headers or WAL positions.
function recordInboxRevisionCheck(outcome) {
  if (outcome === "skipped_full_query" || outcome === "full_query" ||
      outcome === "wal_unavailable") {
    count("inbox_revision|" + outcome);
  }
}

// A fallback reason is independent of the existing full-query counter.
// Never include an ETag, WAL position, staff ID, request value or contact data.
const REVISION_FALLBACKS = new Set([
  "wal_unavailable", "missing_etag", "missing_proof",
  "proof_mismatch_or_wal_changed", "wal_changed_during_check",
]);
function recordInboxRevisionFallback(reason) {
  if (REVISION_FALLBACKS.has(reason)) count("inbox_revision_reason|" + reason);
}

// Reuses the existing bounded, five-minute diagnostics log and protected
// operations snapshot. No new timers, requests or database activity.
const SSE_EVENTS = new Set(["opened", "redacted_change"]);
function recordSseLifecycle(event, durationMs) {
  if (SSE_EVENTS.has(event)) {
    count("sse|" + event);
    return;
  }
  if (event !== "closed" || !Number.isFinite(durationMs) || durationMs < 0) return;
  const bucket = durationMs < 10000 ? "under_10s"
    : durationMs < 60000 ? "under_60s"
      : durationMs < 300000 ? "under_5min" : "5min_plus";
  count("sse|closed|" + bucket);
}

function snapshot() {
  const minute = nowMinute();
  const buckets = [...rows].map(([key, row]) => {
    let last5Minutes = 0, last15Minutes = 0;
    for (const [when, hits] of row.byMinute) {
      if (when < minute - 14) {
        row.byMinute.delete(when);
        continue;
      }
      last15Minutes += hits;
      if (when >= minute - 4) last5Minutes += hits;
    }
    return { key, total: row.total, last5Minutes, last15Minutes };
  }).sort((a, b) => b.last15Minutes - a.last15Minutes || a.key.localeCompare(b.key));
  return { startedAt: STARTED_AT, last5Minutes: buckets.reduce((s,x)=>s+x.last5Minutes,0),
    last15Minutes: buckets.reduce((s,x)=>s+x.last15Minutes,0), counters: buckets };
}

module.exports = { recordWorkerWake, recordInboxFullList,
  recordInboxRevisionCheck, recordInboxRevisionFallback, recordSseLifecycle,
  snapshot, classifyChannel, INBOX_REASONS };
