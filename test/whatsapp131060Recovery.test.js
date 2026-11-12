"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  RECOVERY_DELAY_MS, is131060Message, recoveryActivation,
  verifiedAdTreatment, build131060RecoveryReply, canSend131060Recovery,
  recoveryTreatmentButtons, validRecoveryTreatmentButtons,
  readableHistoryForRecoverySelection, getVerifiedRecoveryHistoryProof,
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
  services: [{name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄抗衰"}],
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

test("verified ad creative allows only a treatment-specific human-sounding welcome", () => {
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
  assert.match(reply,/想了解骨盆调理对吗/);
  assert.match(reply,/可以点下面的选项/);
  assert.doesNotMatch(reply,/WhatsApp|无法|传送|没成功|resend|不能读取|bot|AI/i);
  assert.doesNotMatch(reply,/RM\d|discount|limited time|Before\s*&\s*After/i);
  assert.equal(verifiedAdTreatment({
    ...attributed,attribution:{...attributed.attribution,adId:null},
  },services),null);
  assert.equal(verifiedAdTreatment({
    ...attributed,attribution:{...attributed.attribution,headline:"骨盆调理与9D 逆龄",body:""},
  },services),null);
});

test("missing referral only gives a natural clinic welcome, without guessing a treatment", () => {
  const reply=build131060RecoveryReply(unavailable,services);
  assert.doesNotMatch(reply,/骨盆调理|3D 小颜术|9D 逆龄|来自广告|广告联系/);
  assert.match(reply,/想了解哪方面的护理呢/);
  assert.match(reply,/脉冲波/);
  assert.doesNotMatch(reply,/WhatsApp|resend|重新发送|没成功|AI|chatbot/i);
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
    assert.match(sql,/outbound_message_evidence prior_evidence/);
    assert.match(sql,/prior_menu\.created_at>=inbound\.created_at-INTERVAL '7 days'/);
    assert.doesNotMatch(sql,/NOT EXISTS \(SELECT 1 FROM messages older/);
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
  assert.match(server,/processingJobId,\s*interactiveButtons: recoveryTreatmentButtons\(\),\s*reviewReplyToInboundMessageId: savedInbound\.id,\s*latePreSendCheck:/);
  assert.match(server,/latePreSendCheck\(saved.id\)/);
  assert.match(server,/sendSecondaryStaffText\(/);
});

test("buttons are three fixed genuine treatments with a typed other-service escape", () => {
  const buttons=recoveryTreatmentButtons();
  assert.deepEqual(buttons,[
    {id:"neutro_131060_pelvic",title:"骨盆调理"},
    {id:"neutro_131060_3d",title:"3D 小颜术"},
    {id:"neutro_131060_9d",title:"9D 逆龄抗衰"},
  ]);
  assert.equal(validRecoveryTreatmentButtons(buttons),true);
  assert.equal(buttons.every(b=>b.title.length<=20&&b.id.length<=256),true);
  assert.equal(validRecoveryTreatmentButtons(buttons.slice(0,2)),false);
  assert.equal(validRecoveryTreatmentButtons([...buttons.slice(0,2),
    {id:"neutro_131060_9d",title:"脉冲波"}]),false);
  assert.equal(validRecoveryTreatmentButtons([...buttons].reverse()),false);
  buttons[0].title="tampered";
  assert.equal(validRecoveryTreatmentButtons(buttons),false);
  assert.match(build131060RecoveryReply(unavailable,services),/其他护理（例如脉冲波）也可以直接告诉我们/);
});

test("genuine Meta button tap becomes a readable selected treatment without fabricating an ad", () => {
  const {parseIncomingMessages}=require("../src/services/whatsappService");
  const [incoming]=parseIncomingMessages({entry:[{id:"1852014482431209",changes:[{
    field:"messages",value:{
      metadata:{phone_number_id:"1318355951360575"},
      messages:[{id:"wamid.button",from:"60123123456",timestamp:"1794217329",
        type:"interactive",interactive:{type:"button_reply",button_reply:{
          id:"neutro_131060_3d",title:"3D 小颜术"}}}],
    },
  }]}]});
  assert.equal(incoming.text,"3D 小颜术");
  assert.equal(incoming.interactiveReplyId,"neutro_131060_3d");
  assert.equal(incoming.unsupportedType,null);
  assert.equal(incoming.attribution,undefined);
  assert.equal(incoming.businessPhoneNumberId,"1318355951360575");
});

test("secondary button sender is not a generic interactive-message bypass", () => {
  const src=fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappSecondaryStaffDispatch.js"),"utf8");
  assert.match(src,/if \(recoveryMenu && \(origin !== "system_fallback"/);
  assert.match(src,/!recoveryActivation\(env\)/);
  assert.match(src,/!validRecoveryTreatmentButtons\(interactiveButtons\)/);
  assert.match(src,/transport\.sendInteractiveButtons\(text\.trim\(\), interactiveButtons\)/);
  assert.match(src,/await stillEligible\(\)/);
  assert.match(src,/reserveSecondaryBillingAttempt/);
});

test("validated menu removes the first unreadable placeholder for buttons, typing and later turns", () => {
  const history = [
    {role:"user",content:"📎 [Customer sent a WhatsApp message that could not be displayed]"},
    {role:"assistant",content:build131060RecoveryReply(unavailable,services)},
    {role:"user",content:"9D 逆龄抗衰"},
  ];
  const verified = {unavailable_message_id:72,recovery_message_id:73};
  const cleaned = readableHistoryForRecoverySelection(history,verified);
  assert.deepEqual(cleaned,history.slice(1));
  assert.equal(history.length,3,"the staff-visible transcript must not change");
  assert.equal(readableHistoryForRecoverySelection(history,null),history);
  assert.equal(readableHistoryForRecoverySelection(history,{unavailable_message_id:null}),history);
  assert.deepEqual(readableHistoryForRecoverySelection([
    ...history,{role:"user",content:"What are the steps?"}],verified),
    [...history.slice(1),{role:"user",content:"What are the steps?"}],
    "additional customer turns must be preserved");
  assert.deepEqual(readableHistoryForRecoverySelection([
    history[0],history[1],{role:"user",content:"脉冲波"}],verified),
    [history[1],{role:"user",content:"脉冲波"}],
    "typed alternate treatments are valid, not only interactive replies");
  assert.equal(readableHistoryForRecoverySelection([
    {role:"user",content:"What does this cost?"},...history],verified).length,4);
  assert.equal(readableHistoryForRecoverySelection([
    history[0],{role:"user",content:"staff-visible followup"}],verified).length,2);
});

test("returning customer prompts exclude only the exact signed 131060 placeholder",()=>{
 const oldCustomerTurn={role:"user",content:"Which services do you provide?"};
 const oldStaff={role:"assistant",content:"We provide TCM care."};
 const unavailableTurn={role:"user",content:"📎 [Customer sent a WhatsApp message that could not be displayed]"};
 Object.defineProperty(unavailableTurn,"contextMessageId",{value:55,enumerable:false});
 const menu={role:"assistant",content:build131060RecoveryReply(unavailable,services)};
 const selected={role:"user",content:"9D 逆龄抗衰"};
 const history=[oldCustomerTurn,oldStaff,unavailableTurn,menu,selected];
 assert.deepEqual(readableHistoryForRecoverySelection(history,{
   unavailable_message_id:55,recovery_message_id:56,
 }),[oldCustomerTurn,oldStaff,menu,selected]);
 assert.deepEqual(readableHistoryForRecoverySelection(history,{
   unavailable_message_id:999,recovery_message_id:56,
 }),history,"an unrelated proof cannot hide another customer message");
 assert.equal(JSON.stringify(unavailableTurn).includes("contextMessageId"),false);
});

test("database proof requires a first Meta 131060 error and an accepted same-inbound menu",async () => {
  let sqlCheckCount=0;
  const database = {async query(sql,values) {
    sqlCheckCount++;
    assert.deepEqual(values,[17,21]);
    assert.match(sql,/original_job\.incoming_payload->'unsupportedErrors'/);
    assert.match(sql,/"code":131060/);
    assert.match(sql,/recovery_attempt\.inbound_message_id=initial\.id/);
    assert.match(sql,/recovery_attempt\.origin='system_fallback'/);
    assert.match(sql,/recovery_attempt\.outcome='accepted'/);
    assert.match(sql,/recovery_attempt\.provider_message_id=recovery\.whatsapp_message_id/);
    assert.match(sql,/outbound_message_evidence accepted_outbound/);
    assert.match(sql,/accepted_outbound\.accepted=TRUE/);
    assert.match(sql,/recovery_ctx\.conversation_id=sc\.id/);
    assert.match(sql,/current_ctx\.conversation_id=sc\.id/);
    assert.doesNotMatch(sql,/SELECT 1 FROM messages before_first/);
    assert.match(sql,/initial\.created_at>=current_inbound\.created_at-INTERVAL '7 days'/);
    assert.match(sql,/recovery\.delivery_status IN/);
    return {rows:[{unavailable_message_id:11,recovery_message_id:12}]};
  }};
  assert.deepEqual(await getVerifiedRecoveryHistoryProof({
    contactId:17,inboundMessageId:21,database,
  }),{unavailable_message_id:11,recovery_message_id:12});
  assert.equal(sqlCheckCount,1);
  assert.equal(await getVerifiedRecoveryHistoryProof({
    contactId:17,inboundMessageId:0,database,
  }),null);
  assert.equal(sqlCheckCount,1);
  assert.equal(await getVerifiedRecoveryHistoryProof({
    contactId:17,inboundMessageId:21,
    database:{query:async()=>({rows:[]})},
  }),null);
});

test("server restores verified ad-first treatment after an intervening recovery menu", () => {
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const section=server.slice(server.indexOf("const history = await conversationStore.getHistoryForContact"),
    server.indexOf("const mediaLanguage = detectReplyConversationLanguage"));
  assert.match(section,/isVerifiedAdInbound/);
  assert.match(section,/preclaimed\?\.verifiedUnavailableFirstAd === true/);
  assert.match(section,/firstAdProofRepo\.getVerifiedFirstAdMessage/);
  assert.doesNotMatch(section,/history\.length === 2\s*&&/);
  assert.match(section,/await getVerifiedRecoveryHistoryProof\(/);
  assert.match(section,/readableHistoryForRecoverySelection\(\s*history, recoveryPromptProof/);
  assert.match(server,/isFirstMessage: wasFirstMessage === true \|\| verifiedFirstReadableAd/);
});

test("first-ad neutral recovery marker requires accepted provider proof after pruning", () => {
  const {is131060RecoveryAssistantSql}=require("../src/utils/whatsapp131060RecoverySql");
  const sql=is131060RecoveryAssistantSql("prior","initial");
  assert.match(sql,/recovery_out\.outcome='accepted'/);
  assert.match(sql,/recovery_out\.provider_message_id=prior\.whatsapp_message_id/);
  assert.match(sql,/outbound_message_evidence accepted_menu/);
  assert.match(sql,/accepted_menu\.accepted=TRUE/);
  assert.match(sql,/accepted_menu\.origin='system_fallback'/);
  assert.match(sql,/initial\.content LIKE/);
  assert.match(sql,/prior\.content LIKE/);
  assert.throws(()=>is131060RecoveryAssistantSql("prior; DROP TABLE contacts","initial"),TypeError);
});
