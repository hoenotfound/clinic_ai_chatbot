"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const svc=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const templateTools=require("../src/services/whatsappTemplateService");
const raw={id:"5566",name:"neutro_review_invite",language:"zh_CN",status:"APPROVED",category:"MARKETING",
 components:[{type:"BODY",text:"欢迎预约一对一体态评估。若不想收到提醒，请回复停止。"}]};
const definition=templateTools.normalizeTemplate(raw);
const signature=templateTools.templateSignature(definition);
const row={
 contact_id:22,channel:"whatsapp",whatsapp_number:"60123456789",
 whatsapp_sender_id:5,whatsapp_sender_key:"neutro_secondary",
 whatsapp_sender_phone_number_id:"1318355951360575",
 whatsapp_sender_account_id:"1852014482431209",
 sender_id:5,conversation_id:44,inbound_id:99,slot_hours:48,
 template_name:raw.name,language_code:"zh_CN",template_signature:signature,
 customer_messages:["我想了解骨盆调理，价格是多少？"],
 rule_updated_at:new Date("2026-10-01T02:00:00Z"),treatment_interest:"骨盆",
};
const env={
 PR395_STAGING_MODE:"false",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
 WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
 WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
 WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
 WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
 WHATSAPP_COEXISTENCE_ENABLED:"true",
 WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
 WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
 WHATSAPP_SECONDARY_TOKEN:"synthetic-test-token",
 WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
 WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"true",
 WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"true",
 WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
 WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
 WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
};
function fake({candidates=[row],extendedCandidates=[],claimed=true,approved=true,
  sendResult={success:true,wamid:"wamid.secondary-approved"}}={}){
 const calls=[];
 return{
 calls,
 database:{query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql===svc.CANDIDATES_SQL || sql===svc.EXTENDED_CANDIDATES_SQL){
   assert.equal(args.length,8,"candidate selection binds audience and both cutoffs");
   assert.equal(args[5],new Date(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT).toISOString());
   return{rows:sql===svc.CANDIDATES_SQL?candidates:extendedCandidates};
  }
  if(sql===svc.RECHECK_SQL || sql===svc.EXTENDED_RECHECK_SQL){
   assert.equal(args.length,8,"pre-send recheck binds audience and both cutoffs");
   assert.equal(args[5],new Date(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT).toISOString());
   return{rows:sql===svc.RECHECK_SQL?candidates:extendedCandidates};
  }
  if(sql.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts"))
   return{rows:claimed?[{id:555}]:[]};
  return{rows:[],rowCount:1};
 }},
 contacts:{getContactById:async()=>({id:row.contact_id,channel:"whatsapp",
  whatsapp_number:row.whatsapp_number,
  whatsapp_sender_key:"neutro_secondary",whatsapp_sender_id:5})},
 store:{
  saveMessage:async(...args)=>{calls.push({saved:args});return{id:200}},
  setWhatsappMessageId:async(...args)=>{calls.push({persisted:args})},
 },
 templatePolicy:{previewSecondaryTemplatePolicy:async(contact,options)=>{
  calls.push({preview:options});
  return approved?{policyAllowed:true,template:{category:"MARKETING",definition:raw}}:
   {policyAllowed:false,code:"not_approved"};
 }},
 send:async payload=>{calls.push({send:payload});return sendResult},
 };
}
test("no marketing sends or database reads without all independent authorization switches",async()=>{
 for(const flag of [
  "WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
 ]){
  const e={...env,[flag]:"false"},f=fake();
  assert.deepEqual(await svc.runOnce({...f,env:e}),{disabled:true,attempted:0,accepted:0});
  assert.equal(f.calls.length,0,flag);
 }
 assert.equal(svc.enabled({...env,PR395_STAGING_MODE:"true"}),false);
 assert.match(svc.CANDIDATES_SQL,/consent\.consent_scope='treatment_followups_and_related_offers'/);
 for(const sql of [svc.CANDIDATES_SQL,svc.RECHECK_SQL,
    svc.EXTENDED_CANDIDATES_SQL,svc.EXTENDED_RECHECK_SQL,svc.POTENTIAL_DUE_SQL]){
   assert.match(sql,/recent_seed AS MATERIALIZED/);
   assert.match(sql,/verified_seed AS MATERIALIZED/);
   assert.match(sql,/recent_contact\.legacy_ads_eligible/);
   assert.match(sql,/whatsapp_secondary_ad_eligibility_reviews/);
   assert.match(sql,/whatsapp_marketing_consent_events consent/);
   assert.match(sql,/whatsapp_opt_out_at IS NULL/);
 }
 assert.match(svc.CANDIDATES_SQL,/consent_ctx\.conversation_id=sc\.id/);
 assert.match(svc.CANDIDATES_SQL,/marketing_consent='opted_in'/);
 assert.match(svc.CANDIDATES_SQL,/whatsapp_sender_coexistence_history_messages/);
 assert.match(svc.CANDIDATES_SQL,/appointment_status/);
 assert.match(svc.CANDIDATES_SQL,/BETWEEN 7 AND 23/);
 assert.match(svc.RECHECK_SQL,/attempted\.status='claimed'/);
 assert.match(svc.CANDIDATES_SQL,/whatsapp_free_entry_referrals ads_ref/);
 assert.match(svc.RECHECK_SQL,/whatsapp_coexistence_imported_at IS NULL/);
});
test("only static secondary account APPROVED MARKETING templates are accepted",()=>{
 assert.ok(svc.approvedStaticMarketingTemplate(raw,signature));
 assert.equal(svc.approvedStaticMarketingTemplate({...raw,status:"PENDING"},signature),null);
 assert.equal(svc.approvedStaticMarketingTemplate({...raw,category:"UTILITY"},signature),null);
 assert.equal(svc.approvedStaticMarketingTemplate({...raw,components:[{type:"BODY",text:"Hi {{1}}"}]},signature),null);
 assert.equal(svc.approvedStaticMarketingTemplate({...raw,components:[
  {type:"HEADER",format:"IMAGE"},{type:"BODY",text:"Reminder"},
 ]},signature),null);
 assert.equal(svc.approvedStaticMarketingTemplate(raw,"a".repeat(64)),null);
});
test("one 48h secondary send claims first and checks current provider approval twice",async()=>{
 const f=fake();
 const result=await svc.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
 const claim=f.calls.findIndex(x=>x.sql?.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts"));
 const saved=f.calls.findIndex(x=>x.saved);
 const sent=f.calls.findIndex(x=>x.send);
 assert.ok(claim>=0&&saved>claim&&sent>saved);
 assert.equal(f.calls[saved].saved[8].whatsappTemplate.automatedSecondaryMarketingFollowup,true);
 assert.equal(f.calls[saved].saved[8].whatsappTemplate.templateSignature,signature);
 assert.equal(f.calls[sent].send.origin,"marketing_followup");
 assert.equal(f.calls[sent].send.templateRequest.billingConfirmed,true);
 assert.equal(f.calls[sent].send.templateRequest.treatmentInterest,"骨盆");
 assert.ok(f.calls.filter(x=>x.preview).length>=1);
 assert.equal(f.calls[sent].send.templateRequest.languageCode,"zh_CN");
});
test("no template send without current approval, after a failed claim, or after uncertain Meta response",async()=>{
 for(const testCase of [
  {input:{claimed:false}, expected:0},
  {input:{approved:false},expected:0},
  {input:{sendResult:{success:false,unknown:true,ambiguous:true,retryable:false}},expected:1},
 ]){
  const f=fake(testCase.input),r=await svc.runOnce({...f,env});
  assert.equal(r.accepted,0);
  assert.equal(f.calls.filter(x=>x.send).length,testCase.expected);
  if(testCase.input.claimed!==false)assert.ok(f.calls.some(x=>
   x.sql?.includes("status='unknown'")));
 }
});

test("language selection reuses customer conversation evidence without guesswork",()=>{
 assert.equal(svc.customerTemplateLocale(["Hi", "我想了解这个护理"]),"zh_CN");
 assert.equal(svc.customerTemplateLocale(["How much is the treatment?"]),"en_US");
 assert.equal(svc.customerTemplateLocale(["Saya nak tahu harga"]),"ms");
 assert.equal(svc.customerTemplateLocale(["hi","ok"]),null);
 assert.equal(svc.customerTemplateLocale(["Please reply in English", "价钱?"]),"en_US");
});
test("Chinese contact receives only Chinese variant even with an English row enabled",async()=>{
 const english={...row,language_code:"en_US",template_name:"en_reminder",
  template_signature:"b".repeat(64)};
 const f=fake({candidates:[english,row]});
 const result=await svc.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
 assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts")).length,1);
 assert.equal(f.calls.filter(x=>x.send).length,1);
 assert.equal(f.calls.find(x=>x.send).send.templateRequest.languageCode,"zh_CN");
});
test("unrecognized or Malay language does not send Chinese or English templates",async()=>{
 for(const text of ["hi","Saya nak tahu harga"]){
  const f=fake({candidates:[{...row,customer_messages:[text]}]});
  const result=await svc.runOnce({...f,env});
  assert.deepEqual(result,{disabled:false,attempted:0,accepted:0});
  assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts")).length,0);
  assert.equal(f.calls.filter(x=>x.send).length,0);
 }
});
test("recheck rejects a changed customer language without sending to Meta",async()=>{
 const f=fake();
 let rechecks=0;
 const original=f.database.query;
 f.database.query=async(sql,args)=>{
  const result=await original(sql,args);
  if(sql===svc.RECHECK_SQL && ++rechecks>=1)
   return {rows:[{...row,customer_messages:["Please reply in English"]}]};
  return result;
 };
 const result=await svc.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,attempted:1,accepted:0});
 assert.equal(f.calls.filter(x=>x.send).length,0);
 assert.ok(f.calls.some(x=>x.sql?.includes("status='unknown'")));
});


test("marketing worker accepts consented ads-only full AI mode without Inbox staff access",async()=>{
 const fullAi={
  ...env,
  WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"true",
 };
 assert.equal(svc.enabled(fullAi),true);
 assert.equal(svc.enabled({...fullAi,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"test_only"}),false);
 assert.equal(svc.enabled({...fullAi,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"false"}),false);
 assert.equal(svc.enabled({...fullAi,WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"false"}),false);
 assert.equal(svc.enabled({...fullAi,WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"}),true);
 const f=fake();
 const result=await svc.runOnce({...f,env:fullAi});
 assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
 assert.equal(f.calls.find(x=>x.send).send.origin,"marketing_followup");
});

test("only 48h and approved 66h marketing slots are dispatched",async()=>{
 const f=fake({candidates:[{...row,slot_hours:66}]});
 const result=await svc.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
 assert.equal(f.calls.find(x=>x.send).send.origin,"marketing_followup");
 const legacy=fake({candidates:[{...row,slot_hours:72}]});
 const skipped=await svc.runOnce({...legacy,env});
 assert.deepEqual(skipped,{disabled:false,attempted:0,accepted:0});
 assert.equal(legacy.calls.filter(x=>x.send).length,0);
 assert.match(svc.CANDIDATES_SQL,/rule.slot_hours IN\(48,66\)/);
 assert.doesNotMatch(svc.CANDIDATES_SQL,/rule.slot_hours IN\(48,72\)/);
});

test("Day4/Day6 scheduler stays OFF while 48h/66h remain enabled",async()=>{
 const f=fake({candidates:[],extendedCandidates:[{...row,slot_hours:96}]});
 assert.equal(svc.extendedEnabled(env),false);
 assert.deepEqual(await svc.runOnce({...f,env}),{disabled:false,attempted:0,accepted:0});
 assert.equal(f.calls.some(x=>x.sql===svc.EXTENDED_CANDIDATES_SQL),false);
 assert.equal(f.calls.filter(x=>x.send).length,0);
});
test("Day4/Day6 require separate rollout switch for sender's approved followups",async()=>{
 const e={...env,WHATSAPP_SECONDARY_EXTENDED_DAY4_DAY6_ENABLED:"true"};
 assert.equal(svc.extendedEnabled(e),true);
 for(const slot of [96,144]){
  const f=fake({candidates:[],extendedCandidates:[{...row,slot_hours:slot,inbound_id:911}]});
  const result=await svc.runOnce({...f,env:e});
  assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
  assert.ok(f.calls.some(x=>x.sql===svc.EXTENDED_CANDIDATES_SQL));
  assert.ok(f.calls.some(x=>x.sql===svc.EXTENDED_RECHECK_SQL));
  assert.equal(f.calls.find(x=>x.send).send.templateRequest.languageCode,"zh_CN");
 }
});
test("extended SQL verifies nonbillable signed Meta proof from matching sender/ad session",()=>{
 const q=svc.EXTENDED_CANDIDATES_SQL;
 for(const fragment of [
  "rule.slot_hours IN(96,144)","whatsapp_free_entry_referrals referral",
  "referral.source_type='ad'","reply_context.conversation_id=sc.id",
  "receipt.sender_id=sa.id","receipt.matched=TRUE",
  "receipt.pricing_type='free_entry_point'","receipt.pricing_billable=FALSE",
  "receipt.meta_phone_number_id=sa.meta_phone_number_id",
  "receipt.meta_account_id=sa.meta_account_id",
  "qualified_session.origin_id AS inbound_id",
  "qualified_session.first_reply_at+rule.slot_hours",
  "INTERVAL '167 hours'","whatsapp_sender_billing_alarms",
  "whatsapp_sender_billing_gates",
  "other.status IN('accepted','unknown','blocked')",
 ] )assert.ok(q.includes(fragment),"Missing safeguard "+fragment);
 assert.match(svc.EXTENDED_RECHECK_SQL,/attempted.status='claimed'/);
 assert.doesNotMatch(svc.CANDIDATES_SQL,/qualified_session/);
});
test("extended slots do not bypass operator charge or template gates",async()=>{
 const e={...env,WHATSAPP_SECONDARY_EXTENDED_DAY4_DAY6_ENABLED:"true"};
 for(const name of ["WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED"]){
  const f=fake({candidates:[],extendedCandidates:[{...row,slot_hours:96}]});
  assert.deepEqual(await svc.runOnce({...f,env:{...e,[name]:"false"}}),
   {disabled:true,attempted:0,accepted:0});
  assert.equal(f.calls.length,0);
 }
});


test("marketing 48h/66h is anchored to first sender-owned reply and never guesses Malay locale",()=>{
 assert.match(svc.CANDIDATES_SQL,/first_reply\.at\+rule\.slot_hours/);
 assert.match(svc.CANDIDATES_SQL,/inbound\.created_at<=\$4::timestamptz-INTERVAL '24 hours'/);
 assert.match(svc.CANDIDATES_SQL,/reply_context\.conversation_id=sc\.id/);
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/qualified_session\.first_reply_at\+rule\.slot_hours/);
 assert.equal(svc.customerTemplateLocale(["Saya nak tanya pasal rawatan"]),"ms");
});

test("66h only follows a verified later customer response; silence is capped across both workers",()=>{
 for(const sql of [
   svc.CANDIDATES_SQL,svc.RECHECK_SQL,svc.POTENTIAL_DUE_SQL,
 ]){
   assert.match(sql,/rule\.slot_hours<>66 OR EXISTS/);
   assert.match(sql,/engaged\.created_at>first_reply\.at/);
   assert.match(sql,/engaged_context\.conversation_id=sc\.id/);
   assert.match(sql,/service_sent\.status='accepted'/);
   assert.match(sql,/marketing_sent\.status='accepted'/);
   assert.match(sql,/\) < 5/);
   assert.match(sql,/engagement\.created_at>first_reply\.at/);
   assert.match(sql,/imported_engagement\.sender_id=sa\.id/);
 }
 for(const sql of [
   svc.EXTENDED_CANDIDATES_SQL,svc.EXTENDED_RECHECK_SQL,svc.EXTENDED_POTENTIAL_DUE_SQL,
 ]){
   assert.match(sql,/engagement\.created_at>qualified_session\.first_reply_at/);
   assert.match(sql,/service_sent\.claimed_at>=qualified_session\.first_reply_at/);
   assert.match(sql,/marketing_sent\.claimed_at>=qualified_session\.first_reply_at/);
   assert.match(sql,/\) < 5/);
   assert.doesNotMatch(sql,/first_reply\.at/);
 }
});

test("Day 4 and Day 6 rely on verified ad-session first reply, not unrelated legacy contact creation",()=>{
 assert.doesNotMatch(svc.EXTENDED_CANDIDATES_SQL,/\) first_reply ON TRUE/);
 assert.doesNotMatch(svc.EXTENDED_CANDIDATES_SQL,/first_reply\.at/);
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/\) qualified_session ON TRUE/);
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/receipt\.pricing_type='free_entry_point'/);
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/first\.sent_by_username IS NULL/);
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/first\.is_automated_follow_up IS DISTINCT FROM TRUE/);
 assert.match(svc.EXTENDED_RECHECK_SQL,/\) qualified_session ON TRUE/);
 assert.match(svc.EXTENDED_POTENTIAL_DUE_SQL,/\) qualified_session ON TRUE/);
});

test("Day 4/6 never backfill ad sessions from before the rule was saved",()=>{
 assert.match(svc.EXTENDED_CANDIDATES_SQL,/qualified_session\.first_reply_at>=rule\.updated_at/);
 assert.match(svc.EXTENDED_RECHECK_SQL,/qualified_session\.first_reply_at>=rule\.updated_at/);
 assert.match(svc.EXTENDED_POTENTIAL_DUE_SQL,/qualified_session\.first_reply_at>=rule\.updated_at/);
 assert.match(svc.EXTENDED_POTENTIAL_DUE_SQL,/whatsapp_free_entry_referrals referral/);
 assert.match(svc.EXTENDED_POTENTIAL_DUE_SQL,/whatsapp_marketing_consent_events consent/);
});
test("Day 4 and Day 6 count accepted reminders in this verified ad session, not over the contact lifetime",()=>{
 const sql=svc.EXTENDED_CANDIDATES_SQL;
 assert.match(sql,/other\.claimed_at>=qualified_session\.first_reply_at/);
 assert.match(sql,/sent\.claimed_at>=qualified_session\.first_reply_at/);
 assert.match(sql,/sent\.claimed_at<qualified_session\.first_reply_at\+INTERVAL '167 hours'/);
 assert.match(sql,/other\.status IN\('accepted','unknown','blocked'\)/);
 // Historic uncertain receipts remain a global safety hold until reviewed.
 assert.match(sql,/bad\.anchor_message_id IS NOT NULL/);
 assert.match(sql,/gate\.state<>'idle'/);
});
test("extended Day 4/6 due-time hint checks both workers without an extra poll when disabled",async()=>{
 const time=new Date("2026-11-11T04:00:00Z");
 const calls=[];
 const database={query:async(sql,params)=>{
   calls.push({sql,params});
   if(sql===svc.POTENTIAL_DUE_SQL)return {rows:[{next_due_at:new Date("2026-11-12T04:00:00Z"),has_overdue:false}]};
   if(sql===svc.EXTENDED_POTENTIAL_DUE_SQL)return {rows:[{next_due_at:new Date("2026-11-11T15:00:00Z"),has_overdue:true}]};
   throw Error("Unexpected SQL hint");
 }};
 const ordinary=await svc.nextPotentialDueAt({database,env,now:time});
 assert.equal(calls.length,1);
 assert.equal(new Date(ordinary.next_due_at).toISOString(),"2026-11-12T04:00:00.000Z");
 const hint=await svc.nextPotentialDueAt({database,env:{
   ...env,WHATSAPP_SECONDARY_EXTENDED_DAY4_DAY6_ENABLED:"true",
 },now:time});
 assert.equal(calls.length,3);
 assert.equal(new Date(hint.next_due_at).toISOString(),"2026-11-11T15:00:00.000Z");
 assert.equal(hint.has_overdue,true);
});
