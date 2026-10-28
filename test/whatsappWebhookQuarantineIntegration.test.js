"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { partitionLegacyWhatsAppWebhook } = require("../src/services/whatsappLegacySenderBoundary");
const { partitionSecondaryInboxWebhook } = require("../src/services/whatsappSecondaryInboxBoundary");
const { extractSecondaryLifecycle } = require("../src/services/whatsappCoexistenceAccountUpdateService");
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
  receiptIngress = false, receiptFailure = false, historyFailure = false,
  echoFailure = false, secondaryInboundFailure = false, secondaryInboundHang = false,
  secondaryInboundLate = false, receiptHang = false, historyHang = false, echoHang = false,
  echoLate = false,
  lifecycleFailure = false } = {}) {
  let handler = null;
  const claims = [];
  const scheduled = [];
  const audits = [];
  const replies = [];
  const receiptWrites = [];
  const lifecycleWrites = [];
  const pendingEchoes = new Set();
  const finalizedEchoes = [];

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
    app: {
      get(_path, ...handlers) {},
      post(_path, ...middlewareAndHandler) {
        if (_path === "/webhook") handler = middlewareAndHandler[middlewareAndHandler.length - 1];
      }
    },
    webhookJsonParser: () => {},
    stagingWebhookGuard: (_req, _res, next) => next(),
    Buffer, setTimeout, clearTimeout,
    whatsapp,
    partitionLegacyWhatsAppWebhook,
    partitionSecondaryInboxWebhook,
    extractSecondaryLifecycle,
    persistSecondaryLifecycle: async (events) => {
      lifecycleWrites.push(events);
      if (lifecycleFailure) throw Error("synthetic lifecycle database failure");
      return { accepted: true, count: events.length };
    },
    process: { env: {
      WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: dualInbox ? "true" : "false",
      WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: receiptIngress ? "true" : "false",
      WHATSAPP_WABA_ID: "200000000000001",
      WHATSAPP_SECONDARY_PHONE_NUMBER_ID: ARIEL,
      WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
      WHATSAPP_SECONDARY_SENDER_KEY: "tcm_wellness",
      WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: "+60174831336",
      WHATSAPP_SECONDARY_WEBHOOK_WORK_TIMEOUT_MS: "100",
      WHATSAPP_PHONE_NUMBER_ID: NEUTRO,
      WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED: "false",
      WHATSAPP_SINGLE_SENDER_STRICT_METADATA: "false",
    } },
    recordSignedSecondaryStatusBatch: async (args) => {
      receiptWrites.push(args);
      if (receiptHang) return new Promise(() => {});
      return receiptFailure ? {accepted:false,code:"test_receipt_storage_failed"} :
        {accepted:true,matched:1};
    },
    recordQuarantinedWhatsAppChanges: async (items) => {
      audits.push(items);
      if (failAudit) throw new Error("synthetic quarantine DB unavailable");
      return items.length;
    },
    notifyWhatsAppSenderQuarantine: async () => true,
    coexistenceSync: {acceptPassiveSync: async()=>{
      if (historyHang) return new Promise(() => {});
      if (historyFailure) throw new Error("synthetic secondary history database outage");
      return {enabled:false,staged:0};
    }},
    whatsappCoexistence: {
      summarizePassiveSync: () => ({ historyChunks: 0, appStateItems: 0 }),
      beginPendingAiForEcho(echo) { pendingEchoes.add(echo.id); },
      releasePendingAiForEcho(echo) { pendingEchoes.delete(echo.id); },
      persistBusinessAppEcho: async (echo) => {
        if (echoHang) return new Promise(() => {});
        if (echoLate) await new Promise(resolve => setTimeout(resolve, 175));
        if (echoFailure) throw new Error("synthetic secondary echo database outage");
        pendingEchoes.delete(echo.id); // real persistence settles ownership
        return echoLate ? { contact: { id: 1 }, message: { id: 1 }, isNew: true } : null;
      },
      finalizeBusinessAppEcho: async (persisted) => {
        finalizedEchoes.push(persisted.message.id);
      },
    },
    storeDeliveryStatusUpdates: async () => [],
    durablyClaimIncoming: async (number, inbound) => {
      if (secondaryInboundHang && inbound.businessPhoneNumberId === ARIEL) {
        return new Promise(() => {});
      }
      if (secondaryInboundLate && inbound.businessPhoneNumberId === ARIEL) {
        await new Promise(resolve => setTimeout(resolve, 175));
      }
      if (secondaryInboundFailure && inbound.businessPhoneNumberId === ARIEL) {
        throw new Error("synthetic secondary contact database outage");
      }
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
    claims, audits, scheduled, replies, receiptWrites, lifecycleWrites, pendingEchoes, finalizedEchoes,
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

test("secondary receipt storage failure returns 503 for retry after scheduling Neutro",async()=>{
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
  assert.equal(h.claims.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary");
  assert.equal(h.scheduled.length,1);
  assert.equal(h.receiptWrites.length,1);
});

test("secondary history storage failure cannot postpone a mixed Neutro customer turn",async()=>{
  const h=webhookHarness({dualInbox:true,historyFailure:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-history")]},
    {id:"200000000000002",changes:[{
      field:"history",value:{metadata:{phone_number_id:ARIEL},history:[]},
    }]},
  ]});
  assert.equal(status,503,"Meta must retry secondary history, not silently discard it");
  assert.equal(h.claims.length,1);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary-history");
});

test("secondary incoming storage failure does not stop an unrelated Neutro message",async()=>{
  const h=webhookHarness({dualInbox:true,secondaryInboundFailure:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-contact")]},
    {id:"200000000000002",changes:[event(ARIEL,"wamid.secondary-contact")]},
  ]});
  assert.equal(status,503);
  assert.equal(h.claims.length,1);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary-contact");
});

test("secondary Business App echo persistence failure cannot stop a Neutro reply",async()=>{
  const h=webhookHarness({dualInbox:true,echoFailure:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-echo")]},
    {id:"200000000000002",changes:[{
      field:"smb_message_echoes",
      value:{metadata:{phone_number_id:ARIEL},message_echoes:[{
        id:"wamid.secondary-echo",from:"60174831336",to:"60135550000",
        type:"text",text:{body:"App staff reply"}
      }]}
    }]},
  ]});
  assert.equal(status,503);
  assert.equal(h.claims.length,1);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary-echo");
});

test("account_update lifecycle callback never becomes a customer message or AI turn", async()=>{
  const h=webhookHarness({dualInbox:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-lifecycle")]},
    {id:"200000000000002",changes:[{
      field:"account_update",value:{event:"PHONE_NUMBER_STATUS_UPDATE"},
    }]},
  ]});
  assert.equal(status,200);
  assert.equal(h.claims.length,1);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.claims[0].inbound.id,"wamid.primary-lifecycle");
  assert.equal(h.audits.length,1);
});

test("secondary inbound that never settles does not hold Neutro; primary queue is sender-specific", async () => {
  const h = webhookHarness({ dualInbox: true, secondaryInboundHang: true });
  const start = Date.now();
  const status = await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-stall")]},
    {id:"200000000000002",changes:[event(ARIEL,"wamid.secondary-stall")]},
  ]});
  assert.equal(status,503,"unknown secondary durability must be retried by Meta");
  assert.ok(Date.now()-start<1200,"primary must not wait indefinitely for the second number");
  assert.equal(h.claims.length,1);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.claims[0].number, `whatsapp:${NEUTRO}:60135550000`);
});

test("secondary billing receipt that stalls cannot postpone Neutro's reply", async () => {
  const h = webhookHarness({dualInbox:true,receiptIngress:true,receiptHang:true});
  const status = await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-receipt-hang")]},
    {id:"200000000000002",changes:[{
      field:"messages",value:{metadata:{phone_number_id:ARIEL},
      statuses:[{id:"wamid.receipt-hang",status:"sent",recipient_id:"60135550000"}]}
    }]}
  ]});
  assert.equal(status,503);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.receiptWrites.length,1);
});

test("secondary app echo that stalls cannot postpone Neutro's reply", async () => {
  const h = webhookHarness({dualInbox:true,echoHang:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-echo-hang")]},
    {id:"200000000000002",changes:[{
      field:"smb_message_echoes",value:{metadata:{phone_number_id:ARIEL},
      message_echoes:[{id:"wamid.echo-hang",from:"60174831336",to:"60135550000",
      type:"text",text:{body:"staff"}}]}
    }]}
  ]});
  assert.equal(status,503);
  assert.equal(h.scheduled.length,1);
});

test("secondary history that stalls cannot postpone Neutro's reply", async () => {
  const h = webhookHarness({dualInbox:true,historyHang:true});
  const status = await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-sync-hang")]},
    {id:"200000000000002",changes:[{
      field:"history",value:{metadata:{phone_number_id:ARIEL},history:[]}
    }]}
  ]});
  assert.equal(status,503);
  assert.equal(h.scheduled.length,1);
});

test("signed PARTNER_REMOVED lifecycle records sender disconnection without touching Neutro", async()=>{
  const h=webhookHarness({dualInbox:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-disconnect")]},
    {id:"200000000000002",changes:[{field:"account_update",
      value:{event:"PARTNER_REMOVED",phone_number:"+60 17-483 1336",
        disconnection_info:{reason:"ACCOUNT_DISCONNECTED"}}}]}
  ]});
  assert.equal(status,200);
  assert.equal(h.lifecycleWrites.length,1);
  assert.equal(h.lifecycleWrites[0][0].eventType,"PARTNER_REMOVED");
  assert.equal(h.scheduled.length,1);
  assert.equal(h.audits.length,0);
});

test("lifecycle database failure returns retryable 503 while Neutro continues",async()=>{
  const h=webhookHarness({dualInbox:true,lifecycleFailure:true});
  const status=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-lifecycle-fail")]},
    {id:"200000000000002",changes:[{field:"account_update",
      value:{event:"ACCOUNT_OFFBOARDED"}}]}
  ]});
  assert.equal(status,503);
  assert.equal(h.scheduled.length,1);
  assert.equal(h.lifecycleWrites.length,1);
});

test("secondary claim finishing after deadline still schedules the durable job once",async()=>{
  const h=webhookHarness({dualInbox:true,secondaryInboundLate:true});
  const response=await h.send({object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-late-commit")]},
    {id:"200000000000002",changes:[event(ARIEL,"wamid.secondary-late-commit")]}
  ]});
  assert.equal(response,503);
  assert.equal(h.scheduled.length,1,"Neutro starts independently after secondary timeout");
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(h.scheduled.length,2,"late-committed secondary message must still be scheduled");
  assert.notEqual(h.scheduled[0].key,h.scheduled[1].key);
});

test("a timed-out staff echo keeps the AI collision barrier until persistence actually settles",async()=>{
  const h=webhookHarness({dualInbox:true,echoLate:true});
  const body={object:"whatsapp_business_account",entry:[
    {id:"200000000000001",changes:[event(NEUTRO,"wamid.primary-collision")]},
    {id:"200000000000002",changes:[{field:"smb_message_echoes",value:{
      metadata:{phone_number_id:ARIEL},
      message_echoes:[{id:"wamid.staff-late",from:"60174831336",to:"60135550000",
        type:"text",text:{body:"staff reply"}}]
    }}]}
  ]};
  const status=await h.send(body);
  assert.equal(status,503);
  assert.ok(h.pendingEchoes.has("wamid.staff-late"),
    "Do not clear pending AI cancellation merely because the HTTP deadline expired");
  assert.equal(h.scheduled.length,1,"Neutro remains scheduled");
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(h.pendingEchoes.has("wamid.staff-late"),false);
  assert.equal(h.finalizedEchoes.length,1,
    "late-success echo still runs post-commit lifecycle bookkeeping");
});
test("an unresolved staff echo timeout remains protected against competing AI",async()=>{
  const h=webhookHarness({dualInbox:true,echoHang:true});
  const body={object:"whatsapp_business_account",entry:[{
    id:"200000000000002",changes:[{field:"smb_message_echoes",value:{
      metadata:{phone_number_id:ARIEL},
      message_echoes:[{id:"wamid.staff-stall",from:"60174831336",to:"60135550000",
        type:"text",text:{body:"staff reply"}}]
    }}]
  }]};
  assert.equal(await h.send(body),503);
  assert.ok(h.pendingEchoes.has("wamid.staff-stall"),
    "must fail closed while the DB operation is unresolved");
});
