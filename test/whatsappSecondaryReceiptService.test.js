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
