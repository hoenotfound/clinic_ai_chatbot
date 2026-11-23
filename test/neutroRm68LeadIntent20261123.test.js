"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {isExplicitRm68Interest,isRm68ClinicalConcern}=require("../src/utils/neutroRm68InterestEvidence");
const {recordRm68CustomerInterest,SERVICE,CAMPAIGN}=require("../src/db/neutroRm68InterestRepo");
const config={businessName:"Neutro Sense TCM",services:[{name:SERVICE},{name:"脉冲波调理"}]};
const prefill="Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
test("customer-sent RM68 event, including health question, captures event distinct from RM388",()=>{
 for(const v of [prefill,prefill+"\n\n請問有結節的人可以參加？",
  "我想了解胸部 RM68 体验优惠", "Interested in RM68 breast care trial"]){
  assert.equal(isExplicitRm68Interest(v),true,v);
 }
 for(const v of ["RM388 脉冲波护理","胸部健康有结节","RM68 是给谁的广告？",
  "我对骨盆调理感兴趣", "我不感兴趣胸部 RM68 优惠"]){
  assert.equal(isExplicitRm68Interest(v),false,v);
 }
});
test("one bounded source-verified SQL statement, never modify marketing consent or override staff choice",async()=>{
 let sql,params,calls=0;
 const result=await recordRm68CustomerInterest({
  contactId:9265,messageId:22844,text:prefill,clinicConfig:config,
  database:{query:async(q,args)=>{sql=q;params=args;calls++;return{rows:[
   {verified:true,treatment_updated:true,event_recorded:true},
  ]};}},
 });
 assert.equal(result.verified,true);
 assert.equal(calls,1);
 assert.deepEqual(params,[9265,22844,prefill,SERVICE,CAMPAIGN,true]);
 assert.match(sql,/m\.role='user'/);
 assert.match(sql,/m\.whatsapp_message_id IS NOT NULL/);
 assert.match(sql,/NULLIF\(BTRIM\(l\.treatment_interest\),'\'\) IS NULL/);
 assert.match(sql,/customer_campaign_interest/);
 assert.doesNotMatch(sql,/SET\s+marketing_consent|marketing_consent\s*=/i);
 assert.doesNotMatch(sql,/UPDATE contacts/i);
});
test("ad-only attribution, unconfigured service and unstated campaign don't write data",async()=>{
 let n=0;
 const database={query:async()=>{n++;throw Error("must not query");}};
 for(const input of [
  {text:"Neutro 胸 Jesi Number - 14/11/2026",clinicConfig:config},
  {text:prefill,clinicConfig:{businessName:"Other",services:config.services}},
  {text:prefill,clinicConfig:{businessName:"Neutro Sense TCM",services:[]}},
 ]){
  assert.equal((await recordRm68CustomerInterest({
   contactId:9265,messageId:22844,database,...input,
  })).matched,false);
 }
 assert.equal(n,0);
});
test("capture precedes manual-only early return and does not send anything",()=>{
 const server=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 const classify=server.indexOf("neutroRm68InterestRepo.recordRm68CustomerInterest");
 const exit=server.indexOf("if (secondaryInboxOnly && !mediaType && !unsupportedType)");
 assert.ok(classify>0&&exit>classify);
});
test("medical concerns may be recorded as RM68 interest but cannot auto-target a breast-care sales follow-up",async()=>{
 const medical="Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？\n請問有結節的人可以參加？";
 assert.equal(isExplicitRm68Interest(medical),true);
 assert.equal(isRm68ClinicalConcern(medical),true);
 let params,sql;
 await recordRm68CustomerInterest({
  contactId:9265,messageId:22844,text:medical,clinicConfig:config,
  database:{query:async(q,p)=>{sql=q;params=p;return{rows:[{verified:true,treatment_updated:false,event_recorded:true}]};}},
 });
 assert.equal(params[5],false);
 assert.match(sql,/AND \$6::boolean=TRUE/);
 assert.match(sql,/medicalReviewNeeded/);
});

test("concrete breast lump safety questions block routine promotion media but not ordinary RM68 information",()=>{
 const {hasClinicalMediaRisk}=require("../src/utils/aiReviewPolicy");
 for(const text of [
  "胸有瘤可以做吗？","請問有結節的人可以參加？",
  "I have a breast lump. Is this safe?","乳腺结节可以护理吗",
 ])assert.equal(hasClinicalMediaRisk(text),true,text);
 for(const text of [
  "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣",
  "请问胸部护理 RM68 还有名额吗？"
 ])assert.equal(hasClinicalMediaRisk(text),false,text);
});
