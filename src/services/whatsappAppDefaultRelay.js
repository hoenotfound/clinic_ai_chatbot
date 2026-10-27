"use strict";

// Stateless app-default WhatsApp webhook relay. Never load this on the existing
// chatbot npm start path. Deploy separately and only after an end-to-end trial.
const crypto = require("node:crypto");
const http = require("node:http");
const { performance } = require("node:perf_hooks");

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// Single bounded forwarding budget for an entire signed Meta batch, not one
// timeout per destination. Free Render cold starts can exceed the old 8s,
// but this is NOT a guarantee that Meta will keep its HTTP request open.
const DEFAULT_DISPATCH_TIMEOUT_MS = 30000;
const SECONDARY_FIELDS = new Set(["messages", "history", "smb_app_state_sync", "smb_message_echoes"]);
const LIFECYCLE_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_RECONNECTED"]);

function requireHttpsWebhook(value, name, expectedPath = "/webhook") {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch (_) { throw Error(`${name} must be an HTTPS webhook URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== expectedPath) {
    throw Error(`${name} must be a clean HTTPS /webhook URL`);
  }
  return parsed.toString();
}

function configFromEnv(env = process.env) {
  // The bootstrap mode is a separate, opt-in signed relay configuration.
  // Before Embedded Signup the QR-issued WABA does not exist yet. Never
  // guess it, wildcard-route all unknown accounts, or send callbacks to
  // the existing single-number handler without a known-account allowlist.
  const bootstrap = env.WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE === "true";
  const allowlist=String(env.WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS||"")
    .split(",").map(x=>x.trim()).filter(Boolean);
  // Enforce a complete explicit legacy account allowlist in both relay modes.
  const validLegacyAllowlist=allowlist.length>0 &&
    allowlist.every(x=>/^\d+$/.test(x)) &&
    new Set(allowlist).size===allowlist.length;
  const config={
    appSecret:String(env.WHATSAPP_DEFAULT_RELAY_APP_SECRET||""),
    verifyToken:String(env.WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN||""),
    secondaryWaba:String(env.WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID||""),
    secondaryPhone:String(env.WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164||""),
    legacyUrl:requireHttpsWebhook(env.WHATSAPP_DEFAULT_RELAY_LEGACY_URL,"Legacy callback"),
    lifecycleUrl:bootstrap?null:requireHttpsWebhook(env.WHATSAPP_DEFAULT_RELAY_LIFECYCLE_URL,"Lifecycle callback"),
    ...(!bootstrap?{
      legacyWabas:allowlist,
      legacyLifecycleUrl:requireHttpsWebhook(
        env.WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL,
        "Verified legacy lifecycle audit","/pr395-legacy-lifecycle-webhook")
    }:{}),
    ...(bootstrap?{bootstrap:{
      legacyWabas:allowlist,
      legacyLifecycleUrl:requireHttpsWebhook(
        env.WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL,
        "Verified legacy lifecycle audit","/pr395-legacy-lifecycle-webhook"),
      preidentityUrl:requireHttpsWebhook(env.WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL,
        "Preidentity receiver","/pr395-preidentity-webhook")
    }}:{}),
  };
  if(config.appSecret.length<24||config.verifyToken.length<16||
     !/^\+[1-9]\d{7,14}$/.test(config.secondaryPhone)||
     !validLegacyAllowlist||
     (bootstrap?(
       config.secondaryWaba!==""||allowlist.length!==1||
       config.bootstrap.preidentityUrl===config.legacyUrl||
       config.bootstrap.legacyLifecycleUrl===config.legacyUrl||
       config.bootstrap.legacyLifecycleUrl===config.bootstrap.preidentityUrl
     ):(
       !/^\d+$/.test(config.secondaryWaba)||
       allowlist.includes(config.secondaryWaba)||
       config.legacyUrl===config.lifecycleUrl||
       config.legacyUrl===config.legacyLifecycleUrl||
       config.lifecycleUrl===config.legacyLifecycleUrl
     ))) {
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
function partitionSignedBatch(payload,config) {
  if(payload?.object!=="whatsapp_business_account"||
     !Array.isArray(payload.entry)||!payload.entry.length||payload.entry.length>200)
    throw Error("Unexpected default WhatsApp callback payload");
  const legacy=[],legacyLifecycle=[],lifecycle=[],preidentity=[];
  const knownLegacy=new Set(config.bootstrap?.legacyWabas || config.legacyWabas || []);
  for(const entry of payload.entry){
    if(!entry||!Array.isArray(entry.changes)||!entry.changes.length||
       entry.changes.length>200)throw Error("Invalid WhatsApp callback entry");
    const legacyChanges=[],legacyLifecycleChanges=[],lifecycleChanges=[],preidentityChanges=[];
    for(const change of entry.changes){
      if(!change||typeof change.field!=="string"||
         !change.value||typeof change.value!=="object"||
         Array.isArray(change.value))
        throw Error("Invalid WhatsApp callback change");
      const entryId=String(entry.id||"");
      if(config.bootstrap){
        if(knownLegacy.has(entryId)){
          // The old callback can acknowledge account_update with HTTP 200
          // without any lifecycle persistence. All such updates must be
          // auditable, with an explicit COMMIT-bound downstream proof.
          if(change.field==="account_update")legacyLifecycleChanges.push(change);
          else legacyChanges.push(change);
        }else if(/^\d+$/.test(entryId)&&change.field==="account_update" &&
                 typeof change.value.phone_number==="string" &&
                 matchingPhone(change.value.phone_number,config.secondaryPhone) &&
                 typeof change.value.event==="string" &&
                 /^[-A-Z0-9_]{1,64}$/.test(change.value.event)){
          // Only the exact E.164 may cross this pre-identity boundary.
          // Never route unknown-account messages/history or an account-wide
          // event with NO phone: neither establishes sender ownership.
          preidentityChanges.push(change);
        }else{
          throw Error("Ambiguous or foreign account event during preidentity bootstrap");
        }
        continue;
      }
      if(entryId===config.secondaryWaba){
        if(SECONDARY_FIELDS.has(change.field))
          throw Error("Secondary message/sync reached app-default callback instead of override");
        if(change.field==="account_update"){
          if(!LIFECYCLE_EVENTS.has(change.value.event))
            throw Error("Unknown secondary account update requires routing review");
          if(!matchingPhone(change.value.phone_number,config.secondaryPhone))
            throw Error("Secondary lifecycle phone mismatches approved identity");
          lifecycleChanges.push(change);continue;
        }
        throw Error("Unrecognized secondary account event");
      }
      if(!knownLegacy.has(entryId))
        throw Error("Unrecognized account at app-default callback");
      // Do not ACK a legacy account_update without a durable audit.
      // This guarantee is required in both bootstrap and post-onboarding modes.
      if(change.field==="account_update")legacyLifecycleChanges.push(change);
      else legacyChanges.push(change);
    }
    if(legacyChanges.length)legacy.push({...entry,changes:legacyChanges});
    if(legacyLifecycleChanges.length)legacyLifecycle.push({...entry,changes:legacyLifecycleChanges});
    if(lifecycleChanges.length)lifecycle.push({...entry,changes:lifecycleChanges});
    if(preidentityChanges.length)preidentity.push({...entry,changes:preidentityChanges});
  }
  return{
    legacy:legacy.length?{...payload,entry:legacy}:null,
    legacyLifecycle:legacyLifecycle.length?{...payload,entry:legacyLifecycle}:null,
    lifecycle:lifecycle.length?{...payload,entry:lifecycle}:null,
    preidentity:preidentity.length?{...payload,entry:preidentity}:null,
  };
}

async function postSigned(url, payload, config, fetchImpl, deadline) {
  // Never begin another POST if an earlier downstream has exhausted the
  // shared deadline. An in-flight POST may have committed despite timeout:
  // report 503, let Meta decide about redelivery, and rely on durable
  // fingerprint/message-ID deduplication downstream. NEVER retry here.
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw Error("Relay forwarding deadline expired before downstream POST");
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = "sha256=" + crypto.createHmac("sha256", config.appSecret).update(raw).digest("hex");
  const controller = new AbortController();
  let timeoutId;
  // AbortSignal alone cannot enforce the deadline when a transport ignores
  // cancellation. Race its result against our own timer. A timed-out POST may
  // already have committed: never retry here; let Meta replay the whole batch.
  const expiry = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(Error("Relay forwarding deadline expired awaiting downstream ACK"));
    }, remaining);
  });
  let response;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: raw,
      })),
      expiry,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  // Even a noncompliant transport's late successful result is not a durable
  // ACK once the shared deadline elapsed.
  if (performance.now() >= deadline) throw Error("Relay forwarding deadline expired awaiting downstream ACK");
  if (!response || response.status < 200 || response.status >= 300) {
    throw Error(`Downstream callback refused an event (${response?.status || "network"})`);
  }
  // Old single-number servers could return 200 without persisting anything.
  // Require an explicit durable lifecycle marker from PR #395, never trust 200.
  if(url===(config.bootstrap?.legacyLifecycleUrl || config.legacyLifecycleUrl) &&
     response.headers?.get?.("x-da-legacy-lifecycle-accepted")!=="1"){
    throw Error("Legacy lifecycle receiver did not prove a durable account update audit");
  }
  if(config.bootstrap && url===config.bootstrap.preidentityUrl &&
     response.headers?.get?.("x-da-coexistence-preidentity-accepted")!=="1"){
    throw Error("Preidentity receiver did not prove a durable isolated audit");
  }
  if (config.lifecycleUrl && url === config.lifecycleUrl &&
      response.headers?.get?.("x-da-coexistence-lifecycle-accepted") !== "1") {
    throw Error("Lifecycle receiver did not prove that the verified event was durable");
  }
}
async function dispatchSignedBatch(raw, signature, config, fetchImpl = global.fetch,
  { dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS } = {}) {
  if (!validMetaSignature(raw, signature, config.appSecret)) return 403;
  if (!Number.isSafeInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 20 ||
      dispatchTimeoutMs > DEFAULT_DISPATCH_TIMEOUT_MS) return 503;
  let batches;
  try { batches = partitionSignedBatch(JSON.parse(raw.toString("utf8")), config); }
  catch (_) { return 503; }
  // The deadline is shared by all downstream deliveries, including mixed
  // legacy lifecycle and preidentity batches. No hidden per-target retry.
  const deadline = performance.now() + dispatchTimeoutMs;
  try {
    // An interrupted mixed batch may be replayed. All downstream receivers
    // MUST be idempotent by provider message ID / event fingerprint.
    if (batches.legacy) await postSigned(config.legacyUrl, batches.legacy, config, fetchImpl, deadline);
    if (batches.legacyLifecycle) await postSigned(config.bootstrap?.legacyLifecycleUrl || config.legacyLifecycleUrl, batches.legacyLifecycle, config, fetchImpl, deadline);
    if (batches.lifecycle) await postSigned(config.lifecycleUrl, batches.lifecycle, config, fetchImpl, deadline);
    if (batches.preidentity) await postSigned(config.bootstrap.preidentityUrl, batches.preidentity, config, fetchImpl, deadline);
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

function createRelayServer(config, {
  fetchImpl = global.fetch, dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS
} = {}) {
  if (!Number.isSafeInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 20 ||
      dispatchTimeoutMs > DEFAULT_DISPATCH_TIMEOUT_MS) {
    throw Error("Invalid relay dispatch deadline");
  }
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
        req.headers["x-hub-signature-256"], config, fetchImpl, {dispatchTimeoutMs});
      res.writeHead(code).end();
    } catch (error) {
      // Meta retries 503; never acknowledge a crash or downstream failure.
      console.error("App-default relay failed:", error?.message || "unknown");
      if (!res.headersSent) res.writeHead(503).end();
    }
  });
}
module.exports = { configFromEnv, createRelayServer, createPreparationRelayServer, dispatchSignedBatch, partitionSignedBatch, validMetaSignature };
