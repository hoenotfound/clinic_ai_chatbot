"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { partitionLegacyWhatsAppWebhook } = require("../src/services/whatsappLegacySenderBoundary");
const whatsapp = require("../src/services/whatsappService");

const NEUTRO = "100000000000001";
const ARIEL = "100000000000002";

function event(phone, id) {
  return {
    field: "messages",
    value: {
      metadata: { phone_number_id: phone },
      contacts: [{ wa_id: "60135550000", profile: { name: "Synthetic customer" } }],
      messages: [{
        id, from: "60135550000", type: "text",
        text: { body: "Hi" },
      }],
    },
  };
}
function payload(...changes) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "200000000000001", changes }],
  };
}

function webhookHarness({ failAudit = false } = {}) {
  let handler = null;
  const claims = [];
  const scheduled = [];
  const audits = [];
  const replies = [];

  // Execute the real route definition, with signed-body middleware and every
  // side effect replaced by deterministic in-memory test doubles. This tests
  // the actual HTTP acknowledgement order without sending any real messages.
  const source = fs.readFileSync(require.resolve("../src/createApp"), "utf8");
  const start = source.indexOf('  app.post("/webhook", webhookJsonParser,');
  const end = source.indexOf('  app.get("/meta-webhook"', start);
  assert.ok(start >= 0 && end > start, "webhook route must be found");
  const route = source.slice(start, end);
  const noop = () => Promise.resolve();
  const context = {
    app: { post(_path, _parser, cb) { handler = cb; } },
    webhookJsonParser: () => {},
    whatsapp,
    partitionLegacyWhatsAppWebhook,
    process: { env: {
      WHATSAPP_PHONE_NUMBER_ID: NEUTRO,
      WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED: "false",
      WHATSAPP_SINGLE_SENDER_STRICT_METADATA: "false",
    } },
    recordQuarantinedWhatsAppChanges: async (items) => {
      audits.push(items);
      if (failAudit) throw new Error("synthetic quarantine DB unavailable");
      return items.length;
    },
    notifyWhatsAppSenderQuarantine: async () => true,
    whatsappCoexistence: {
      summarizePassiveSync: () => ({ historyChunks: 0, appStateItems: 0 }),
      beginPendingAiForEcho() {},
      releasePendingAiForEcho() {},
      persistBusinessAppEcho: async () => null,
      finalizeBusinessAppEcho: noop,
    },
    storeDeliveryStatusUpdates: async () => [],
    durablyClaimIncoming: async (number, inbound) => {
      claims.push({ number, inbound });
      return { id: claims.length };
    },
    scheduleDurableClaim: async (key, claim) => {
      scheduled.push({ key, claim });
    },
    messagesRepo: { applyWhatsappReaction: async () => null },
    realtimeEvents: { publish() {} },
    setupStatusRepo: { recordWebhook: noop },
    processStoredDeliveryStatuses: noop,
    console: { warn() {}, error() {}, log() {} },
  };
  vm.runInNewContext(route, context, { timeout: 2000 });
  assert.equal(typeof handler, "function");
  return {
    claims, audits, scheduled, replies,
    async send(body) {
      const response = {
        statusCode: null,
        sendStatus(code) {
          this.statusCode = code;
          replies.push(code);
          return this;
        },
      };
      await handler({ body }, response);
      await new Promise(resolve => setImmediate(resolve));
      return response.statusCode;
    },
  };
}

test("mixed callback accepts genuine Neutro inbound despite quarantine database failure", async () => {
  const h = webhookHarness({ failAudit: true });
  const status = await h.send(payload(event(ARIEL, "wamid.foreign"), event(NEUTRO, "wamid.valid")));
  assert.equal(status, 200);
  assert.equal(h.claims.length, 1);
  assert.equal(h.claims[0].inbound.id, "wamid.valid");
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.audits.length, 1);
});

test("foreign-only callback returns retryable 503 if quarantine is unavailable", async () => {
  const h = webhookHarness({ failAudit: true });
  const status = await h.send(payload(event(ARIEL, "wamid.foreign")));
  assert.equal(status, 503);
  assert.equal(h.claims.length, 0);
  assert.equal(h.audits.length, 1);
});

test("valid Neutro callback remains HTTP 200 with no quarantine writes", async () => {
  const h = webhookHarness({ failAudit: true });
  const status = await h.send(payload(event(NEUTRO, "wamid.valid")));
  assert.equal(status, 200);
  assert.equal(h.claims.length, 1);
  assert.equal(h.audits.length, 0);
});

test("foreign message plus only passive history requires a durable quarantine", async () => {
  const h = webhookHarness({ failAudit: true });
  const status = await h.send(payload(event(ARIEL, "wamid.foreign"), {
    field: "history", value: { history: [] },
  }));
  assert.equal(status, 503);
  assert.equal(h.claims.length, 0);
});

test("normal mixed callback persists the rejected-event audit and delivers only Neutro inbound", async () => {
  const h = webhookHarness();
  const status = await h.send(payload(event(ARIEL, "wamid.foreign"), event(NEUTRO, "wamid.valid")));
  assert.equal(status, 200);
  assert.equal(h.claims.length, 1);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0][0].reason, "different_business_phone");
});
