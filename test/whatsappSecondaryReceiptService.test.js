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
   [x=>{x.entry[0].changes[0].value.statuses[0].status="unsafe state!";},"status_value_unsupported"],
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
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/sc\.customer_wa_id=c\.whatsapp_number/);
  assert.match(receipt.MATCH_SECONDARY_ATTEMPT_SQL,/a\.recipient_address=\$2/);
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
  assert.equal(receipt.normalizeStatusRecipient(" 60125550000 "),null);
  assert.equal(receipt.normalizeStatusRecipient("60125550000\n"),null);
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
        assert.equal(params[13],false);
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

test("verified invalid recipient receipts are durably quarantined without identifying or notifying customers",async()=>{
  const calls=[];
  const seen=new Set();
  const client={
    query: async (sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))
        return {rows:[{id:7}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_quarantined_events")){
        assert.match(params[0],/^[a-f0-9]{64}$/);
        assert.match(params[1],/^messages\.status_recipient_invalid\.(missing|null|non_string|blank|oversize|control|non_ascii|unrecognized_format)$/);
        assert.equal(params[2],env.WHATSAPP_SECONDARY_WABA_ID);
        assert.equal(params[3],env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
        const fresh=!seen.has(params[0]);seen.add(params[0]);
        return {rows:fresh?[{fingerprint:params[0]}]:[],rowCount:fresh?1:0};
      }
      if(sql.includes("INSERT INTO whatsapp_sender_billing_alarms")) {
        assert.equal(params[0],7);
        assert.match(params[1],/^[a-f0-9]{64}$/);
        return {rows:[],rowCount:1};
      }
      assert.doesNotMatch(sql,/JOIN whatsapp_sender_message_context|UPDATE messages|UPDATE whatsapp_sender_billing_gates|INSERT INTO whatsapp_sender_status_receipts|INSERT INTO whatsapp_sender_auto_reconciliations/);
      return {rows:[],rowCount:1};
    },
    release:()=>{},
  };
  const packet=body([
    status({id:"wamid.no-recipient",recipient_id:undefined}),
    status({id:"wamid.unsafe-recipient",recipient_id:"unsafe recipient?",pricing:{
      type:"regular",billable:true,category:"service",
    }}),
  ]);
  delete packet.entry[0].changes[0].value.statuses[0].recipient_id;
  const signature=signed(packet);
  // Direct public parser is still strict and never treats missing recipients as valid.
  assert.equal(receipt.normalizedSignedEvents(signature.rawBody,env),null);
  for(const expectation of [2,0]){
    const result=await receipt.recordSignedSecondaryStatusBatch({
      ...signature,subsetFromVerifiedWebhook:true,
    },{env,database:{connect:async()=>client}});
    assert.equal(result.accepted,true);
    assert.equal(result.matched,0);
    assert.equal(result.unmatched,0);
    assert.equal(result.quarantined || 0,expectation);
    assert.equal(result.held,expectation===2?1:0);
    assert.equal(result.sendAuthorized,false);
    assert.equal(result.autoRetryAllowed,false);
  }
  assert.equal(seen.size,2);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_quarantined_events")).length,4);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_billing_alarms")).length,1);
  assert.equal(calls.filter(x=>x.sql==="COMMIT").length,2);
  assert.ok(!JSON.stringify(calls.map(x=>x.sql)).includes("unsafe recipient?"));
});

test("unattributable receipt deduplicates across different Meta batch groupings",()=>{
  const invalid=status({
    id:"wamid.same-event-across-batches",
    recipient_id:"unsafe recipient?",
    status:"delivered",
  });
  const first=body([invalid]);
  const regrouped=body([
    status({id:"wamid.other-event",recipient_id:"60125550000"}),
    invalid,
    status({id:"wamid.played-other",status:"played"}),
  ]);
  const collect=(packet)=>{
    const results=[];
    const parsed=receipt.normalizedSecondarySubsetEvents(
      signed(packet).rawBody,env,()=>{},()=>{},value=>results.push(value));
    assert.ok(Array.isArray(parsed));
    return results;
  };
  const once=collect(first);
  const differentlyGrouped=collect(regrouped);
  assert.equal(once.length,1);
  assert.equal(differentlyGrouped.length,1);
  assert.equal(once[0].fingerprint,differentlyGrouped[0].fingerprint);
  assert.equal(once[0].wamidHash,differentlyGrouped[0].wamidHash);
  assert.match(once[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(once[0]).includes("unsafe recipient?"),false);
  const changedStatus=collect(body([status({
    id:"wamid.same-event-across-batches",
    recipient_id:"unsafe recipient?",
    status:"read",
  })]));
  assert.notEqual(once[0].fingerprint,changedStatus[0].fingerprint);
});

test("invalid recipient categories are bounded and do not expose identifier bytes",()=>{
  const samples=[
    [undefined,"missing"],[null,"null"],[2,"non_string"],["","blank"],
    ["x".repeat(65),"oversize"],["x\n","control"],["界","non_ascii"],
    ["a?b","unrecognized_format"],[" 60125550000 ","unrecognized_format"],
  ];
  for(const [value,kind] of samples){
    const input=body([status({recipient_id:value})]);
    if(value===undefined) delete input.entry[0].changes[0].value.statuses[0].recipient_id;
    assert.equal(receipt.normalizedSignedEvents(signed(input).rawBody,env),null);
    const records=[];
    const parsed=receipt.normalizedSecondarySubsetEvents(
      signed(input).rawBody,env,()=>{},()=>{},audit=>records.push(audit));
    assert.deepEqual(parsed,[]);
    assert.equal(records.length,1);
    assert.equal(records[0].field,"messages.status_recipient_invalid."+kind);
    assert.match(records[0].fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(records[0]).includes("a?b"),false);
  }
});

test("untrusted recipient batches still fail before touching the database",async()=>{
  const invalid=body([status({recipient_id:"?",timestamp:"invalid"})]);
  const wrong=body([status({recipient_id:"?"})]);
  wrong.entry[0].changes[0].value.metadata.phone_number_id="999999999999999";
  for(const input of [invalid,wrong]){
    const result=await receipt.recordSignedSecondaryStatusBatch({
      ...signed(input),subsetFromVerifiedWebhook:true,
    },{env,database:{connect:async()=>assert.fail("invalid batch opened database")}});
    assert.equal(result.accepted,false);
  }
  const forged=signed(body([status({recipient_id:"?"})]));
  forged.signatureHeader="sha256=invalid";
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...forged,subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>assert.fail("forged signature accessed database")}});
  assert.equal(result.code,"secondary_receipt_signature_invalid");
});

test("invalid recipient receipts cannot be acknowledged if the database transaction fails",async()=>{
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...signed(body([status({recipient_id:null})])),subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>{throw Error("unavailable");}}});
  assert.equal(result.accepted,false);
  assert.equal(result.code,"secondary_receipt_database_unavailable");
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


test("signed secondary unsupported status is durably quarantined without matching a contact or sending",async()=>{
  const calls=[];
  const fingerprints=new Set();
  const client={
    query:async (sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))
        return {rows:[{id:7}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_quarantined_events")) {
        assert.match(params[0],/^[a-f0-9]{64}$/);
        assert.equal(params[1],"messages.status.unknown");
        assert.equal(params[2],env.WHATSAPP_SECONDARY_WABA_ID);
        assert.equal(params[3],env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
        const fresh=!fingerprints.has(params[0]);
        fingerprints.add(params[0]);
        return {rowCount:fresh?1:0,rows:fresh?[{fingerprint:params[0]}]:[]};
      }
      assert.doesNotMatch(sql,/JOIN whatsapp_sender_message_context|UPDATE messages|whatsapp_sender_auto_reconciliations|INSERT INTO whatsapp_sender_status_receipts|UPDATE whatsapp_sender_billing_gates|INSERT INTO whatsapp_sender_billing_alarms/);
      return {rows:[],rowCount:1};
    },
    release:()=>{},
  };
  const packet=signed(body([status({status:"unknown"})]));
  // The parser remains strict when not explicitly opted into auditing.
  assert.equal(receipt.normalizedSignedEvents(packet.rawBody,env),null);
  for(const expected of [1,0]){
    const result=await receipt.recordSignedSecondaryStatusBatch({
      ...packet,subsetFromVerifiedWebhook:true,
    },{env,database:{connect:async()=>client}});
    assert.equal(result.accepted,true);
    assert.equal(result.matched,0);
    assert.equal(result.unmatched,0);
    assert.equal(result.quarantined||0,expected);
    assert.equal(result.sendAuthorized,false);
    assert.equal(result.autoRetryAllowed,false);
  }
  assert.equal(fingerprints.size,1);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_quarantined_events")).length,2);
  assert.equal(calls.filter(x=>x.sql==="COMMIT").length,2);
});

test("mixed signed secondary statuses quarantine unknown and missing recipients while preserving valid delivery evidence",async()=>{
  const calls=[];
  const client={
    query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))
        return {rows:[{id:7}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_quarantined_events"))
        return {rows:[{fingerprint:params[0]}],rowCount:1};
      if(sql.includes("JOIN whatsapp_sender_message_context"))return {rows:[],rowCount:0};
      if(sql.includes("INSERT INTO whatsapp_sender_status_receipts")) {
        assert.equal(params[7],"delivered");
        assert.equal(params[13],false);
        return {rows:[{fingerprint:params[0]}],rowCount:1};
      }
      assert.doesNotMatch(sql,/UPDATE messages|whatsapp_sender_auto_reconciliations|UPDATE whatsapp_sender_billing_gates/);
      return {rows:[],rowCount:1};
    },
    release:()=>{},
  };
  const packet=signed(body([
    status({id:"wamid.secondary-known",status:"delivered"}),
    status({id:"wamid.secondary-unknown",status:"played"}),
    status({id:"wamid.secondary-invalid-recipient",recipient_id:null}),
  ]));
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...packet,subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>client}});
  assert.equal(result.accepted,true);
  assert.equal(result.quarantined,2);
  assert.equal(result.unmatched,1);
  assert.equal(result.matched,0);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_quarantined_events")).length,2);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_status_receipts")).length,1);
});

test("signed unexpected billable status is quarantined and creates a hold, never a release",async()=>{
  const calls=[];
  const client={
    query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return {rows:[{id:7}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_quarantined_events"))
        return {rows:[{fingerprint:params[0]}],rowCount:1};
      if(sql.includes("INSERT INTO whatsapp_sender_billing_alarms")){
        assert.equal(params[0],7);
        assert.match(params[1],/^[a-f0-9]{64}$/);
        return {rowCount:1,rows:[]};
      }
      assert.doesNotMatch(sql,/UPDATE messages|UPDATE whatsapp_sender_billing_gates|INSERT INTO whatsapp_sender_auto_reconciliations/);
      return {rows:[],rowCount:1};
    },
    release:()=>{},
  };
  const packet=signed(body([status({
    status:"played",
    pricing:{type:"regular",billable:true,category:"service"},
  })]));
  const result=await receipt.recordSignedSecondaryStatusBatch({
    ...packet,subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>client}});
  assert.equal(result.accepted,true);
  assert.equal(result.quarantined,1);
  assert.equal(result.held,1);
  assert.equal(calls.filter(x=>x.sql.includes("INSERT INTO whatsapp_sender_billing_alarms")).length,1);
});

test("unsupported statuses cannot bypass HMAC, sender scope, malformed-input or storage checks",async()=>{
  const wrong=body([status({status:"played"})]);
  wrong.entry[0].changes[0].value.metadata.phone_number_id="999999999999999";
  const db={connect:async()=>assert.fail("must reject before database")};
  const mismatch=await receipt.recordSignedSecondaryStatusBatch({
    ...signed(wrong),subsetFromVerifiedWebhook:true,
  },{env,database:db});
  assert.equal(mismatch.accepted,false);
  const forged=await receipt.recordSignedSecondaryStatusBatch({
    rawBody:signed(body([status({status:"played"})])).rawBody,
    signatureHeader:"sha256=invalid",subsetFromVerifiedWebhook:true,
  },{env,database:db});
  assert.equal(forged.accepted,false);
  const invalid=body([status({status:"played",recipient_id:"???",timestamp:"bad_timestamp"})]);
  const malformed=await receipt.recordSignedSecondaryStatusBatch({
    ...signed(invalid),subsetFromVerifiedWebhook:true,
  },{env,database:db});
  assert.equal(malformed.accepted,false);
  const unavailable=await receipt.recordSignedSecondaryStatusBatch({
    ...signed(body([status({status:"played"})])),subsetFromVerifiedWebhook:true,
  },{env,database:{connect:async()=>{throw Error("temporarily offline");}}});
  assert.equal(unavailable.accepted,false);
  assert.equal(unavailable.code,"secondary_receipt_database_unavailable");
});

test("signed BSUID receipts remain sender-bound and are verified only by exact ID",()=>{
  const id="MY."+"Ab12".repeat(24);
  assert.equal(receipt.normalizeStatusRecipient(id).verified,true);
  assert.equal(receipt.normalizeStatusRecipient(id).recipient,id);
  const event=receipt.normalizedSignedEvents(signed(body([status({
    recipient_id:id,
  })])).rawBody,env);
  assert.equal(event.length,1);
  assert.equal(event[0].recipient,id);
  assert.equal(event[0].recipientVerified,true);
  const missingPhone=status({recipient_id:undefined,recipient_user_id:id});
  delete missingPhone.recipient_id;
  const fallback=receipt.normalizedSignedEvents(
    signed(body([missingPhone])).rawBody,env);
  assert.equal(fallback[0].recipient,id);
  assert.equal(fallback[0].recipientVerified,true);
  for(const bad of ["@Peggyteoh","MY.a-b","my.abcdef","XX."+"a".repeat(129)]) {
    const parsed=receipt.normalizeStatusRecipient(bad);
    assert.equal(parsed?.verified ?? false,false);
  }
});

test("Meta direct Cloud API recipient_user_id is parsed, including paired recipient_id",()=>{
  const userId="MY.13579ABCDEF";
  const hidden=status({recipient_id:undefined,recipient_user_id:userId});
  delete hidden.recipient_id;
  const parsed=receipt.normalizedSignedEvents(signed(body([hidden])).rawBody,env);
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].recipient,userId);
  assert.deepEqual(parsed[0].recipientCandidates,[userId]);
  const paired=receipt.normalizedSignedEvents(signed(body([status({
    recipient_id:"60125550000",recipient_user_id:userId,
  })])).rawBody,env);
  assert.deepEqual(paired[0].recipientCandidates,["60125550000",userId]);
  assert.ok(receipt.MATCH_SECONDARY_ATTEMPT_SQL.includes("a.recipient_address=$2"));
  assert.equal(receipt.MATCH_SECONDARY_ATTEMPT_SQL.includes(
    "whatsapp_last_customer_address=$2"),false,
    "changing a contact's last inbound must not retarget an earlier receipt");
});


test("verified secondary failures retain numeric Meta code without private error text",()=>{
 const err={code:131052,title:"private title +60123456789",
   message:"Contains phone and message",error_data:{details:"private media URL"}};
 const events=receipt.normalizedSignedEvents(signed(body([status({
   status:"failed",errors:[err]
 })])).rawBody,env);
 assert.equal(events.length,1);
 assert.equal(events[0].failureCode,131052);
 const reason=receipt.safeMetaDeliveryError(events[0]);
 assert.equal(reason,"Verified Meta delivery failure (code 131052); staff review required.");
 assert.equal(JSON.stringify(events).includes("private"),false);
 assert.equal(reason.includes("+60123456789"),false);
 const normal=receipt.normalizedSignedEvents(signed(body([status({
   status:"delivered",errors:[err]
 })])).rawBody,env);
 assert.equal(normal[0].failureCode,null);
});
test("secondary failure code extraction rejects unsafe and oversized values",()=>{
 for(const invalid of ["private",0,-5,2147483648,"2147483648",null,{},1.5]){
  assert.equal(receipt.safeMetaFailureCode([{code:invalid}]),null);
 }
 assert.equal(receipt.safeMetaFailureCode([{code:"131052"}]),131052);
 assert.equal(receipt.safeMetaDeliveryError({deliveryStatus:"failed",failureCode:null}),
   "Verified Meta delivery failure; staff review required.");
 assert.equal(receipt.safeMetaDeliveryError({deliveryStatus:"read",failureCode:131052}),
   "Verified Meta delivery failure; staff review required.");
});
