"use strict";

// Approximate attempted application upload/request payloads, NOT actual Render
// billed bytes. Fixed-category counters only; no file paths, phone numbers,
// contact IDs, query strings, URLs, tokens, response bodies or prompts.
const UPLOAD = new Set(["meta_primary_media", "meta_secondary_media", "r2_object_upload"]);
const REQUESTS = new Set([
  "meta_primary_json", "meta_secondary_json", "telegram_json",
  "anthropic_json", "gemini_sdk",
]);
const HTTP_503 = ["startup", "health", "webhook", "api", "other"];
const counters = new Map();
const failures = new Map();

function enabled(env) {
  return env?.DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED === "true";
}

function add(category, bytes) {
  const old = counters.get(category) || { attempts: 0, bytes: 0 };
  old.attempts++;
  old.bytes += bytes;
  counters.set(category, old);
}

function recordOutboundPayload(category, bytes, env = process.env) {
  if (!enabled(env) || !UPLOAD.has(category) ||
      !Number.isSafeInteger(bytes) || bytes <= 0) return false;
  add(category, bytes);
  return true;
}

// Only JSON/SDK request payloads already known at the call site are counted.
// SDK request bytes are intentionally unknown: a call count is not bandwidth.
function recordOutboundRequest(category, bytes = 0, env = process.env) {
  if (!enabled(env) || !REQUESTS.has(category) ||
      !Number.isSafeInteger(bytes) || bytes < 0) return false;
  add(category, bytes);
  return true;
}

function recordHttp503({ statusCode, pathname, readyAtStart, env = process.env } = {}) {
  if (!enabled(env) || statusCode !== 503) return false;
  let category = "other";
  if (readyAtStart === false) category = "startup";
  else if (pathname === "/" || pathname === "/health/ready" ||
           pathname === "/health/live") category = "health";
  else if (pathname === "/webhook" ||
           pathname === "/webhook/facebook" ||
           pathname === "/webhook/instagram") category = "webhook";
  else if (typeof pathname === "string" &&
           (pathname === "/api" || pathname.startsWith("/api/"))) category = "api";
  failures.set(category, (failures.get(category) || 0) + 1);
  return true;
}

function takeOutboundPayloadSnapshot() {
  const buckets = [...UPLOAD, ...REQUESTS].map((category) => {
    const v = counters.get(category) || { attempts: 0, bytes: 0 };
    return { category, attempts: v.attempts,
      payloadMiB: Math.round(v.bytes / 1048576 * 100) / 100 };
  });
  const http503 = HTTP_503.map(category => ({
    category, count: failures.get(category) || 0,
  }));
  counters.clear();
  failures.clear();
  return {
    coverage: "attempted_upload_and_known_json_payload_only",
    buckets, http503,
  };
}

module.exports = {
  recordOutboundPayload, recordOutboundRequest, recordHttp503,
  takeOutboundPayloadSnapshot,
};
