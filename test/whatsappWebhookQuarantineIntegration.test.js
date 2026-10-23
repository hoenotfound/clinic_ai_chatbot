"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { partitionLegacyWhatsAppWebhook } = require("../src/services/whatsappLegacySenderBoundary");
const { partitionSecondaryInboxWebhook } = require("../src/services/whatsappSecondaryInboxBoundary");
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

function webhookHarness({ failAudit = false, dualInbox = false,
  receiptIngress = false, receiptFailure = false } = {}) {
  let handler = null;
  const claims = [];
  const scheduled = [];
  const audits = [];
  const replies = [];
  const receiptWrites = [];

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
    Buffer,
    whatsapp,
    partitionLegacyWhatsAppWebhook,
    partitionSecondaryInboxWebhook,
    process: { env: {
      WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: dualInbox ? "true" : "false",
      WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: receiptIngress ? "true" : "false",
      WHATSAPP_WABA_ID: "200000000000001",
      WHATSAPP_SECONDARY_PHONE_NUMBER_ID: ARIEL,
      WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
      WHATSAPP_PHONE_NUMBER_ID: NEUTRO,
      WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED: "false",
      WHATSAPP_SINGLE_SENDER_STRICT_METADATA: "false",
    } },
    recordSignedSecondaryStatusBatch: async (args) => {
      receiptWrites.push(args);
      return receiptFailure ? {accepted:false,code:"test_receipt_storage_failed"} :
        {accepted:true,matched:1};
    },
    recordQuarantinedWhatsAppChanges: async (items) => {
      audits.push(items);
      if (failAudit) throw new Error("synthetic quarantine DB unavailable");
      return items.length;
    },
    notifyWhatsAppSenderQuarantine: async () => true,
    coexistenceSync: {acceptPassiveSync: async()=>({enabled:false,staged:0})},
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
    claims, audits, scheduled, replies, receiptWrites,
    async send(body) {
      const response = {
        statusCode: null,
        sendStatus(code) {
          this.statusCode = code;
          replies.push(code);
          return this;
        },
      };
      await handler({
        body,
        whatsappSignedRawBody: Buffer.from(JSON.stringify(body)),
        headers: { "x-hub-signature-256": "sha256=synthetic" },
      }, response);
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

test("gated secondary Inbox-only route accepts two senders with independent queue keys",async()=>{
 const h=webhookHarness({dualInbox:true});
 const status=await h.send({object:"whatsapp_business_account",entry:[
   {id:"200000000000001",changes:[event(NEUTRO,"wamid-primary")]},
   {id:"200000000000002",changes:[event(ARIEL,"wamid-ariel")]},
 ]});
 assert.equal(status,200);
 assert.equal(h.claims.length,2);
 assert.equal(h.scheduled.length,2);
 assert.notEqual(h.scheduled[0].key,h.scheduled[1].key);
 assert.equal(h.audits.length,0);
 assert.deepEqual(h.claims.map(c=>c.inbound.businessPhoneNumberId),
  [NEUTRO,ARIEL]);
});
test("with secondary receiver disabled, Ariel remains quarantined and primary is unchanged",async()=>{
 const h=webhookHarness({dualInbox:false});
 const status=await h.send({object:"whatsapp_business_account",entry:[
   {id:"200000000000001",changes:[event(NEUTRO,"wamid-primary")]},
   {id:"200000000000002",changes:[event(ARIEL,"wamid-ariel")]},
 ]});
 assert.equal(status,200);
 assert.equal(h.claims.length,1);
 assert.equal(h.claims[0].inbound.id,"wamid-primary");
 assert.equal(h.scheduled[0].key,"60135550000");
 assert.equal(h.audits.length,1);
});

test("verified Ariel status staging precedes acknowledgement and does not reach Neutro status queue",async()=>{
  const h=webhookHarness({dualInbox:true,receiptIngress:true});
  const response=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary")]},
    {id:"200000000000002",changes:[{
      field:"messages",value:{
        metadata:{phone_number_id:ARIEL},
        statuses:[{id:"wamid.ariel-status",status:"delivered",recipient_id:"60135550000"}],
      },
    }]},
  ]});
  assert.equal(response,200);
  assert.equal(h.receiptWrites.length,1);
  assert.equal(h.receiptWrites[0].subsetFromVerifiedWebhook,true);
  assert.equal(h.claims.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary");
  assert.equal(h.audits.length,0);
});

test("Ariel receipt storage failure returns 503 before accepting a mixed Neutro customer turn",async()=>{
  const h=webhookHarness({dualInbox:true,receiptIngress:true,receiptFailure:true});
  const response=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary")]},
    {id:"200000000000002",changes:[{
      field:"messages",value:{
        metadata:{phone_number_id:ARIEL},
        statuses:[{id:"wamid.ariel-status",status:"sent",recipient_id:"60135550000"}],
      },
    }]},
  ]});
  assert.equal(response,503);
  assert.equal(h.claims.length,0);
  assert.equal(h.receiptWrites.length,1);
});
