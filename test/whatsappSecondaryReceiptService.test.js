"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const receipt = require("../src/services/whatsappSecondaryReceiptService");

const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_WABA_ID: "200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "100000000000002",
  WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
  WHATSAPP_APP_SECRET: "test-meta-app-secret",
};
function status(overrides = {}) {
  return {
    id: "wamid.ariel-one", recipient_id: "60125550000",
    status: "delivered", timestamp: "1792656000",
    pricing: { type: "free_entry_point", billable: false, category: "service" },
    ...overrides,
  };
}
function body(statuses = [status()], overrides = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "200000000000002", changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: "100000000000002" },
        statuses,
      },
    }] }],
    ...overrides,
  };
}
function signed(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    signatureHeader: "sha256=" + crypto.createHmac("sha256",env.WHATSAPP_APP_SECRET)
      .update(rawBody).digest("hex"),
  };
}

test("receipt stage stays disabled without explicit safe configuration", async () => {
  const attempted = await receipt.recordSignedSecondaryStatusBatch(signed(body()), {
    env: { ...env, WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "false" },
    database: { connect: async () => { throw Error("must not access database"); } },
  });
  assert.equal(attempted.code,"secondary_receipts_disabled");
});

test("signed callbacks are validated against the original raw payload", async () => {
  const packet = signed(body());
  assert.equal(receipt.validateMetaSignature(
    packet.rawBody, packet.signatureHeader, env.WHATSAPP_APP_SECRET),true);
  assert.equal(receipt.validateMetaSignature(
    Buffer.from("tampered"),packet.signatureHeader,env.WHATSAPP_APP_SECRET),false);
  assert.equal(receipt.validateMetaSignature(packet.rawBody,"sha256=bad",env.WHATSAPP_APP_SECRET),false);
  assert.equal(receipt.validateMetaSignature(packet.rawBody,"",env.WHATSAPP_APP_SECRET),false);
  assert.equal(receipt.validateMetaSignature(packet.rawBody,packet.signatureHeader,""),false);
});

test("mixed Neutro and Ariel callbacks refuse the entire batch before DB mutation", async () => {
  const mixed = body();
  mixed.entry.push({
    id: "200000000000001", changes: [{
      field: "messages",
      value: { metadata: { phone_number_id: "100000000000001" }, statuses: [status()] },
    }],
  });
  assert.equal(receipt.normalizedSignedEvents(signed(mixed).rawBody,env),null);
  const result=await receipt.recordSignedSecondaryStatusBatch(signed(mixed),{
    env, database: { connect: async () => { throw Error("must not connect"); } },
  });
  assert.equal(result.code,"secondary_receipt_batch_invalid");
});

test("malformed or message-bearing status batches are rejected",()=>{
  for(const mutate of [
    x=>{x.entry[0].changes[0].value.messages=[{id:"evil"}];},
    x=>{x.entry[0].changes[0].field="smb_message_echoes";},
    x=>{x.entry[0].changes[0].value.statuses[0].recipient_id="";},
    x=>{x.entry[0].changes[0].value.statuses[0].status="recalled";},
    x=>{x.entry[0].changes[0].value.metadata.phone_number_id="100000000000001";},
    x=>{x.entry[0].changes[0].value.statuses[0].pricing.billable="false";},
    x=>{x.entry[0].changes[0].value.statuses[0].pricing.type="unacceptable ;";},
  ]) {
    const input=body();
    mutate(input);
    assert.equal(receipt.normalizedSignedEvents(signed(input).rawBody,env),null);
  }
});


test("receipt rejections identify only safe validation categories without touching Neon",async()=>{
 const samples=[
   [x=>{x.entry[0].changes[0].value.statuses[0].id="wamid.bad?identifier";},"status_id_invalid"],
   [x=>{x.entry[0].changes[0].value.statuses[0].status="unknown";},"status_value_unsupported"],
   [x=>{x.entry[0].changes[0].value.statuses[0].recipient_id="unsafe recipient?";},"status_recipient_invalid"],
   [x=>{x.entry[0].changes[0].value.statuses[0].timestamp="not-a-time";},"status_timestamp_invalid"],
   [x=>{x.entry[0].changes[0].value.statuses[0].pricing.billable="false";},"status_pricing_invalid"],
   [x=>{x.entry[0].id="other-account";},"mixed_sender_or_status_mismatch"],
 ];
 for(const [mutate,reason] of samples){
   const input=body();
   mutate(input);
   const result=await receipt.recordSignedSecondaryStatusBatch({
     ...signed(input),subsetFromVerifiedWebhook:true
   },{env,database:{connect:async()=>{throw Error("invalid status cannot access Neon");}}});
   assert.equal(result.accepted,false);
   assert.equal(result.code,"secondary_receipt_batch_invalid");
   assert.equal(result.reason,reason);
   assert.match(result.reason,/^[a-z_]+$/);
   assert.equal(JSON.stringify(result).includes("wamid"),false);
   assert.equal(JSON.stringify(result).includes("hidden"),false);
 }
});
test("unrelated signed primary statuses are ignored without opening a secondary DB connection",async()=>{
 const original=body();
 original.entry[0].id=env.WHATSAPP_WABA_ID;
 original.entry[0].changes[0].value.metadata.phone_number_id=env.WHATSAPP_PHONE_NUMBER_ID;
 const result=await receipt.recordSignedSecondaryStatusBatch({
   ...signed(original),subsetFromVerifiedWebhook:true
 },{env,database:{connect:async()=>{throw Error("primary-only callback must not access Neon");}}});
 assert.equal(result.accepted,true);
 assert.equal(result.matched,0);
});

test("a valid signed status has business identity and no implicit send permission",()=>{
  const updates = receipt.normalizedSignedEvents(signed(body()).rawBody,env);
  assert.equal(updates.length,1);
  assert.equal(updates[0].wamid,"wamid.ariel-one");
  assert.equal(updates[0].pricingBillable,false);
  assert.equal(updates[0].phoneId,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  assert.equal(updates[0].accountId,env.WHATSAPP_SECONDARY_WABA_ID);
  assert.match(updates[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/mc\.conversation_id=sc\.id/);
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/a\.wamid=\$1/);
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/sa\.meta_account_id=\$5/);
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/sc\.customer_wa_id=\$2/);
});

test("mixed signed webhook selects only Ariel statuses without exposing Neutro callbacks", () => {
  const mixed=body();
  mixed.entry.unshift({
    id: env.WHATSAPP_WABA_ID,
    changes: [{field:"messages",value:{
      metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},
      statuses:[status({id:"wamid.neutro-one",recipient_id:"60123333333"})],
    }}],
  });
  const event=receipt.normalizedSecondarySubsetEvents(signed(mixed).rawBody,env);
  assert.equal(event.length,1);
  assert.equal(event[0].wamid,"wamid.ariel-one");
  assert.equal(event[0].accountId,env.WHATSAPP_SECONDARY_WABA_ID);
  assert.equal(event[0].phoneId,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
});

test("mixed webhook rejects any Ariel status with a mismatched Meta phone or account", () => {
  const one=body();one.entry[0].changes[0].value.metadata.phone_number_id=env.WHATSAPP_PHONE_NUMBER_ID;
  assert.equal(receipt.normalizedSecondarySubsetEvents(signed(one).rawBody,env),null);
  const two=body();two.entry[0].id=env.WHATSAPP_WABA_ID;
  assert.equal(receipt.normalizedSecondarySubsetEvents(signed(two).rawBody,env),null);
  const noStatus=body();delete noStatus.entry[0].changes[0].value.statuses;
  assert.deepEqual(receipt.normalizedSecondarySubsetEvents(signed(noStatus).rawBody,env),[]);
});

test("the signed mixed webhook cannot bypass the original raw-body signature check",async()=>{
  const packet=signed(body());
  packet.rawBody=Buffer.from(packet.rawBody.toString("utf8").replace("delivered","failed"));
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...packet,subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>{throw Error("not allowed to connect");}}});
  assert.equal(result.code,"secondary_receipt_signature_invalid");
});


test("shared WABA callbacks still distinguish sender by verified phone ID",()=>{
  const shared={...env,WHATSAPP_WABA_ID:env.WHATSAPP_SECONDARY_WABA_ID};
  const data=body();
  data.entry[0].changes.unshift({
    field:"messages",value:{
      metadata:{phone_number_id:shared.WHATSAPP_PHONE_NUMBER_ID},
      statuses:[status({id:"wamid.primary-other"})],
    },
  });
  const updates=receipt.normalizedSecondarySubsetEvents(signed(data).rawBody,shared);
  assert.equal(updates.length,1);
  assert.equal(updates[0].wamid,"wamid.ariel-one");
  assert.equal(updates[0].phoneId,shared.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
});

// Real Meta receipt regression: the original QA delivery WAMID was padded.
// Signature, exact secondary identity, and malformed-ID rejection stay strict.
test("genuine padded Meta WAMIDs are accepted only with signed secondary identity",()=>{
  const valid = [
    "wamid.HBgMNjAxMjY0OTk3MTgVAgABAA==",
    "wamid.AB+/cd_:-09=",
    "wamid."+"a".repeat(448)+"=="
  ];
  for (const id of valid) {
    const packet=signed(body([status({id})]));
    const original=receipt.normalizedSignedEvents(packet.rawBody,env);
    const subset=receipt.normalizedSecondarySubsetEvents(packet.rawBody,env);
    assert.equal(original?.length,1,id);
    assert.equal(subset?.length,1,id);
    assert.equal(original[0].wamid,id);
    assert.equal(subset[0].wamid,id);
    assert.equal(receipt.validateMetaSignature(packet.rawBody,packet.signatureHeader,env.WHATSAPP_APP_SECRET),true);
    assert.equal(receipt.validateMetaSignature(
      Buffer.from(packet.rawBody.toString().replace("delivered","failed")),
      packet.signatureHeader,env.WHATSAPP_APP_SECRET),false);
  }
  for (const id of [
    "wamid.A=B","wamid.A===B","wamid.abc===",
    "wamid.abc?","wamid.abc\\nvalue","wamid."+"a".repeat(449)+"=="
  ]) {
    assert.equal(receipt.normalizedSignedEvents(signed(body([status({id})])).rawBody,env),null,id);
  }
  const wrong=body([status({id:valid[0]})]);
  wrong.entry[0].changes[0].value.metadata.phone_number_id=env.WHATSAPP_PHONE_NUMBER_ID;
  assert.equal(receipt.normalizedSecondarySubsetEvents(signed(wrong).rawBody,env),null);
});


test("signed secondary receipt reconciles only its own sender billing gate and audits image receipts",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const s=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryReceiptService.js"),"utf8");
 assert.match(s,/const reconciledContactIds = new Set\(\)/);
 assert.match(s,/reconciledContactIds\.add\(Number\(attempt\.contact_id\)\)/);
 assert.match(s,/wakeAfterVerifiedReconciliation\(\{contactIds:\[\.\.\.reconciledContactIds\],database,env\}\)/);
 assert.match(s,/AS secondary_media_inbound_id/);
 assert.match(s,/\.reconcileSecondaryMediaAudit\(\{inboundMessageIds:mediaInbounds,database,env\}\)/);
});

test("verified E.164 +recipient normalizes only to the same numeric customer ID",()=>{
  const normalized=receipt.normalizeStatusRecipient("+60125550000");
  assert.deepEqual(normalized,{recipient:"60125550000",verified:true});
  const packet=signed(body([status({recipient_id:"+60125550000"})]));
  const event=receipt.normalizedSignedEvents(packet.rawBody,env)[0];
  assert.equal(event.recipient,"60125550000");
  assert.equal(event.recipientVerified,true);
  assert.equal(receipt.normalizeStatusRecipient("60125550000").verified,true);
});

test("masked Meta recipient is never treated as a verified customer",()=>{
  const opaque=receipt.normalizeStatusRecipient("hidden");
  assert.deepEqual(opaque,{recipient:"hidden",verified:false});
  assert.equal(receipt.normalizeStatusRecipient("unsafe recipient?"),null);
  assert.equal(receipt.normalizeStatusRecipient(""),null);
  assert.equal(receipt.normalizeStatusRecipient({id:"60125550000"}),null);
  assert.equal(receipt.normalizeStatusRecipient("a".repeat(65)),null);
  const unsigned=receipt.normalizedSignedEvents(signed(body([
    status({recipient_id:"hidden"}),
  ])).rawBody,env);
  assert.equal(unsigned[0].recipientVerified,false);
});

test("signed opaque recipient is durably held unmatched with no billing release, delivery update or auto retry",async()=>{
  const calls=[];
  const client={
    query:async (sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return{rows:[{id:7}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_status_receipts")) {
        assert.equal(params[2],null);
        assert.equal(params[3],null);
        assert.equal(params[12],false);
        return {rows:[{fingerprint:params[0]}],rowCount:1};
      }
      if(sql.includes("MATCH_SECONDARY_ATTEMPT_SQL") ||
         sql.includes("JOIN whatsapp_sender_message_context") ||
         sql.includes("UPDATE messages"))assert.fail("opaque recipient must never resolve a contact");
      return {rows:[],rowCount:1};
    },
    release:()=>{},
  };
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...signed(body([status({recipient_id:"hidden"})])),
    subsetFromVerifiedWebhook:true,
  },{
    env,database:{connect:async()=>client},
  });
  assert.equal(result.accepted,true);
  assert.equal(result.matched,0);
  assert.equal(result.unmatched,1);
  assert.equal(result.autoRetryAllowed,false);
  assert.equal(result.sendAuthorized,false);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_status_receipts")).length,1);
  assert.equal(calls.filter(x=>x.sql==="COMMIT").length,1);
  assert.equal(calls.filter(x=>x.sql.includes("UPDATE whatsapp_sender_billing_gates")).length,0);
});

test("wrong sender identity and unverified HMAC still reject opaque receipt before DB",async()=>{
  const event=body([status({recipient_id:"hidden"})]);
  event.entry[0].changes[0].value.metadata.phone_number_id="100000000000099";
  const payload=signed(event);
  const fakeDb={connect:async()=>assert.fail("no unverified status can touch DB")};
  const wrongSender=await receipt.recordSignedSecondaryStatusBatch({
    ...payload,subsetFromVerifiedWebhook:true,
  },{env,database:fakeDb});
  assert.equal(wrongSender.accepted,false);
  const invalidSignature=await receipt.recordSignedSecondaryStatusBatch({
    rawBody:payload.rawBody,signatureHeader:"sha256=invalid",
    subsetFromVerifiedWebhook:true,
  },{env,database:fakeDb});
  assert.equal(invalidSignature.accepted,false);
});
