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
