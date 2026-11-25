"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {isExplicitRm68Interest,isRm68ClinicalConcern}=
  require("../src/utils/neutroRm68InterestEvidence");
const {recordRm68CustomerInterest,CAMPAIGN}=require("../src/db/neutroRm68InterestRepo");
const {hasClinicalMediaRisk,isBreastLumpConcern,categorizeAiReview}=
  require("../src/utils/aiReviewPolicy");
const config={businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",
 services:[{name:"脉冲波调理"},{name:"草药胸部疏通乳腺护理"}]};
const prefill="Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";

test("only explicit customer RM68 breast-care interest qualifies for campaign evidence",()=>{
 for(const text of [prefill,
  "我想了解胸部 RM68 体验优惠", "Interested in RM68 breast care trial",
  prefill+" 請問有結節的人可以參加？"])
  assert.equal(isExplicitRm68Interest(text),true,text);
 for(const text of ["RM388 脉冲波护理","胸部健康有结节","RM68 是给谁的广告？",
  "我对骨盆调理感兴趣","我不感兴趣胸部 RM68 优惠"])
  assert.equal(isExplicitRm68Interest(text),false,text);
});

test("RM68 is a campaign ONLY: never update lead treatment, booking, marketing consent or appointment",async()=>{
 let sql,params,calls=0;
 const result=await recordRm68CustomerInterest({
  contactId:9232,messageId:22289,text:prefill,clinicConfig:config,
  database:{query:async(q,args)=>{
   sql=q;params=args;calls++;
   return{rows:[{verified:true,event_recorded:true}]};
  }},
 });
 assert.equal(result.verified,true);
 assert.equal(calls,1);
 assert.deepEqual(params,[9232,22289,prefill,CAMPAIGN,false]);
 assert.match(sql,/m\.role='user'/);
 assert.match(sql,/m\.whatsapp_message_id IS NOT NULL/);
 assert.match(sql,/customer_campaign_interest/);
 assert.match(sql,/medicalReviewNeeded/);
 assert.doesNotMatch(sql,/UPDATE\s+leads|UPDATE\s+contacts|treatment_interest|appointment_status|SET\s+marketing_consent/i);
 // Neither a paid booking nor an unrelated staff selected treatment can be
 // overwritten when CRM interest is recorded as an independent activity.
 assert.doesNotMatch(sql,/UPDATE /i);
});

test("other clinics, unsafe identities and unverifiable customer messages don't write",async()=>{
 let calls=0;
 const database={query:async()=>{calls++;throw Error("Unexpected DB call");}};
 for(const opts of [
  {text:"Neutro 胸 Jesi Number - 14/11/2026",clinicConfig:config},
  {text:prefill,clinicConfig:{...config,businessName:"Other"}},
  {text:prefill,clinicConfig:{...config,businessType:"aesthetic_clinic"}},
  {text:prefill,clinicConfig:null},
  {text:prefill,clinicConfig:config,messageId:0},
 ]){
  const result=await recordRm68CustomerInterest({
   contactId:9265,messageId:22844,database,...opts,
  });
  assert.equal(result.matched,false);
 }
 assert.equal(calls,0);
});

test("clinical RM68 questions are independently clinical even if AI says information",async()=>{
 const medical=prefill+" 請問有結節的人可以參加？";
 assert.equal(isExplicitRm68Interest(medical),true);
 assert.equal(isRm68ClinicalConcern(medical),true);
 let sql,params;
 await recordRm68CustomerInterest({
  contactId:9265,messageId:22844,text:medical,clinicConfig:config,
  database:{query:async(q,p)=>{sql=q;params=p;return{rows:[
   {verified:true,event_recorded:true},
  ]};}},
 });
 assert.equal(params[4],true);
 assert.match(sql,/medicalReviewNeeded/);
 for(const v of [medical,"我有乳腺结节，RM68 还有优惠吗？",
  "胸有瘤可以做吗？","Breast lump: is the RM68 promotion still available?"]){
  assert.equal(isBreastLumpConcern(v),true,v);
  assert.equal(hasClinicalMediaRisk(v),true,v);
  assert.equal(categorizeAiReview(v,"information"),"clinical",v);
 }
 for(const value of ["胸有瘤可以做吗？","胸部有瘤","乳瘤","乳腺结节"])
  assert.equal(isRm68ClinicalConcern(value),true,value);
 assert.equal(isBreastLumpConcern("RM68 胸部护理还有名额吗？"),false);
});

test("server enforces clinical review before sales media and keeps RM68 manual-only capture",()=>{
 const server=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 const classify=server.indexOf("neutroRm68InterestRepo.recordRm68CustomerInterest");
 const exit=server.indexOf("if (secondaryInboxOnly && !mediaType && !unsupportedType)");
 assert.ok(classify>0&&exit>classify);
 assert.match(server,/isBreastLumpConcern\(text\)/);
 assert.match(server,/reviewType = "clinical"/);
 assert.match(server,/setAiReviewAttention\(/);
});

test("an RM68 Booking Ready outcome preserves slot but cannot write a herbal treatment",()=>{
 const {sanitizeRm68BookingReadyDetails}=require("../src/utils/neutroRm68BookingSafety");
 const {firstReply}=require("../src/utils/neutroBreastRm68Campaign");
 const history=[
   {role:"user",content:prefill},
   {role:"assistant",content:firstReply(Date.parse("2026-11-22T02:00:00Z"))},
   {role:"user",content:"好的，麻烦帮我安排24/11 12pm"},
 ];
 const modelDetails={treatment:"草药胸部疏通乳腺护理",
   appointmentPreference:"24/11 12pm",
   staffSummary:"Herbal breast treatment arranged",
 };
 const guarded=sanitizeRm68BookingReadyDetails({
  details:modelDetails,customerText:"好的，麻烦帮我安排24/11 12pm",
  history,channel:"whatsapp",clinicConfig:config,
 });
 assert.equal(guarded.treatment,null);
 assert.equal(guarded.appointmentPreference,"24/11 12pm");
 assert.match(guarded.staffSummary,/RM68 enquiry/);
 assert.equal(sanitizeRm68BookingReadyDetails({
  details:modelDetails,customerText:"24/11 12pm 方便吗",
  history:[{role:"user",content:"24/11 12pm 方便吗"}],
  channel:"whatsapp",clinicConfig:config,
 }).treatment,null,"do not infer herbal care when the RM68 opener was trimmed");
 assert.equal(sanitizeRm68BookingReadyDetails({
  details:modelDetails,customerText:"我想了解草药胸部疏通乳腺护理",
  history:[],channel:"whatsapp",clinicConfig:config,
 }).treatment,null,
 "asking to learn about herbal care is not a booking choice");
 assert.equal(sanitizeRm68BookingReadyDetails({
  details:modelDetails,customerText:"我想做草药胸部疏通乳腺护理",
  history:[],channel:"whatsapp",clinicConfig:config,
 }).treatment,"草药胸部疏通乳腺护理",
 "a customer who affirmatively selects herbal care remains eligible");
 assert.equal(modelDetails.treatment,"草药胸部疏通乳腺护理",
  "do not mutate original model output");
 assert.deepEqual(sanitizeRm68BookingReadyDetails({
  details:{...modelDetails,treatment:"3D 小颜术"},
  customerText:"我想做3D 小颜术",history,channel:"whatsapp",
  clinicConfig:config,
 }).treatment,"3D 小颜术");
 assert.equal(sanitizeRm68BookingReadyDetails({
  details:modelDetails,customerText:"预约胸部护理",
  history:[],channel:"facebook",clinicConfig:config,
 }).treatment,"草药胸部疏通乳腺护理");
 const server=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 assert.match(server,/details:sanitizeRm68BookingReadyDetails\(/);
});

test("RM68 clinical context keeps an uncertain hard lump on staff review, even after short replies",()=>{
 const {firstReply,hasCampaignConversation,stillDiscussingCampaign}=
  require("../src/utils/neutroBreastRm68Campaign");
 const history=[
  {role:"user",content:prefill},
  {role:"assistant",content:firstReply(Date.parse("2026-11-22T00:00:00Z"))},
  {role:"user",content:"没有红，没发烧。硬块就不懂"},
 ];
 assert.equal(hasCampaignConversation(history),true);
 assert.equal(stillDiscussingCampaign(history),true);
 assert.equal(isRm68ClinicalConcern("没有红，没发烧。硬块就不懂"),true);
 const s=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 assert.match(s,/rm68ClinicalConcern=isRm68ClinicalConcern\(text\)/);
 assert.match(s,/isBreastLumpConcern\(text\) \|\| rm68ClinicalConcern/);
 assert.match(s,/reviewType = "clinical"/);
});

test("AI lead scoring preserves RM68 campaign interest against herbal/full-body service guesses",()=>{
 const s=fs.readFileSync(require.resolve("../src/db/leadScoringRepo.js"),"utf8");
 assert.match(s,/function preserveRm68CampaignScoringSql/);
 assert.match(s,/customer_campaign_interest/);
 assert.match(s,/neutro_breast_rm68_2026/);
 assert.doesNotMatch(s,/explicit_choice\.role='user'/);
 assert.match(s,/Genuine subsequent service choices must use an/);
 assert.match(s,/草药胸部疏通乳腺护理/);
 assert.match(s,/脉冲波调理/);
 assert.match(s,/preserveRm68CampaignScoringSql\('\$4'\)/);
 assert.match(s,/preserveRm68CampaignScoringSql\('\$3'\)/);
});

test("customer selection is affirmative, not a rejection or price comparison",()=>{
 const {customerExplicitTreatmentChoice,latestCustomerTreatmentChoice}=
  require("../src/utils/neutroRm68TreatmentChoice");
 for(const v of ["我想做草药胸部疏通乳腺护理","帮我预约草药胸部护理",
   "我要预约草药胸部护理","I want to book herbal breast care"])
   assert.equal(customerExplicitTreatmentChoice(v,"herbal"),true,v);
 for(const v of ["我不想做草药胸部护理","我不要草药胸部护理",
   "草药胸部护理和RM68有什么不同？","草药胸部护理价钱多少？",
   "请问你们有草药胸部护理吗","I don't want herbal breast care",
   "我想做3D和草药胸部护理多少钱"])
   assert.equal(customerExplicitTreatmentChoice(v,"herbal"),false,v);
 assert.equal(customerExplicitTreatmentChoice("我要预约脉冲波调理","pulse"),true);
 assert.equal(customerExplicitTreatmentChoice("脉冲波调理和RM68有什么不同","pulse"),false);
 assert.equal(latestCustomerTreatmentChoice([
  {role:"user",content:"我想做草药胸部护理"},
  {role:"user",content:"我不想做草药胸部护理"},
 ],"我只想了解RM68","herbal"),false);
 const {sanitizeRm68BookingReadyDetails}=require("../src/utils/neutroRm68BookingSafety");
 const opts={channel:"whatsapp",clinicConfig:config,
   details:{treatment:"草药胸部疏通乳腺护理",appointmentPreference:"24/11 12pm"}};
 for(const v of ["我不想做草药胸部护理","草药胸部护理价钱多少？",
  "草药胸部护理和RM68有什么不同？"])
   assert.equal(sanitizeRm68BookingReadyDetails({...opts,customerText:v}).treatment,null,v);
 assert.equal(sanitizeRm68BookingReadyDetails({
   ...opts,customerText:"我要预约草药胸部疏通乳腺护理",
 }).treatment,"草药胸部疏通乳腺护理");
});
test("RM68 AI scoring never turns event interest into inferred herbal or full-body pulse",()=>{
 const s=fs.readFileSync(require.resolve("../src/db/leadScoringRepo.js"),"utf8");
 assert.match(s,/function preserveRm68CampaignScoringSql/);
 assert.match(s,/customer_campaign_interest/);
 assert.doesNotMatch(s,/explicit_choice/);
});
