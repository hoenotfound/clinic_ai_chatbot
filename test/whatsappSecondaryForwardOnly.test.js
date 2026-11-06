"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sendSecondaryStaffText } = require("../src/services/whatsappSecondaryStaffDispatch");
const { sendSecondaryStaffMedia } = require("../src/services/whatsappSecondaryMediaDispatch");
const { secondaryAdsOnlyFullAiMode } = require("../src/services/whatsappSenderActivationGate");

const env = {
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_WABA_ID: "1593376338308612",
  WHATSAPP_SECONDARY_SENDER_KEY: "neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID: "1852014482431209",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE: "primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED: "true",
  WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED: "true",
  WHATSAPP_SECONDARY_FORWARD_SEND_ENABLED: "true",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED: "true",
  WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED: "true",
  WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED: "false",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE: "all_contacts",
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE: "all_contacts",
  WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT: "2026-11-03T01:00:00Z",
  WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT: "2026-11-03T02:00:00Z",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED: "true",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED: "true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED: "false",
  WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED: "false",
  WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED: "false",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED: "true",
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED: "true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED: "false",
  WHATSAPP_COEXISTENCE_ENABLED: "true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED: "true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED: "true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED: "true",
};
const contact = {
  id: 73, channel: "whatsapp", mode: "ai", whatsapp_number: "60125550000",
  whatsapp_sender_id: 2, whatsapp_sender_key: "neutro_secondary",
  whatsapp_sender_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  whatsapp_sender_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
};
const reservationId = "11111111-1111-4111-8111-111111111111";
function textFixture({ persisted = true, policyAllowed = true } = {}) {
  const calls = { sent: 0, reserved: 0, rows: [], checks: 0 };
  const deps = {
    env,
    database: { query: async (sql, params) => {
      calls.rows.push([sql,params]);
      if (sql.includes("FROM messages WHERE id=")) return { rows: persisted ? [{ ok: true }] : [] };
      return { rows: [{ reservation_id: reservationId }] };
    }},
    policyService: {
      previewSecondaryFreeformPolicy: async () => { calls.checks++; return { policyAllowed, code: "service_window_closed" }; },
      secondaryPolicySnapshot: async () => ({ row: { sender_conversation_id: 11 } }),
    },
    conversationRepo: {
      senderForContact: async () => ({
        conversation_id: 11, sender_key: "neutro_secondary", sender_state: "active",
        meta_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        meta_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
        customer_wa_id: contact.whatsapp_number,
      }),
      attachMessageContext: async () => ({ conversation_id: 11 }),
    },
    billingRepo: {
      reserveSecondaryBillingAttempt: async () => { calls.reserved++; return { reserved: true, reservationId }; },
      recordSecondaryProviderOutcome: async () => ({ recorded: true }),
    },
    createTransport: async () => ({
      sendText: async () => { calls.sent++; return { success: true, wamid: "wamid.forwarded" }; },
    }),
  };
  return { deps, calls };
}

test("forward-only permission preserves full-AI mode without authorizing normal staff sends", async () => {
  assert.equal(secondaryAdsOnlyFullAiMode(env), true);
  const {deps,calls}=textFixture();
  const data={contact,messageId:123,text:"Hi from primary",origin:"staff_forward"};
  const sent=await sendSecondaryStaffText(data,deps);
  assert.equal(sent.success,true);
  assert.equal(calls.sent,1);
  assert.equal(calls.reserved,1);
  const blocked=await sendSecondaryStaffText({...data,origin:"staff"},deps);
  assert.equal(blocked.code,"secondary_staff_send_disabled");
  assert.equal(calls.sent,1);
});

test("forward-only permission blocks missing opt-in, missing forwarded proof and closed window", async () => {
  const data={contact,messageId:123,text:"Hi",origin:"staff_forward"};
  for(const change of [
    { env: {...env, WHATSAPP_SECONDARY_FORWARD_SEND_ENABLED:"false"} },
    { env: {...env, WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED:"false"} },
    { env: {...env, WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"false"} },
  ]) {
    const {deps,calls}=textFixture();
    const result=await sendSecondaryStaffText(data,{...deps,...change});
    assert.equal(result.success,false);
    assert.equal(calls.sent,0);
    assert.equal(calls.reserved,0);
  }
  for(const config of [{persisted:false},{policyAllowed:false}]) {
    const {deps,calls}=textFixture(config);
    const result=await sendSecondaryStaffText(data,deps);
    assert.equal(result.success,false);
    assert.equal(calls.sent,0);
    assert.equal(calls.reserved,0);
  }
});

test("secondary media forwarding accepts only a proven saved forward with staff-only gates OFF", async () => {
  const calls = [];
  const deps = {
    env,
    database:{query:async sql => ({rows:sql.includes("FROM messages WHERE id=") ? [{valid:true}] : []})},
    contacts:{getContactById:async()=>contact},
    policyService:{previewSecondaryFreeformPolicy:async()=>({policyAllowed:true})},
    textDispatcher:async ({origin,preSendCheck,dispatchTransport}) => {
      calls.push(origin);
      assert.equal(await preSendCheck(),true);
      return dispatchTransport({
        uploadMedia:async()=>({success:true,mediaId:"123456789"}),
        sendMediaById:async()=>({success:true,wamid:"wamid.forward-media"}),
      });
    },
  };
  const result=await sendSecondaryStaffMedia(contact,"sendImageBuffer",[
    Buffer.from("jpg"),"image/jpeg","Caption","photo.jpg",
    {staffMedia:true,staffForward:true,currentMessageId:123,autoFollowUp:false},
  ],deps);
  assert.equal(result.success,true);
  assert.deepEqual(calls,["staff_forward"]);
  const denied=await sendSecondaryStaffMedia(contact,"sendImageBuffer",[
    Buffer.from("jpg"),"image/jpeg","Caption","photo.jpg",
    {staffMedia:true,currentMessageId:123,autoFollowUp:false},
  ],deps);
  assert.equal(denied.success,false);
  assert.deepEqual(calls,["staff_forward"]);
});


test("forwarded media waits for the previous receipt before one sender-owned send", async () => {
  const {deps} = textFixture();
  let attempts = 0, waits = 0, sends = 0;
  deps.billingRepo.reserveSecondaryBillingAttempt = async () => {
    attempts++;
    return attempts === 1
      ? {reserved:false,code:"secondary_billing_previous_send_unresolved"}
      : {reserved:true,reservationId};
  };
  deps.waitForPriorSettlement = async delay => {
    waits++;
    assert.equal(delay,750);
  };
  const sent = await sendSecondaryStaffText({
    contact,messageId:125,text:"[staff media]",origin:"staff_forward",
    preSendCheck:async()=>true,
    dispatchTransport:async()=>{sends++;return{success:true,wamid:"wamid.forwarded-media"};},
  },deps);
  assert.equal(sent.success,true);
  assert.equal(attempts,2);
  assert.equal(waits,1);
  assert.equal(sends,1);
});

test("unresolved prior forwarded-media billing gate never triggers another Meta send", async () => {
  const {deps} = textFixture();
  let reservations=0, waits=0, sends=0;
  deps.billingRepo.reserveSecondaryBillingAttempt = async () => {
    reservations++;
    return {reserved:false,code:"secondary_billing_previous_send_unresolved"};
  };
  deps.waitForPriorSettlement = async () => { waits++; };
  const blocked = await sendSecondaryStaffText({
    contact,messageId:125,text:"[staff media]",origin:"staff_forward",
    dispatchTransport:async()=>{sends++;return{success:true,wamid:"wamid.must-not-send"};},
  },deps);
  assert.equal(blocked.code,"secondary_billing_previous_send_unresolved");
  assert.equal(reservations,5);
  assert.equal(waits,4);
  assert.equal(sends,0);
});
