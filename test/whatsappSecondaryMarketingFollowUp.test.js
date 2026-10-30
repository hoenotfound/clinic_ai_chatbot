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
function fake({candidates=[row],claimed=true,approved=true,
  sendResult={success:true,wamid:"wamid.secondary-approved"}}={}){
 const calls=[];
 return{
 calls,
 database:{query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql===svc.CANDIDATES_SQL){
   assert.equal(args.length,6,"candidate selection binds the ads-only cutoff");
   assert.equal(args[5],new Date(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT).toISOString());
   return{rows:candidates};
  }
  if(sql===svc.RECHECK_SQL){
   assert.equal(args.length,6,"pre-send recheck must bind the same ads-only cutoff");
   assert.equal(args[5],new Date(env.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT).toISOString());
   return{rows:candidates};
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
 assert.equal(svc.customerTemplateLocale(["Saya nak tahu harga"]),"ms_MY");
 assert.equal(svc.customerTemplateLocale(["hi","ok"]),null);
 assert.equal(svc.customerTemplateLocale(["请用英文回答", "价钱?"]),"en_US");
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
