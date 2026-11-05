"use strict";

// Diagnostic estimate of known application upload payloads, NOT Render's billed
// service-initiated bandwidth. Fixed categories only; no URLs, patient data,
// media keys, account identifiers or request contents. No I/O or timers.
const ALLOWED = new Set(["meta_primary_media", "meta_secondary_media", "r2_object_upload"]);
const counters = new Map();

function recordOutboundPayload(category, bytes, env = process.env) {
  if (env.DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED !== "true" ||
      !ALLOWED.has(category) || !Number.isFinite(bytes) ||
      !Number.isSafeInteger(bytes) || bytes <= 0) return false;
  const old = counters.get(category) || { attempts: 0, bytes: 0 };
  old.attempts++;
  old.bytes += bytes;
  counters.set(category, old);
  return true;
}

function takeOutboundPayloadSnapshot() {
  const buckets = [...ALLOWED].map((category) => {
    const v = counters.get(category) || { attempts: 0, bytes: 0 };
    return { category, attempts: v.attempts, payloadMiB: Math.round(v.bytes / 1048576 * 100) / 100 };
  });
  counters.clear();
  return { coverage: "attempted_upload_payload_only", buckets };
}

module.exports = { recordOutboundPayload, takeOutboundPayloadSnapshot };
