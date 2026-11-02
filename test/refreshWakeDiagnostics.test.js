"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordWorkerWake, recordInboxFullList, snapshot, classifyChannel } =
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
