"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertPr395StagingSafety, controlledStaffTestEnabled, approvedStaffTestRecipient,
  validProviderRehearsalEvent, stagingWebhookGuard
} = require("../src/services/pr395StagingSafety");
const {
  createVerifiedSecondaryOutboundTransport
} = require("../src/services/whatsappSenderOutboundTransport");

const strong = "pr395-staging-strong-secret-value-0123456789";
function approved(extra = {}) {
  return {
    PR395_STAGING_MODE: "true", NODE_ENV: "production",
    PR395_STAGING_BASIC_AUTH_ENABLED: "true",
    PR395_STAGING_BASIC_AUTH_USERNAME: "qa",
    PR395_STAGING_BASIC_AUTH_PASSWORD: strong,
    PR395_STAGING_EXPECTED_DATABASE_HOST: "ep-isolated-qa.neon.tech",
    DATABASE_URL: "postgresql://qa:fake@ep-isolated-qa.neon.tech/qa?sslmode=require",
    SESSION_SECRET: strong, WHATSAPP_APP_SECRET: strong, META_APP_SECRET: strong,
    WHATSAPP_WABA_ID: "200200200", WHATSAPP_PHONE_NUMBER_ID: "100100100",
    WHATSAPP_PHONE_NUMBER: "+60130000000", WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
    WHATSAPP_TOKEN: "pr395-inert-no-send-token",
    WHATSAPP_SECONDARY_WABA_ID: "400400400",
    WHATSAPP_SECONDARY_EXPECTED_WABA_ID: "400400400",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "300300300",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID: "300300300",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: "+60120000000",
    PR395_STAGING_APPROVED_TEST_PHONE_E164: "+60120000000",
    WHATSAPP_SECONDARY_SENDER_KEY: "coexistence_qa",
    WHATSAPP_SECONDARY_TOKEN: "qa-specific-token",
    PR395_STAGING_PROVIDER_REHEARSAL_ENABLED: "true",
    PR395_STAGING_ALLOW_PROVIDER_PROCESSING: "true",
    WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
    WHATSAPP_COEXISTENCE_ENABLED: "true",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED: "true",
    WHATSAPP_SINGLE_SENDER_STRICT_METADATA: "true",
    WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED: "true",
    PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED: "true",
    PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED: "true",
    PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164: "+60125550000",
    PR395_STAGING_APPROVED_TEST_RECIPIENT_E164: "+60125550000",
    WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED: "true",
    WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED: "true",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED: "true",
    WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true",
    WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED: "true",
    WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: "true",
    WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "true",
    WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED: "true",
    ...extra
  };
}
test("staff-only staging mode permits one approved recipient and keeps all workers off", () => {
  const env = approved();
  assert.equal(controlledStaffTestEnabled(env), true);
  assert.equal(approvedStaffTestRecipient(env), "+60125550000");
  assert.deepEqual(assertPr395StagingSafety(env), {
    staging: true, workersDisabled: true,
    providerProcessingDisabled: false, historyImporterOnly: true,
    controlledStaffTest: true
  });
});
test("staging staff approval fails closed on missing controls, foreign recipients and automation", () => {
  const failures = [
    {PR395_STAGING_MODE: "false"},
    {PR395_STAGING_PROVIDER_REHEARSAL_ENABLED: "false"},
    {PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED: "false"},
    {WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED: "false"},
    {PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164: "+60129999999"},
    {PR395_STAGING_APPROVED_TEST_RECIPIENT_E164: "+60129999999"},
    {PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164: "+60120000000",
      PR395_STAGING_APPROVED_TEST_RECIPIENT_E164: "+60120000000"},
    {PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164: "+60174831336",
      PR395_STAGING_APPROVED_TEST_RECIPIENT_E164: "+60174831336"},
    {WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: "false"},
    {WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "false"},
    {WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED: "false"},
    {WHATSAPP_SECONDARY_STAFF_SEND_ENABLED: "false"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true"},
    {WHATSAPP_SECONDARY_AI_MEDIA_ENABLED: "true"},
    {WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED: "true"},
    {WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED: "true"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED: "true"},
    {WHATSAPP_TOKEN: "real-primary-secret"},
    {WHATSAPP_SECONDARY_SENDER_KEY: "neutro"},
    {WHATSAPP_SECONDARY_WABA_ID: "200200200",
      WHATSAPP_SECONDARY_EXPECTED_WABA_ID: "200200200"}
  ];
  for (const changes of failures) {
    assert.throws(() => assertPr395StagingSafety(approved(changes)),
      Error, JSON.stringify(changes));
  }
});
test("signed receiver test only accepts pinned QA traffic; statuses require staff mode", () => {
  const env = approved();
  const inbound = {
    object: "whatsapp_business_account",
    entry: [{id: "400400400", changes: [{
      field: "messages", value: {metadata: {phone_number_id: "300300300"},
        messages: [{id:"wamid.qa",from:"60125550000",type:"text",text:{body:"qa test"}}]}
    }]}]
  };
  const statuses = {
    object: "whatsapp_business_account",
    entry: [{id: "400400400", changes: [{
      field: "messages", value: {metadata: {phone_number_id: "300300300"},
        statuses: [{id:"wamid.qa",status:"delivered"}]}
    }]}]
  };
  assert.equal(validProviderRehearsalEvent(inbound, "/webhook", env), true);
  assert.equal(validProviderRehearsalEvent(statuses, "/webhook", env), true);
  assert.equal(validProviderRehearsalEvent(statuses, "/webhook", approved({
    PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED: "false"
  })), false);
  assert.equal(validProviderRehearsalEvent(inbound, "/meta-webhook", env), false);
  assert.equal(validProviderRehearsalEvent({...inbound, entry:[{
    ...inbound.entry[0],id:"200200200"
  }]}, "/webhook", env), false);
  const foreign={...inbound,entry:[{
    ...inbound.entry[0],changes:[{...inbound.entry[0].changes[0],
      value:{metadata:{phone_number_id:"100100100"},messages:[]}}]
  }]};
  let called=false;let status=null;
  stagingWebhookGuard({body:foreign,path:"/webhook"},{
    set(){return this},status(n){status=n;return this},json(){return this}
  },()=>{called=true},env);
  assert.equal(called,false);
  assert.equal(status,503);
});
test("even an authorized staff send cannot target a different imported contact", async () => {
  const env = approved();
  const customer="60125550000";
  const contact={id:5,channel:"whatsapp",whatsapp_number:customer};
  const row={
    whatsapp_number:customer,whatsapp_sender_id:"3",bound_sender_id:"3",
    customer_wa_id:customer,binding_state:"bound",sender_key:"coexistence_qa",
    meta_phone_number_id:"300300300",meta_account_id:"400400400",
    sender_state:"active",sender_coexistence_enabled:true
  };
  const database={query:async()=>({rows:[row]})};
  const client=await createVerifiedSecondaryOutboundTransport(contact,{env,database});
  assert.equal(client.senderKey,"coexistence_qa");
  assert.equal(typeof client.sendText,"function");
  for (const invalid of [
    {contact:{...contact,whatsapp_number:"60129999999"}},
    {env:approved({PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED:"false"})},
    {env:approved({PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED:"false"})}
  ]) {
    await assert.rejects(createVerifiedSecondaryOutboundTransport(
      invalid.contact||contact,{env:invalid.env||env,database}),
      error=>error?.code==="whatsapp_sender_not_ready");
  }
});
