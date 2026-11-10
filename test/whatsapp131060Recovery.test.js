"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  RECOVERY_DELAY_MS, is131060Message, recoveryActivation,
  verifiedAdTreatment, build131060RecoveryReply, canSend131060Recovery,
} = require("../src/services/whatsapp131060Recovery");

const earlier = new Date(Date.now() - 60000).toISOString();
const env = {
  WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED: "true",
  WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT: earlier,
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE: "all_contacts",
  WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT: earlier,
  WHATSAPP_SECONDARY_SENDER_KEY: "neutro_secondary",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED: "true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID: "1852014482431209",
};

const unavailable = {
  unsupportedType: "unsupported",
  unsupportedErrors: [{ code: 131060, title: "This message is unavailable." }],
};
const services = {
  services: [{name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄"}],
  serviceAliases: [{alias:"盆骨",officialService:"骨盆调理"}],
};

test("only exact WhatsApp Meta 131060 is recoverable", () => {
  assert.equal(is131060Message(unavailable), true);
  assert.equal(is131060Message({...unavailable, channel:"instagram"}), false);
  assert.equal(is131060Message({...unavailable, unsupportedErrors:[{code:131051}]}), false);
  assert.equal(is131060Message({...unavailable, unsupportedErrors:[]}), false);
  assert.equal(is131060Message({...unavailable, unsupportedType:"interactive"}), false);
  assert.equal(is131060Message(null), null);
});

test("activation is explicit, post-cutover and fail closed", () => {
  assert.equal(recoveryActivation(env), earlier);
  assert.equal(recoveryActivation({...env,WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"false"}),null);
  assert.equal(recoveryActivation({...env,WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:""}),null);
  assert.equal(recoveryActivation({...env,WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2028-01-01T00:00:00Z"}),null);
  assert.equal(recoveryActivation({...env,WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"ads_only"}),null);
  assert.ok(RECOVERY_DELAY_MS>=3000);
});

test("verified ad creative allows only a treatment-specific resend prompt", () => {
  const attributed = {
    ...unavailable,
    attribution: {
      source:"meta_ads",sourceType:"ad",adId:"120123456789012345",
      headline:"骨盆调理护理",body:"改善骨盆与体态",
    },
  };
  assert.equal(verifiedAdTreatment(attributed,services),"骨盆调理");
  const reply=build131060RecoveryReply(attributed,services);
  assert.match(reply,/骨盆调理/);
  assert.match(reply,/重新发送一次/);
  assert.match(reply,/resend/i);
  assert.doesNotMatch(reply,/RM\d|discount|limited time|Before\s*&\s*After/i);
  assert.equal(verifiedAdTreatment({
    ...attributed,attribution:{...attributed.attribution,adId:null},
  },services),null);
  assert.equal(verifiedAdTreatment({
    ...attributed,attribution:{...attributed.attribution,headline:"骨盆调理与9D 逆龄",body:""},
  },services),null);
});

test("missing referral never guesses the advertised treatment", () => {
  const reply=build131060RecoveryReply(unavailable,services);
  assert.doesNotMatch(reply,/骨盆调理|3D 小颜术|9D 逆龄|来自广告|广告联系/);
  assert.match(reply,/WhatsApp/);
  assert.match(reply,/resend/i);
});

test("the replay-proof eligibility check is limited to persisted sender and message", async () => {
  let called=0;
  const database={async query(sql, params){
    called++;
    assert.match(sql,/JOIN whatsapp_sender_conversations sc/);
    assert.match(sql,/sc.state='bound'/);
    assert.match(sql,/JOIN inbound_processing_jobs job/);
    assert.match(sql,/\"code\":131060/);
    assert.match(sql,/job.incoming_payload->>'businessPhoneNumberId'=\$4/);
    assert.match(sql,/job.incoming_payload->>'businessAccountId'=\$5/);
    assert.match(sql,/AND inbound.source_created_at >= \$6::timestamptz/);
    assert.match(sql,/NOT EXISTS \(SELECT 1 FROM messages older/);
    assert.match(sql,/NOT EXISTS \(SELECT 1 FROM messages newer/);
    assert.match(sql,/c.whatsapp_opt_out_at IS NULL/);
    assert.match(sql,/c.mode='ai'/);
    assert.deepEqual(params.slice(0,5),
      [10,34,null,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
    return {rows:[{eligible:true}]};
  }};
  assert.equal(await canSend131060Recovery({contactId:10,inboundMessageId:34,database,env}),true);
  assert.equal(called,1);
  assert.equal(await canSend131060Recovery({contactId:10,inboundMessageId:34,
    database:{query:async()=>({rows:[{eligible:false}]})},env}),false);
  assert.equal(await canSend131060Recovery({contactId:10,inboundMessageId:0,database,env}),false);
  assert.equal(await canSend131060Recovery({contactId:10,inboundMessageId:34,
    database,env:{...env,WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"false"}}),false);
  assert.equal(called,1);
});

test("runtime reserves the reply through existing guarded secondary billing and cancellation", () => {
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(server,/if \(secondaryAiConversation && is131060Message\(incoming\)/);
  assert.match(server,/recoveryActivation\(process\.env\)/);
  assert.match(server,/await canSend131060Recovery\(/);
  assert.match(server,/build131060RecoveryReply\(incoming, clinicConfig\)/);
  assert.match(server,/"system_fallback"/);
  assert.match(server,/processingJobId,\s*latePreSendCheck:/);
  assert.match(server,/latePreSendCheck\(saved.id\)/);
  assert.match(server,/sendSecondaryStaffText\(/);
});
