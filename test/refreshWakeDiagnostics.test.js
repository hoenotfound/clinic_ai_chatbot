"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
