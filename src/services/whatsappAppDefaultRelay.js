"use strict";

// Stateless app-default WhatsApp webhook relay. Never load this on the existing
// chatbot npm start path. Deploy separately and only after an end-to-end trial.
const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SECONDARY_FIELDS = new Set(["messages", "history", "smb_app_state_sync", "smb_message_echoes"]);
const LIFECYCLE_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_RECONNECTED"]);

function requireHttpsWebhook(value, name) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch (_) { throw Error(`${name} must be an HTTPS webhook URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== "/webhook") {
    throw Error(`${name} must be a clean HTTPS /webhook URL`);
  }
  return parsed.toString();
}

function configFromEnv(env = process.env) {
  const config = {
    appSecret: String(env.WHATSAPP_DEFAULT_RELAY_APP_SECRET || ""),
    verifyToken: String(env.WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN || ""),
    secondaryWaba: String(env.WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID || ""),
    secondaryPhone: String(env.WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164 || ""),
    legacyUrl: requireHttpsWebhook(env.WHATSAPP_DEFAULT_RELAY_LEGACY_URL, "Legacy callback"),
    lifecycleUrl: requireHttpsWebhook(env.WHATSAPP_DEFAULT_RELAY_LIFECYCLE_URL, "Lifecycle callback"),
  };
  if (config.appSecret.length < 24 || config.verifyToken.length < 16 ||
      !/^\d+$/.test(config.secondaryWaba) || !/^\+[1-9]\d{7,14}$/.test(config.secondaryPhone) ||
      config.legacyUrl === config.lifecycleUrl) {
    throw Error("Default callback relay identity/secrets are not fully configured");
  }
  return config;
}

function constantTimeEqual(first, second) {
  const a = Buffer.from(String(first || ""));
  const b = Buffer.from(String(second || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validMetaSignature(raw, header, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return constantTimeEqual(header, expected);
}
function matchingPhone(actual, expected) {
  return actual == null || (typeof actual === "string" &&
    actual.replace(/\D/g, "") === expected.replace(/\D/g, ""));
}

// A signed Meta batch can contain several accounts and fields. Split it into
// independently signed provider payloads without changing event content.
// Never forward secondary customer messages to the legacy application.
function partitionSignedBatch(payload, config) {
  if (payload?.object !== "whatsapp_business_account" ||
      !Array.isArray(payload.entry) || !payload.entry.length || payload.entry.length > 200) {
    throw Error("Unexpected default WhatsApp callback payload");
  }
  const legacy = [], lifecycle = [];
  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes) || !entry.changes.length ||
        entry.changes.length > 200) throw Error("Invalid WhatsApp callback entry");
    const legacyChanges = [], lifecycleChanges = [];
    for (const change of entry.changes) {
      if (!change || typeof change.field !== "string" ||
          !change.value || typeof change.value !== "object" || Array.isArray(change.value)) {
        throw Error("Invalid WhatsApp callback change");
      }
      if (String(entry.id || "") === config.secondaryWaba) {
        if (SECONDARY_FIELDS.has(change.field)) {
          throw Error("Secondary message/sync reached the app-default callback instead of its override");
        }
        if (change.field === "account_update") {
          if (!LIFECYCLE_EVENTS.has(change.value.event)) {
            // Never silently ACK a new secondary lifecycle type on the old
            // single-number receiver. Keep it retryable for operator review.
            throw Error("Unknown secondary account update requires routing review");
          }
          if (!matchingPhone(change.value.phone_number, config.secondaryPhone)) {
            throw Error("Secondary lifecycle phone mismatches the approved identity");
          }
          lifecycleChanges.push(change);
          continue;
        }
      }
      legacyChanges.push(change);
    }
    if (legacyChanges.length) legacy.push({ ...entry, changes: legacyChanges });
    if (lifecycleChanges.length) lifecycle.push({ ...entry, changes: lifecycleChanges });
  }
  return {
    legacy: legacy.length ? { ...payload, entry: legacy } : null,
    lifecycle: lifecycle.length ? { ...payload, entry: lifecycle } : null,
  };
}

async function postSigned(url, payload, config, fetchImpl = global.fetch) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = "sha256=" + crypto.createHmac("sha256", config.appSecret).update(raw).digest("hex");
  const response = await fetchImpl(url, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (!response || response.status < 200 || response.status >= 300) {
    throw Error(`Downstream callback refused an event (${response?.status || "network"})`);
  }
  // Old single-number servers could return 200 without persisting anything.
  // Require an explicit durable lifecycle marker from PR #395, never trust 200.
  if (url === config.lifecycleUrl &&
      response.headers?.get?.("x-da-coexistence-lifecycle-accepted") !== "1") {
    throw Error("Lifecycle receiver did not prove that the verified event was durable");
  }
}
async function dispatchSignedBatch(raw, signature, config, fetchImpl = global.fetch) {
  if (!validMetaSignature(raw, signature, config.appSecret)) return 403;
  let batches;
  try { batches = partitionSignedBatch(JSON.parse(raw.toString("utf8")), config); }
  catch (_) { return 503; }
  try {
    // An interrupted mixed batch may be replayed. Both receivers MUST be
    // idempotent by provider message ID / event fingerprint.
    if (batches.legacy) await postSigned(config.legacyUrl, batches.legacy, config, fetchImpl);
    if (batches.lifecycle) await postSigned(config.lifecycleUrl, batches.lifecycle, config, fetchImpl);
    return 200;
  } catch (_) { return 503; }
}

// Safe to deploy before onboarding: no Meta secrets, no downstream receiver
// network calls, no webhook verification handshake and no acceptance of POSTs.
// This MUST NOT be selected once the Meta app callback is pointed here.
function createPreparationRelayServer() {
  return http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/health/live") {
      res.writeHead(200, {"content-type": "text/plain"}).end("relay preparation mode: inactive");
      return;
    }
    res.writeHead(503, {"content-type": "text/plain"}).end("Meta routing is not enabled");
  });
}

function createRelayServer(config, { fetchImpl = global.fetch } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://relay.local");
      if (url.pathname === "/health/live" && req.method === "GET") {
        res.writeHead(200).end("ok"); return;
      }
      if (url.pathname !== "/webhook") { res.writeHead(404).end(); return; }
      if (req.method === "GET") {
        const verified = url.searchParams.get("hub.mode") === "subscribe" &&
          constantTimeEqual(url.searchParams.get("hub.verify_token"), config.verifyToken) &&
          url.searchParams.has("hub.challenge");
        res.writeHead(verified ? 200 : 403).end(verified ? url.searchParams.get("hub.challenge") : "");
        return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const code = await dispatchSignedBatch(Buffer.concat(chunks),
        req.headers["x-hub-signature-256"], config, fetchImpl);
      res.writeHead(code).end();
    } catch (error) {
      // Meta retries 503; never acknowledge a crash or downstream failure.
      console.error("App-default relay failed:", error?.message || "unknown");
      if (!res.headersSent) res.writeHead(503).end();
    }
  });
}
module.exports = { configFromEnv, createRelayServer, createPreparationRelayServer, dispatchSignedBatch, partitionSignedBatch, validMetaSignature };
