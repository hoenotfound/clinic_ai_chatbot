"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  enabled, configFromEnv, partitionDefaultBatch, recordAuditBatch,
  dispatchDefaultWebhook
} = require("../src/services/whatsappPaidDefaultIngress");

function env(overrides = {}) {
  return {
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED: "true",
    WHATSAPP_APP_SECRET: "A".repeat(32),
    META_APP_SECRET: "A".repeat(32),
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN: "B".repeat(32),
    WHATSAPP_WABA_ID: "1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164: "+601130535053",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164: "+60123456789",
    DATABASE_URL: "postgresql://p:password@ep-production.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://q:password@ep-isolated.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:
      "ep-isolated.ap-southeast-1.aws.neon.tech",
    ...overrides
  };
}
function message(account, phone, field = "messages") {
  return {
    id: account, time: 1790591000,
    changes: [{ field, value: {
      metadata: { phone_number_id: phone },
      messages: [{ id: "wamid.100", from: "60121111111", text: { body: "hi" } }]
    } }]
  };
}
function lifecycle(account, phone, event = "PARTNER_REMOVED") {
  return {
    id: account, time: 1790591000,
    changes: [{ field: "account_update", value: {
      event, ...(phone == null ? {} : { phone_number: phone })
    } }]
  };
}
function batch(...entries) {
  return { object: "whatsapp_business_account", entry: entries };
}
function fakeResponse() {
  return {
    code: null,
    sendStatus(code) { this.code = code; return this; }
  };
}

test("default router is OFF unless explicitly enabled", () => {
  assert.equal(enabled({}), false);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED: "false"
  })), /disabled/);
});
test("QA Neon must have separate pinned host, correct app secret and zero outbound", () => {
  assert.equal(configFromEnv(env()).primaryWaba, "1593376338308612");
  assert.throws(() => configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST: "ep-unknown.neon.tech"
  })), /pinned/);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL: env().DATABASE_URL,
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:
      "ep-production.ap-southeast-1.aws.neon.tech"
  })), /separate/);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164: "+601130535053"
  })), /independently pinned/);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164: "+60174831336"
  })), /independently pinned/);
  assert.throws(() => configFromEnv(env({
    META_APP_SECRET: "C".repeat(32)
  })), /verification/);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true"
  })), /outbound/);
  assert.throws(() => configFromEnv(env({
    WHATSAPP_SECONDARY_WABA_ID: "99123"
  })), /Bootstrap-only/);
});
test("Neutro messages remain primary-only after verified WABA plus phone", () => {
  const config = configFromEnv(env());
  const data = batch(message(config.primaryWaba, config.primaryPhoneId));
  const plan = partitionDefaultBatch(data, config);
  assert.deepEqual(plan.primary, data);
  assert.equal(plan.audits.length, 0);
});
test("multi-account signed batch is split without forwarding QA data into Neutro", () => {
  const config = configFromEnv(env());
  const plan = partitionDefaultBatch(batch(
    lifecycle(config.primaryWaba, config.primaryE164),
    message(config.primaryWaba, config.primaryPhoneId),
    lifecycle("777123", config.qaE164, "PARTNER_ADDED")
  ), config);
  assert.equal(plan.primary.entry.length, 1);
  assert.equal(plan.primary.entry[0].changes[0].field, "messages");
  assert.equal(plan.audits.length, 2);
  assert.deepEqual(plan.audits.map(a => a.kind), ["primary", "preidentity"]);
  assert.equal(plan.audits[1].accountId, "777123");
});
test("Neutro lifecycle can be account-bound without a phone number", () => {
  const config = configFromEnv(env());
  const plan = partitionDefaultBatch(
    batch(lifecycle(config.primaryWaba, null)), config
  );
  assert.equal(plan.primary, null);
  assert.equal(plan.audits[0].phone, null);
});
test("unknown WA account, missing phone, wrong WABA and unsupported fields fail closed", () => {
  const config = configFromEnv(env());
  const foreign = batch(message("777123", "101"));
  const wrongPhone = batch(message(config.primaryWaba, "101"));
  const missingPhone = batch(message(config.primaryWaba, undefined));
  const wrongLifecycle = batch(lifecycle("777123", "+60119998888"));
  const missingLifecycle = batch(lifecycle("777123", null));
  const unknownField = batch(message(config.primaryWaba, config.primaryPhoneId, "message_template_status_update"));
  const mutatedAccount = batch(lifecycle(config.primaryWaba, "+60119998888"));
  for (const input of [
    foreign, wrongPhone, missingPhone, wrongLifecycle, missingLifecycle,
    unknownField, mutatedAccount, batch()
  ]) {
    assert.throws(() => partitionDefaultBatch(input, config));
  }
});
test("malformed or excessive Meta batches cannot partially commit", () => {
  const config = configFromEnv(env());
  const input = batch(
    lifecycle("777123", config.qaE164),
    { id: "999", changes: [{ field: "messages", value: {} }] }
  );
  assert.throws(() => partitionDefaultBatch(input, config));
  assert.throws(() => partitionDefaultBatch(batch({
    id: config.primaryWaba, time: -1, changes: [{ field: "account_update", value: {
      event: "PARTNER_REMOVED"
    } }]
  }), config));
  assert.throws(() => partitionDefaultBatch(batch({
    id: config.primaryWaba, changes: Array.from({ length: 201 }, () => ({
      field: "account_update", value: { event: "PARTNER_REMOVED" }
    }))
  }), config));
});
function mockDatabase({ fail = false, duplicate = false, wrongSchema = false } = {}) {
  const queries = [];
  let releases = 0;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT version")) {
        return { rows: wrongSchema ? [] : [
          { version: 102, name: "whatsapp_coexistence_preidentity_events" },
          { version: 103, name: "whatsapp_legacy_lifecycle_relay_audit" },
          { version: 104, name: "whatsapp_coexistence_once_only_and_lifecycle_alerts" }
        ] };
      }
      if (fail && sql.startsWith("INSERT")) throw new Error("QA DB failed");
      return { rowCount: duplicate ? 0 : 1 };
    },
    release() { releases++; }
  };
  return { queries, get releases() { return releases; }, async connect() { return client; } };
}
test("QA audit commits idempotent primary and preidentity events in one transaction", async () => {
  const config = configFromEnv(env());
  const { audits } = partitionDefaultBatch(batch(
    lifecycle(config.primaryWaba, config.primaryE164),
    lifecycle("777123", config.qaE164)
  ), config);
  const db = mockDatabase();
  const result = await recordAuditBatch(audits, config, db);
  assert.deepEqual(result, { durable: true, inserted: 2 });
  assert.equal(db.queries[0].sql, "BEGIN");
  assert.equal(db.queries.at(-1).sql, "COMMIT");
  assert.equal(db.queries.some(q => q.sql.includes("whatsapp_coexistence_preidentity_events")), true);
  assert.equal(db.queries.some(q => q.sql.includes("whatsapp_pr395_legacy_lifecycle_alerts")), true);
  assert.equal(db.releases, 1);
  const duplicateDb = mockDatabase({ duplicate: true });
  const again = await recordAuditBatch(audits, config, duplicateDb);
  assert.equal(again.inserted, 0);
});
test("QA transaction failure rolls back and never writes to production", async () => {
  const config = configFromEnv(env());
  const { audits } = partitionDefaultBatch(batch(lifecycle("777123", config.qaE164)), config);
  for (const db of [mockDatabase({ fail: true }), mockDatabase({ wrongSchema: true })]) {
    await assert.rejects(recordAuditBatch(audits, config, db));
    assert.equal(db.queries.at(-1).sql, "ROLLBACK");
    assert.equal(db.releases, 1);
  }
});
test("router acknowledges only durable audit-only batches", async () => {
  const config = env();
  const req = { body: batch(lifecycle("777123", config.WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164)) };
  const res = fakeResponse();
  let primaryCalls = 0;
  await dispatchDefaultWebhook(req, res, () => { primaryCalls++; }, {
    env: config, persist: async () => ({ durable: true })
  });
  assert.equal(res.code, 200);
  assert.equal(primaryCalls, 0);
  await assert.rejects(dispatchDefaultWebhook(
    { body: req.body }, fakeResponse(), () => { primaryCalls++; },
    { env: config, persist: async () => ({ durable: false }) }
  ));
  assert.equal(primaryCalls, 0);
});
test("only confirmed primary payload reaches the exact existing handler", async () => {
  const e = env();
  const req = { body: batch(
    lifecycle("777123", e.WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164),
    message(e.WHATSAPP_WABA_ID, e.WHATSAPP_PHONE_NUMBER_ID)
  ) };
  const res = fakeResponse();
  const order = [];
  await dispatchDefaultWebhook(req, res, async (r, response) => {
    order.push("neutro");
    assert.equal(r.body.entry.length, 1);
    assert.equal(r.body.entry[0].id, e.WHATSAPP_WABA_ID);
    assert.equal(r.body.entry[0].changes[0].field, "messages");
    response.sendStatus(200);
  }, {
    env: e, persist: async () => { order.push("qa-commit"); return { durable: true }; }
  });
  assert.deepEqual(order, ["qa-commit", "neutro"]);
  assert.equal(res.code, 200);
});
test("bad QA commit prevents Neutro handler dispatch for mixed account batch", async () => {
  const e = env();
  let primary = 0;
  await assert.rejects(dispatchDefaultWebhook({
    body: batch(lifecycle("777123", e.WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164),
      message(e.WHATSAPP_WABA_ID, e.WHATSAPP_PHONE_NUMBER_ID))
  }, fakeResponse(), () => { primary++; }, {
    env: e, persist: async () => { throw new Error("QA unavailable"); }
  }), /QA unavailable/);
  assert.equal(primary, 0);
});
test("routing uses existing signed 2 MB parser and leaves original /webhook intact", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/createApp.js"), "utf8");
  assert.match(source, /app\.post\("\/webhook", webhookJsonParser, primaryWhatsappWebhookHandler/);
  assert.match(source, /app\.post\("\/whatsapp\/default",/);
  assert.match(source, /}, webhookJsonParser, async \(req, res\) => \{/);
  assert.match(source, /dispatchDefaultWebhook\(\s*req, res, primaryWhatsappWebhookHandler/);
  assert.match(source, /app\.get\("\/whatsapp\/default"/);
  assert.ok(source.indexOf('app.post("/webhook"') <
            source.indexOf('app.post("/whatsapp/default"'));
  assert.doesNotMatch(source, /https:\/\/clinic-ai-chatbot\.onrender\.com/);
});
