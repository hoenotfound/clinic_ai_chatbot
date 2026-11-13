"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {invalidateFailedSecondaryVideo}=
  require("../src/services/whatsappSecondaryFailedVideoCache");
const env={
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
};
const job={wamid:"wamid.signed",delivery_status:"failed",
 business_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
 business_account_id:env.WHATSAPP_SECONDARY_WABA_ID,error_code:"131053"};
const key="clients/neutro-sense-tcm/messages/follow-up-config/test.mp4";
test("signed, sender-matched media-specific failures invalidate one exact cached upload ID",async()=>{
 const calls=[];
 const database={query:async(sql,args)=>{
   calls.push(["sql",sql,args]);
   return{rows:[{media_key:key,media_mime_type:"video/mp4"}]};
 }};
 const storage={
   isSharedFollowUpConfigKey:x=>x===key,
   getSharedFollowUpMediaInfo:async()=>({
     etag:"source-etag",bytes:500,mimeType:"video/mp4"}),
 };
 const fingerprint=crypto.createHash("sha256")
   .update(JSON.stringify([key,"source-etag",500,"video/mp4"]))
   .digest("hex");
 const cache={
   get:async(phone,hash)=>{
     assert.equal(phone,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
     assert.equal(hash,fingerprint);
     return"444555";
   },
   invalidate:async(phone,hash,id)=>{
     calls.push(["invalidated",phone,hash,id]);return true;
   },
 };
 const result=await invalidateFailedSecondaryVideo({
   job,messageId:19328,verifiedSender:{matched:true},
 },{database,storage,cache,env});
 assert.equal(result.invalidated,true);
 assert.equal(calls.filter(x=>x[0]==="invalidated").length,1);
 assert.equal(calls.find(x=>x[0]==="invalidated")[3],"444555");
 assert.match(calls[0][1],/sa\.meta_phone_number_id=\$3/);
});
test("unverified sender, wrong phone or unrelated failure cannot invalidate anything",async()=>{
 for(const data of [
   {job,verifiedSender:{matched:false}},
   {job:{...job,business_phone_number_id:"not secondary"},verifiedSender:{matched:true}},
   {job:{...job,error_code:"131047",error_title:"Message outside 24-hour window"},verifiedSender:{matched:true}},
   {job:{...job,delivery_status:"delivered"},verifiedSender:{matched:true}},
 ]){
  const result=await invalidateFailedSecondaryVideo({
   ...data,messageId:19328,
  },{env,database:{query:async()=>assert.fail("No database access")},
     storage:{},cache:{}});
  assert.equal(result.invalidated,false);
 }
});
test("nonshared message videos are not invalidated",async()=>{
 const result=await invalidateFailedSecondaryVideo({
  job,messageId:19328,verifiedSender:{matched:true},
 },{env,database:{query:async()=>({rows:[{media_key:"other/message.mp4"}]})},
    storage:{isSharedFollowUpConfigKey:()=>false},cache:{
     invalidate:async()=>assert.fail("Never invalidate an unscoped media ID")
    }});
 assert.equal(result.invalidated,false);
});
