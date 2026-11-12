"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const svc=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const generic=require("../src/services/neutroSecondaryGeneralMarketingSql");
const {pinned}=require("../src/services/neutroSecondaryGeneralMarketingTemplates");

const env={
 PR395_STAGING_MODE:"false",WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
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
 WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"true",
 WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"true",
 WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:"2026-11-12T08:00:00.000Z",
};
function fake(slot,language,{validSignature=true,authorized=true,claim=true,accepted=true}={}){
 const expected=pinned(slot,language);
 const candidate={
  contact_id:22,channel:"whatsapp",whatsapp_number:"60123456789",
  whatsapp_sender_id:5,whatsapp_sender_key:"neutro_secondary",
  sender_id:5,conversation_id:44,inbound_id:99,slot_hours:slot,
  template_name:expected.name,language_code:language,
  template_signature:null,customer_messages:["I agree to receive WhatsApp follow-ups..."],
  rule_updated_at:new Date("2026-11-12T08:00:00Z"),treatment_interest:null,
  general_campaign:true,consent_id:101,
 };
 const raw={id:expected.id,name:expected.name,language,status:"APPROVED",
   category:"MARKETING",components:[{type:"BODY",text:validSignature
     ?expected.body:expected.body+" change"}]};
 const calls=[];
 const database={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql===svc.CANDIDATES_SQL)return {rows:[]};
  if(sql===generic.CANDIDATES_SQL)return {rows:[candidate]};
  if(sql===generic.RECHECK_SQL)return {rows:authorized?[candidate]:[]};
  if(sql.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts"))
    return {rows:claim?[{id:123}]:[]};
  return {rows:[],rowCount:1};
 }};
 const contacts={getContactById:async()=>({id:22,channel:"whatsapp",whatsapp_number:"60123456789",
  whatsapp_sender_key:"neutro_secondary",whatsapp_sender_id:5})};
 const store={saveMessage:async(...a)=>{calls.push({save:a});return{id:200}},
  setWhatsappMessageId:async(...a)=>{calls.push({persist:a})}};
 const templatePolicy={previewSecondaryTemplatePolicy:async(contact,options)=>{
  calls.push({preview:options});
  return {policyAllowed:true,template:{category:"MARKETING",definition:raw}};
 }};
 const send=async params=>{calls.push({send:params});return accepted?
  {success:true,wamid:"wamid.generic-approved"}:
  {success:false,unknown:true,ambiguous:true,retryable:false}};
 return {calls,database,contacts,store,templatePolicy,send,expected};
}

test("all 12 static general variants can use the billed one-shot sender with scoped consent",async()=>{
 assert.equal(generic.enabled(env),true);
 for(const slot of [48,66,96,144])for(const language of ["zh_CN","en_US","ms"]){
  const f=fake(slot,language);
  const outcome=await svc.runOnce({...f,env,limit:2});
  assert.deepEqual(outcome,{disabled:false,attempted:1,accepted:1});
  const send=f.calls.find(x=>x.send)?.send,save=f.calls.find(x=>x.save)?.save;
  assert.equal(send.origin,"marketing_followup");
  assert.equal(send.templateRequest.treatmentInterest,null);
  assert.equal(send.templateRequest.languageCode,language);
  assert.equal(send.templateRequest.name,f.expected.name);
  assert.equal(send.templateRequest.expectedSignature,f.expected.signature);
  assert.equal(save[8].whatsappTemplate.generalCampaign,true);
  assert.equal(save[8].whatsappTemplate.consentId,101);
  assert.ok(f.calls.some(x=>x.sql===generic.RECHECK_SQL));
  assert.ok(f.calls.some(x=>x.sql?.includes("INSERT INTO whatsapp_sender_marketing_followup_attempts")));
 }
});
test("generic sends fail closed for opt-out/current-check failure, modified approved content, or unknown Meta outcome",async()=>{
 const cases=[{opts:{authorized:false},sends:0},
  {opts:{validSignature:false},sends:0},
  {opts:{claim:false},sends:0},
  {opts:{accepted:false},sends:1}];
 for(const c of cases){
  const f=fake(48,"zh_CN",c.opts);
  const outcome=await svc.runOnce({...f,env,limit:2});
  assert.equal(outcome.accepted,0);
  assert.equal(f.calls.filter(x=>x.send).length,c.sends);
 }
});
test("generic campaign is inactive when either feature or billable approval is missing",async()=>{
 for(const flag of ["WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED",
   "WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED"]){
  const e={...env,[flag]:"false"},f=fake(48,"en_US");
  const o=await svc.runOnce({...f,env:e});
  assert.deepEqual(o,{disabled:false,attempted:0,accepted:0});
  assert.equal(f.calls.filter(x=>x.send).length,0);
  assert.equal(f.calls.filter(x=>x.sql===generic.CANDIDATES_SQL).length,0);
 }
});

test("a new reply after discovery releases only an unsent claim for later scheduling",async()=>{
 const f=fake(48,"en_US",{authorized:false});
 const query=f.database.query;
 f.database.query=async(sql,args)=>{
  if(sql.includes("DELETE FROM whatsapp_sender_marketing_followup_attempts attempt")){
   f.calls.push({sql,args});
   return {rows:[{id:123}],rowCount:1};
  }
  return query(sql,args);
 };
 const outcome=await svc.runOnce({...f,env,limit:2});
 assert.equal(outcome.accepted,0);
 assert.equal(f.calls.filter(x=>x.send).length,0);
 assert.equal(f.calls.filter(x=>x.save).length,0);
 assert.equal(f.calls.filter(x=>x.sql?.includes("DELETE FROM whatsapp_sender_marketing_followup_attempts attempt")).length,1);
 assert.equal(f.calls.filter(x=>x.sql?.includes("SET status='unknown'")).length,0);
});
