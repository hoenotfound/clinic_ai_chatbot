"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {resolveAdFollowUpTreatment,neutralMixedAdFollowUp}=
  require("../src/utils/adFollowUpTreatment");
const {resolveResultMediaForReply}=require("../src/utils/resultMediaTrigger");
const {messageForCandidate}=require("../src/services/followUpService");
const {localizedFollowUpText}=require("../src/services/whatsappSecondaryFollowUpLanguage");

const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const serviceAliases=[
 {alias:"3D",officialService:"3D 小颜术"},
 {alias:"3D小颜术",officialService:"3D 小颜术"},
 {alias:"3D中医小颜术",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"},
 {alias:"9D逆龄抗衰",officialService:"9D 逆龄抗衰"},
 {alias:"9D逆龄抗衰精雕",officialService:"9D 逆龄抗衰"},
 {alias:"pelvic",officialService:"骨盆调理"},
];
const mixed={
 adSource:"meta_ads",headline:"由认证中医师操作",
 body:"我们有两种不同的小颜方式：3D中医小颜术主打脸型轮廓，9D逆龄抗衰精雕则针对松弛紧致。不确定自己是哪种？私讯我们了解。",
 services,serviceAliases,
};
const only3d={...mixed,body:"3D小颜术主打脸型轮廓，帮助改善双下巴"};
const only9d={...mixed,body:"9D逆龄抗衰精雕专注紧致提升"};
const step={
 message:"General treatment follow-up",
 translations:{en:"General treatment follow-up",zh:"你之前咨询的护理，有任何问题可以继续问我们 😊",ms:"Susulan rawatan umum"},
 serviceOverrides:[
   {serviceName:"3D 小颜术",message:"3D treatment only",translations:{en:"3D treatment only",zh:"3D 小颜术专属跟进"}},
   {serviceName:"9D 逆龄抗衰",message:"9D treatment only",translations:{en:"9D treatment only",zh:"9D 逆龄专属跟进"}},
 ],
};
function candidate(policy){
 return {
   treatment_interest:"3D 小颜术", // Cherry's stale CRM selection
   recent_inbound_messages:["Pm"],recent_service_messages:["Pm"],
   trigger_message_content:"你是想了解脸型轮廓，还是皮肤松弛紧致呢？",
   adFollowUpPolicy:policy,
 };
}
test("Cherry: two-service creative + PM must not infer 3D from CRM or ad name",()=>{
 const policy=resolveAdFollowUpTreatment({...mixed,customerTexts:["Pm"]});
 assert.equal(policy?.ambiguous,true);
 assert.equal(policy?.treatment,null);
 assert.deepEqual(policy?.creativeMatches?.sort(),["3D 小颜术","9D 逆龄抗衰"].sort());
 const selected=messageForCandidate(step,candidate(policy),"zh",1);
 assert.equal(selected.targetedService,null);
 assert.equal(selected.targetedMediaService,null);
 const withDefaultMedia=messageForCandidate({...step,
   imageUrl:"https://example.test/3d-default.jpg",
   videoKey:"3d-video",
   videoFilename:"3d.mp4",
 },candidate(policy),"zh",1);
 assert.equal(withDefaultMedia.selectedImageUrl,"");
 assert.equal(withDefaultMedia.selectedVideoKey,"");
 assert.equal(withDefaultMedia.selectedVoiceNote,null);
 assert.match(selected.message,/3D/);
 assert.match(selected.message,/9D/);
 assert.doesNotMatch(selected.message,/3D 小颜术专属跟进|9D 逆龄专属跟进/);
 assert.equal(neutralMixedAdFollowUp({policy,language:"en",slot:2}).includes("3D"),true);
 assert.equal(neutralMixedAdFollowUp({policy,language:"ms",slot:2}).includes("9D"),true);
 assert.equal(neutralMixedAdFollowUp({policy,language:"zh",slot:6}),null);
 assert.equal(localizedFollowUpText({
   slot:2,originalText:"configured fallback",customerTexts:["Pm"],
   languageEvidenceTexts:["你是想了解脸型轮廓还是皮肤松弛紧致？"],
   treatmentInterest:"3D 小颜术",forceGeneral:true,
   clinicConfig:{services,serviceAliases,
     automatedFollowUp:{...step}},
 }),step.translations.zh);
});
test("latest customer selection overrides mixed creative and stale CRM",()=>{
 for(const [msg,expected] of [
   ["3D","3D 小颜术"],["我想了解3D小颜术","3D 小颜术"],
   ["9D","9D 逆龄抗衰"],["I prefer 9D","9D 逆龄抗衰"],
 ]) {
   const policy=resolveAdFollowUpTreatment({...mixed,customerTexts:[msg,"Pm"]});
   assert.equal(policy?.ambiguous,false,msg);
   assert.equal(policy.treatment,expected,msg);
   const selection=messageForCandidate(step,candidate(policy),"en",1);
   assert.equal(selection.targetedService,expected,msg);
   assert.equal(selection.message,expected==="3D 小颜术"?"3D treatment only":"9D treatment only",msg);
 }
 for(const msg of ["Should I choose 3D or 9D?","3D还是9D哪个更适合？",
   "What is the difference between 3D and 9D?",
   "I don't want 3D","I want to compare 3D vs 9D"]) {
   const policy=resolveAdFollowUpTreatment({...mixed,customerTexts:[msg,"Pm"]});
   assert.equal(policy?.ambiguous,true,msg);
   assert.equal(policy?.treatment,null,msg);
 }
});
test("single verified Meta creative may inform a generic enquiry without guessing from the ad name",()=>{
 for(const [ad,wanted] of [[only3d,"3D 小颜术"],[only9d,"9D 逆龄抗衰"]]){
   const policy=resolveAdFollowUpTreatment({...ad,customerTexts:["Pm"]});
   assert.equal(policy?.ambiguous,false);
   assert.equal(policy.treatment,wanted);
   assert.equal(messageForCandidate(step,candidate(policy),"en",1).targetedService,wanted);
 }
 for(const ad of [
   {...mixed,adSource:null},
   {...only3d,body:"",headline:"KKM certified"},
 ]) {
   const policy=resolveAdFollowUpTreatment({...ad,customerTexts:["Pm"]});
   if(ad.adSource===null) assert.equal(policy,null);
   else assert.equal(policy.ambiguous,true);
 }
});
test("after explicit 3D or 9D selection, existing Before & After rules pick only matching media",async()=>{
 const media=services.slice(0,2).map(s=>({
   service:s.name,enabled:true,triggerMode:"service_enquiry",autoSendCount:1,
   items:[{imageUrl:"https://example.test/"+(s.name.startsWith("3D")?"3d":"9d")+".jpg",
     caption:"Verified result example"}]
 }));
 const base={
   treatment:null,serviceQuery:false,serviceQuerySource:null,
   priceQuery:false,packageQuery:false,
   flagged:false,bookingReady:false,needsAttention:false,
   textSendSucceeded:true,keywordReason:null,
   resultMedia:media,services,serviceAliases,contactId:49,
   wasMediaRecentlySent:async()=>false,
   hasUnconfirmedMediaDelivery:async()=>false,
   getMostRecentlySentMediaUrl:async()=>null,
 };
 for(const [customerText,service,url] of [
   ["3D","3D 小颜术","https://example.test/3d.jpg"],
   ["9D","9D 逆龄抗衰","https://example.test/9d.jpg"],
 ]) {
   const result=await resolveResultMediaForReply({...base,customerText,
     priorResultContextRows:[{
       role:"assistant",
       content:"你是想了解脸型轮廓还是皮肤松弛紧致呢？",
       sent_by_username:null,media_url:null,media_mime_type:null,
       delivery_status:"delivered",whatsapp_message_id:"wamid.verified-clarification",
     }],
   });
   assert.equal(result?.service,service,customerText);
   assert.deepEqual(result?.items?.map(i=>i.imageUrl),[url]);
 }
 for(const customerText of ["Pm","3D or 9D?","What about both 3D and 9D?"]){
   assert.equal(await resolveResultMediaForReply({...base,customerText}),null,customerText);
 }
 // Bare treatment names do NOT generally authorize images. Only a
 // recent, same-contact bot question about treatment choice does.
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"3D",priorResultContextRows:[],
 }),null,"no prior treatment-choice question");
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"9D",priorResultContextRows:[{
     role:"assistant",content:"How can I help?",
     sent_by_username:null,
   }],
 }),null,"generic bot reply cannot authorize images");
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"3D",priorResultContextRows:[{
     role:"assistant",content:"3D or 9D? Which would you prefer?",
     sent_by_username:"staff",
   }],
 }),null,"staff question is not an automatic media trigger");
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"3D",needsAttention:true}),null);
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"9D",wasMediaRecentlySent:async()=>true}),null);
 // An undelivered, unconfirmed or staff-authored question is not proof.
 assert.equal(await resolveResultMediaForReply({
   ...base,customerText:"3D",priorResultContextRows:[{
     role:"assistant",content:"Would you prefer 3D or 9D?",
     sent_by_username:null,delivery_status:"failed",
     whatsapp_message_id:"wamid.not-delivered",
   }],
 }),null,"failed clarification cannot authorize photos");
 const chosenOverStaleModel=await resolveResultMediaForReply({
   ...base,customerText:"3D",serviceQuery:true,serviceQuerySource:"meta_ad",
   treatment:"9D 逆龄抗衰",metaAdCreativeService:null,
   priorResultContextRows:[{
     role:"assistant",content:"Would you prefer 3D or 9D?",
     sent_by_username:null,delivery_status:"sent",
     whatsapp_message_id:"wamid.accepted-clarification",
   }],
 });
 assert.equal(chosenOverStaleModel?.service,"3D 小颜术",
   "verified customer choice overrides a stale model-selected treatment");
});
test("verified single-service ad can provide context for a generic explicit enquiry",async()=>{
 const media=[{
   service:"3D 小颜术",enabled:true,triggerMode:"service_enquiry",
   autoSendCount:1,items:[{imageUrl:"https://example.test/3d.jpg",caption:"3D example"}],
 }];
 const selected=await resolveResultMediaForReply({
   customerText:"Can I know more on this",priorCustomerTexts:[],
   metaAdCreativeService:"3D 小颜术",
   serviceQuerySource:"meta_ad",serviceQuery:false,treatment:null,
   flagged:false,bookingReady:false,needsAttention:false,
   textSendSucceeded:true,keywordReason:null,priceQuery:false,packageQuery:false,
   resultMedia:media,services,serviceAliases,contactId:49,
   wasMediaRecentlySent:async()=>false,
   hasUnconfirmedMediaDelivery:async()=>false,
   getMostRecentlySentMediaUrl:async()=>null,
 });
 assert.equal(selected?.service,"3D 小颜术");
 assert.deepEqual(selected?.items?.map(item=>item.imageUrl),["https://example.test/3d.jpg"]);
});

test("ad creative provides context unless newer verified secondary customer choice wins",()=>{
 const primary=fs.readFileSync(path.join(__dirname,"../src/db/followUpRepo.js"),"utf8");
 const secondary=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const main=fs.readFileSync(path.join(__dirname,"../src/services/followUpService.js"),"utf8");
 const personalized=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryPersonalizedFollowUp.js"),"utf8");
 for(const source of [primary,secondary]){
   assert.match(source,/ad_followup\.headline/);
   assert.match(source,/ad_followup\.body/);
   assert.match(source,/attribution\.lead_id = (?:latest_lead|lead)\.id/);
 }
 assert.match(main,/adFollowUpPolicy\?\.ambiguous/);
 assert.match(main,/needsAiWork =[\s\S]{0,150}!candidate\.adFollowUpPolicy\?\.ambiguous/);
 // Secondary prioritizes a newer sender-verified customer choice over the
 // original ad; primary retains its existing creative-first fallback.
 assert.match(secondary,/chooseSecondaryFollowUpTreatment/);
 assert.match(secondary,/const effectivePolicy=confirmedTreatment/);
 assert.match(secondary,/if\(slot===20 && !generalOnly/);
 assert.match(personalized,/candidate\.adFollowUpPolicy/);
});
