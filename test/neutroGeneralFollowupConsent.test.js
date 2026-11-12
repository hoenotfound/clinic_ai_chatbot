"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const consent=require("../src/utils/neutroGeneralFollowupConsent");
const inbound=require("../src/db/whatsappInboundConsentRepo");
const service=require("../src/services/whatsappSecondaryFollowUpService");

test("general six-day invitation is optional, scoped and preserves STOP",()=>{
 for(const language of ["zh","en","ms"]){
  const sentence=consent.SENTENCES[language];
  const invitation=consent.invitation(language);
  assert.ok(invitation.includes(sentence));
  assert.match(invitation,/Neutro Sense TCM/);
  assert.doesNotMatch(invitation,/STOP PROMOTIONS|停止优惠/);
  const captured=consent.explicitGeneralFollowupConsent(sentence);
  assert.deepEqual(captured,{
   language,category:"MARKETING",
   scope:"general_clinic_followups_and_related_offers",
   service:"neutro_general_tcm_care",
   method:"customer_whatsapp_text"
  });
 }
});
test("ad prefills, unsupported messages and ordinary acknowledgements are NEVER general marketing consent",()=>{
 for(const text of [
  "你好！想了解你们家的【黄金脉冲技术】",
  "📎 [Customer sent a WhatsApp message that could not be displayed]",
  "Yes","I agree","OK","好的","可以","我想了解骨盆调理",
  "No, don't send me WhatsApp promotions",
  "I agree to receive WhatsApp follow-ups and related offers",
  "Neutro Sense TCM",
  "Saya setuju","stop promotions",
  consent.SENTENCES.zh+"不要",
 ]){
  assert.equal(consent.explicitGeneralFollowupConsent(text),null,text);
 }
});
test("secondary 6h text and 20h customer service slots can invite consent without granting marketing permission",()=>{
 const src=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const inboundClaim=fs.readFileSync(path.join(__dirname,"../src/services/inboundMessageClaimService.js"),"utf8");
 const repoSrc=fs.readFileSync(path.join(__dirname,"../src/db/whatsappInboundConsentRepo.js"),"utf8");
 assert.match(src,/slot===6 \|\| slot===20/);
 assert.match(src,/generalSixDay\.enabled\(env\)/);
 assert.match(src,/candidate\.lead_marketing_consent!=="opted_in"/);
 assert.match(src,/candidate\.recovery_no_selection===true \|\|/);
 assert.match(src,/candidate\.verified_meta_ad===true/);
 assert.match(src,/invitationText\(outboundText,replyLanguage/);
 assert.match(src,/verified_meta_ad/);
 assert.match(inboundClaim,/explicitGeneralFollowupConsent\(incoming\?\.text\)/);
 assert.match(repoSrc,/!isClickToWhatsApp/);
 assert.match(repoSrc,/sender_key='neutro_secondary'/);
 assert.match(repoSrc,/prompt\.is_automated_follow_up=TRUE/);
 assert.match(repoSrc,/prompt\.delivery_status IN \('sent','delivered','read'\)/);
 assert.match(repoSrc,/prompt\.content LIKE/);
 assert.match(repoSrc,/generalExplicit\?GENERAL_SCOPE:explicit\.scope/);
 assert.match(repoSrc,/generalExplicit\?GENERAL_SERVICE/);
 assert.doesNotMatch(service.CANDIDATES_SQL,/general_clinic_followups_and_related_offers/,
  "service follow-ups do not claim any marketing permission");
});


test("a generic opt-in records only after a delivered secondary invitation, never from a prefilled ad",async()=>{
 const phrase=consent.SENTENCES.en;
 const now=new Date().toISOString();
 function fake({verified,click=false}={}){
  const calls=[];
  const client={
   async query(sql,params=[]){
    calls.push({sql,params});
    if(sql.includes("SELECT id, channel"))return {rows:[{
      id:101,channel:"whatsapp",whatsapp_opt_in_at:null,
      whatsapp_opt_out_at:null,whatsapp_marketing_opt_out_at:null,
    }]};
    if(sql.includes("SELECT id, role, content"))return {rows:[{
      id:202,role:"user",content:phrase,
      whatsapp_message_id:"wamid.user-general-opt-in",
      sent_at:now,is_forwarded:false,media_mime_type:null,
    }]};
    if(sql.includes("AS verified"))return {rows:[{verified}]};
    if(sql.startsWith("SELECT id FROM leads"))return {rows:[{id:303}]};
    if(sql.includes("INSERT INTO whatsapp_marketing_consent_events"))
      return {rowCount:1,rows:[{id:404}]};
    return {rowCount:1,rows:[]};
   },release(){},
  };
  return {calls,database:{connect:async()=>client},click};
 }
 for(const c of [{verified:false},{verified:true,click:true}]){
  const {calls,database,click}=fake(c);
  const result=await inbound.recordFromInbound({
   contactId:101,messageId:202,leadId:303,
   businessName:"Neutro Sense TCM Centre",
   isClickToWhatsApp:click===true,
  },{database});
  assert.equal(result.recorded,false);
  assert.equal(calls.some(x=>x.sql.includes("INSERT INTO whatsapp_marketing_consent_events")),false);
 }
 const {calls,database}=fake({verified:true});
 const result=await inbound.recordFromInbound({
  contactId:101,messageId:202,leadId:303,
  businessName:"Neutro Sense TCM Centre",
 },{database});
 assert.equal(result.recorded,true);
 const inserted=calls.find(x=>x.sql.includes("INSERT INTO whatsapp_marketing_consent_events"));
 assert.ok(inserted);
 assert.equal(inserted.params[7],consent.GENERAL_SCOPE);
 assert.equal(inserted.params[11],consent.GENERAL_SERVICE);
 assert.equal(inserted.params[5],phrase);
 assert.equal(calls.some(x=>x.sql.startsWith("COMMIT")),true);
});

test("exact one-tap button is message-bound, language-bound and has a bounded video caption",()=>{
 for(const language of ["zh","en","ms"]){
  const buttons=consent.consentButtons(345,language);
  assert.equal(buttons.length,1);
  assert.deepEqual(consent.parseConsentButton(buttons[0].id),{
   promptId:345,language,title:buttons[0].title,
  });
  assert.ok(buttons[0].title.length<=20);
  const small=consent.invitationText("Follow-up video information",language,{video:true});
  assert.ok(small.includes(consent.SENTENCES[language]));
  assert.ok(Buffer.byteLength(small,"utf8")<=1024);
  const long=consent.invitationText("长".repeat(900),language,{video:true});
  assert.ok(long.includes(consent.SENTENCES[language]));
  assert.ok(Buffer.byteLength(long,"utf8")<=1024);
 }
 for(const id of ["neutro_general_six_day_yes:0:zh",
   "neutro_general_six_day_yes:7:fr",
   "neutro_general_six_day_yes:7", "da_consent_yes:7",
   "neutro_general_six_day_yes:7:en:extra"]){
  assert.equal(consent.parseConsentButton(id),null);
 }
 assert.deepEqual(consent.consentButtons(0,"en"),[]);
 assert.equal(consent.explicitGeneralFollowupConsent("Yes, send updates"),null);
});

test("one-tap general consent requires actual sender-owned delivery and correct button title",async()=>{
 const now=new Date().toISOString();
 const button=consent.consentButtons(321,"en")[0];
 for(const state of [
  {verified:false,expected:false},
  {verified:true,wrongTitle:true,expected:false},
  {verified:true,expected:true},
 ]){
  const calls=[];
  const client={async query(sql,params=[]){
   calls.push({sql,params});
   if(sql.includes("SELECT id, channel"))return {rows:[{
    id:101,channel:"whatsapp",whatsapp_opt_in_at:null,
    whatsapp_opt_out_at:null,whatsapp_marketing_opt_out_at:null,
   }]};
   if(sql.includes("SELECT id, role, content"))return {rows:[{
    id:202,role:"user",content:state.wrongTitle?"Random button":button.title,
    whatsapp_message_id:"wamid.signed-button-reply",
    sent_at:now,is_forwarded:false,media_mime_type:null,
   }]};
   if(sql.includes("AS verified"))return {rows:[{verified:state.verified}]};
   if(sql.startsWith("SELECT id FROM leads"))return {rows:[{id:303}]};
   if(sql.includes("INSERT INTO whatsapp_marketing_consent_events"))
    return {rows:[{id:404}],rowCount:1};
   return {rows:[],rowCount:1};
  },release(){}};
  const result=await inbound.recordFromInbound({
   contactId:101,messageId:202,leadId:303,businessName:"Neutro Sense TCM Centre",
   interactiveReplyId:button.id,
  },{database:{connect:async()=>client}});
  assert.equal(result.recorded,state.expected);
  const proof=calls.find(x=>x.sql.includes("AS verified"));
  if(!state.wrongTitle){
   assert.equal(proof.params[3],321);
   assert.equal(proof.params[4],"en");
   assert.equal(proof.params[5],303);
   assert.match(proof.sql,/generalConsentButton/);
   assert.match(proof.sql,/current_lead\.created_at<=prompt\.created_at/);
  }
  const insert=calls.find(x=>x.sql.includes("INSERT INTO whatsapp_marketing_consent_events"));
  assert.equal(Boolean(insert),state.expected);
  if(insert){
   assert.equal(insert.params[2],"customer_whatsapp_button");
   assert.equal(insert.params[7],consent.GENERAL_SCOPE);
   assert.equal(insert.params[10],"customer_whatsapp_interactive_button");
  }
 }
});
