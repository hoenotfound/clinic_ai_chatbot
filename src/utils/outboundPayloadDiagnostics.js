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
// Fixed categories only. Never log the original request path, contact ID,
// body, headers, signed R2 URL or customer data.
const HTTP_ROUTES = [
  "inbox_list", "inbox_messages", "inbox_media", "inbox_other",
  "api_other", "webhook", "health", "static", "other",
];
const R2_VIDEO_OUTCOMES = [
  "redirected", "disabled_or_proxy", "unowned", "invalid_object", "error",
];
const responses = new Map();
const directVideos = new Map();

function coarseHttpRoute(pathname) {
  if (pathname === "/api/conversations") return "inbox_list";
  if (/^\\/api\\/conversations\\/[^/]+\\/messages\\/[^/]+\\/media$/.test(pathname)) return "inbox_media";
  if (/^\\/api\\/conversations\\/[^/]+\\/messages(?:\\/|$)/.test(pathname)) return "inbox_messages";
  if (/^\\/api\\/conversations(?:\\/|$)/.test(pathname)) return "inbox_other";
  if (pathname === "/webhook" || /^\\/webhook\\//.test(pathname)) return "webhook";
  if (pathname === "/" || /^\\/health(?:\\/|$)/.test(pathname)) return "health";
  if (/^\\/api(?:\\/|$)/.test(pathname)) return "api_other";
  if (/\\.(?:js|css|png|jpe?g|webp|svg|ico|woff2?|ttf)$/.test(pathname)) return "static";
  return "other";
}

function recordHttpResponse({ statusCode, pathname, contentLength, env = process.env } = {}) {
  if (!enabled(env)) return false;
  const category = coarseHttpRoute(pathname);
  const current = responses.get(category) || {
    requests: 0, knownResponseBytes: 0, unknownResponseSize: 0, status503: 0,
  };
  current.requests++;
  if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
    current.knownResponseBytes += contentLength;
  } else current.unknownResponseSize++;
  if (statusCode === 503) current.status503++;
  responses.set(category, current);
  return true;
}

function recordDirectR2Video(outcome, env = process.env) {
  if (!enabled(env) || !R2_VIDEO_OUTCOMES.includes(outcome)) return false;
  directVideos.set(outcome, (directVideos.get(outcome) || 0) + 1);
  return true;
}
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
  const httpResponses = HTTP_ROUTES.map(category => {
    const v = responses.get(category) || {
      requests: 0, knownResponseBytes: 0, unknownResponseSize: 0, status503: 0,
    };
    return {
      category, requests: v.requests, status503: v.status503,
      knownResponseMiB: Math.round(v.knownResponseBytes / 1048576 * 100) / 100,
      unknownResponseSize: v.unknownResponseSize,
    };
  });
  const directR2Video = R2_VIDEO_OUTCOMES.map(category => ({
    category, count: directVideos.get(category) || 0,
  }));
  counters.clear();
  failures.clear();
  responses.clear();
  directVideos.clear();
  return {
    coverage: "attempted_upload_known_json_and_content_length_only",
    buckets, http503, httpResponses, directR2Video,
  };
}

module.exports = {
  recordOutboundPayload, recordOutboundRequest, recordHttp503,
  recordHttpResponse, recordDirectR2Video, coarseHttpRoute,
  takeOutboundPayloadSnapshot,
};
