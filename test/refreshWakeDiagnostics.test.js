"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { recordWorkerWake, recordInboxFullList, recordInboxRevisionCheck,
  recordInboxRevisionFallback, recordSseLifecycle, snapshot, classifyChannel } =
  require("../src/utils/refreshWakeDiagnostics");

test("passive counters classify wake decisions without retaining sensitive event fields", () => {
  const env = {
    WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
  };
  const sensitive = {
    channel: "whatsapp",
    businessPhoneNumberId: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    reason: "message", contactId: 1234567,
    phone: "+60123123456", message: "PRIVATE CLINIC MESSAGE",
  };
  assert.equal(classifyChannel(sensitive, env), "secondary_whatsapp");
  assert.equal(classifyChannel({
    ...sensitive, businessPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  }, env), "primary_whatsapp");
  assert.equal(classifyChannel({ channel: "facebook" }, env), "social");
  const key = "wake|secondary_service|conversation_changed|message|secondary_whatsapp|queued";
  const before = snapshot().counters.find(x => x.key === key)?.total || 0;
  recordWorkerWake("secondary_service", "conversation_changed", sensitive, "queued", env);
  const after = snapshot();
  assert.equal(after.counters.find(x => x.key === key)?.total, before + 1);
  assert.ok(after.counters.find(x => x.key === key)?.last5Minutes >= 1);
  assert.doesNotMatch(JSON.stringify(after), /60123123456|PRIVATE CLINIC MESSAGE|1234567/);
  assert.doesNotMatch(JSON.stringify(after), /1408739622311791|1318355951360575/);
});

test("arbitrary free-form event reasons and inbox headers cannot create unique metric keys", () => {
  const unique = "private-customer-" + Date.now();
  recordWorkerWake("secondary_marketing", "conversation_changed", {
    reason: unique, channel: unique, phone: unique, content: unique,
  }, "ignored");
  recordInboxFullList(unique);
  const report = snapshot();
  assert.ok(report.counters.some(x => x.key === "inbox|other"));
  assert.ok(report.counters.some(x => x.key ===
    "wake|secondary_marketing|conversation_changed|other|unknown|ignored"));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(unique));
  recordInboxFullList("reconnect");
  recordInboxFullList("startup");
  assert.ok(snapshot().counters.some(x => x.key === "inbox|reconnect"));
  assert.ok(snapshot().counters.some(x => x.key === "inbox|startup"));
});

test("bounded counters reject unknown worker and outcome categories", () => {
  const previous = snapshot().counters.length;
  recordWorkerWake("not-a-worker", "conversation_changed", {}, "queued");
  recordWorkerWake("secondary_service", "conversation_changed", {}, "not-a-result");
  assert.equal(snapshot().counters.length, previous);
});

test("cheap Inbox revision counters remain bounded, anonymous and separate from full reads", () => {
  const initial = snapshot().counters.find(x => x.key === "inbox_revision|skipped_full_query")?.total || 0;
  recordInboxRevisionCheck("skipped_full_query");
  recordInboxRevisionCheck("full_query");
  recordInboxRevisionCheck("wal_unavailable");
  recordInboxRevisionCheck("patient-name: private");
  const counters = snapshot().counters;
  assert.equal(counters.find(x => x.key === "inbox_revision|skipped_full_query")?.total, initial + 1);
  assert.ok(counters.some(x => x.key === "inbox_revision|full_query"));
  assert.ok(counters.some(x => x.key === "inbox_revision|wal_unavailable"));
  assert.doesNotMatch(JSON.stringify(counters), /patient-name: private/);
});

test("fixed-label Inbox proof fallbacks never disclose request values", () => {
  const before = snapshot().counters.find(x =>
    x.key === "inbox_revision_reason|missing_proof")?.total || 0;
  for (const reason of [
    "wal_unavailable", "missing_etag", "missing_proof",
    "proof_mismatch_or_wal_changed", "wal_changed_during_check",
  ]) recordInboxRevisionFallback(reason);
  recordInboxRevisionFallback("sensitive-customer-identification");
  const items = snapshot().counters;
  assert.equal(items.find(x => x.key === "inbox_revision_reason|missing_proof")?.total, before + 1);
  assert.ok(items.some(x => x.key === "inbox_revision_reason|proof_mismatch_or_wal_changed"));
  assert.doesNotMatch(JSON.stringify(items), /sensitive-customer-identification/);
});

test("SSE lifecycle captures only coarse connection ages and redacted events", () => {
  for (const duration of [1000, 10000, 60000, 300000]) {
    recordSseLifecycle("opened");
    recordSseLifecycle("closed", duration);
  }
  recordSseLifecycle("redacted_change");
  recordSseLifecycle("personal-staff-identity");
  recordSseLifecycle("closed", "private-info");
  const keys = snapshot().counters.map(x => x.key);
  for (const key of [
    "sse|opened", "sse|closed|under_10s", "sse|closed|under_60s",
    "sse|closed|under_5min", "sse|closed|5min_plus",
    "sse|redacted_change",
  ]) assert.ok(keys.includes(key), key);
  assert.doesNotMatch(keys.join(" "), /private-info|personal-staff-identity/);
});

test("Inbox SSE cleanup follows the outbound response, not incoming request completion", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"), "utf8");
  const start = source.indexOf('router.get("/events", (req, res) => {');
  const end = source.indexOf('router.get("/:contactId/messages"', start);
  const eventRoute = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(eventRoute, /res\.once\("close", finishStream\)/);
  assert.doesNotMatch(eventRoute, /req\.(on|once)\("close"/);
  assert.match(eventRoute, /recordSseLifecycle\("opened"\)/);
  assert.match(eventRoute, /recordSseLifecycle\("closed", Date\.now\(\) - openedAt\)/);
});

test("live SSE route survives request close, sends updates and unregisters only on response close", () => {
  const { EventEmitter } = require("node:events");
  const router = require("../src/routes/conversations");
  const realtimeEvents = require("../src/utils/realtimeEvents");
  const route = router.stack.find(layer => layer.route?.path === "/events" &&
    layer.route.methods.get);
  assert.ok(route, "SSE route must be registered");
  const serve = route.route.stack.at(-1).handle;

  function openStream(restricted = false) {
    const req = new EventEmitter();
    req.user = { id: 21, username: "test-staff",
      realtimeAccess: restricted ? { contactIds: [71], leadIds: null } : null };
    const res = new EventEmitter();
    res.req = req;
    res.destroyed = false;
    res.writableEnded = false;
    res.statusCode = 200;
    res.headers = {};
    res.chunks = [];
    res.status = function (code) { this.statusCode = code; return this; };
    res.set = function (headers) { Object.assign(this.headers, headers); return this; };
    res.flushHeaders = function () {};
    res.write = function (chunk) { this.chunks.push(chunk); return true; };
    serve(req, res);
    return { req, res };
  }

  // A completed incoming GET must not end a still-live response stream.
  const first = openStream();
  try {
    assert.equal(first.res.statusCode, 200);
    assert.match(first.res.headers["Content-Type"], /text\/event-stream/);
    first.req.emit("close");
    realtimeEvents.publish("conversation_changed", { reason: "message", contactId: 71 });
    assert.ok(first.res.chunks.some(x => x.includes('event: conversation_changed')),
      "client still receives new events after the incoming request is complete");
  } finally {
    first.res.emit("close");
  }
  const previous = first.res.chunks.length;
  realtimeEvents.publish("conversation_changed", { reason: "message", contactId: 71 });
  assert.equal(first.res.chunks.length, previous, "closed response must unsubscribe");

  // The next connection must still receive events; restricted staff receive
  // only a redacted refresh signal, never a contact ID.
  const reconnect = openStream(true);
  try {
    realtimeEvents.publish("conversation_changed", { reason: "message", contactId: 71 });
    const event = reconnect.res.chunks.filter(x => x.includes('event: conversation_changed')).at(-1);
    assert.match(event, /data: \{\}/);
    assert.doesNotMatch(event, /contactId/);
  } finally {
    reconnect.res.emit("close");
  }
});
