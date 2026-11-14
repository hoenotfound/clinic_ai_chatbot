"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {SQL,isVerifiedFailedVideo,textWithoutVideo}=
 require("../src/services/whatsappSecondaryVideoQuarantine");
const key="clients/neutro-sense-tcm/messages/follow-up-config/1794541729931-0368ad99-80b9-4dce-b0ee-fe2cf2097295.mp4";
const env={WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary"};
test("quarantine requires exact signed 131053 and the correct sender and asset",async()=>{
 assert.match(SQL,/r\.matched=TRUE/);
 assert.match(SQL,/r\.delivery_status='failed'/);
 assert.match(SQL,/r\.reservation_id=a\.reservation_id/);
 assert.match(SQL,/r\.meta_phone_number_id=sa\.meta_phone_number_id/);
 assert.match(SQL,/r\.meta_account_id=sa\.meta_account_id/);
 assert.match(SQL,/m\.media_key=\$1/);
 assert.match(SQL,/m\.delivery_error LIKE 'Verified Meta delivery failure \(code 131053\)%'/);
 let calls=0;
 const db={query:async(sql,args)=>{
   calls++;assert.equal(sql,SQL);assert.deepEqual(args,[key,2]);
   return {rows:[{quarantined:true}]};
 }};
 assert.equal(await isVerifiedFailedVideo({database:db,senderId:2,mediaKey:key,env}),true);
 assert.equal(calls,1);
 for(const bad of [
  {senderId:0,mediaKey:key,env},
  {senderId:2,mediaKey:"clients/neutro-sense-tcm/messages/9063/private.mp4",env},
  {senderId:2,mediaKey:key,env:{WHATSAPP_SECONDARY_SENDER_KEY:"neutro"}},
 ])assert.equal(await isVerifiedFailedVideo({database:db,...bad}),false);
 assert.equal(calls,1);
});
test("only a verified truthy signed match quarantines a video",async()=>{
 const db={query:async()=>({rows:[{quarantined:false}]})};
 assert.equal(await isVerifiedFailedVideo({database:db,senderId:2,mediaKey:key,env}),false);
 assert.match(textWithoutVideo("zh"),/护理流程/);
 assert.match(textWithoutVideo("en"),/assessment/);
 assert.match(textWithoutVideo("ms"),/rawatan/);
 assert.equal(textWithoutVideo(null),null);
 for(const language of ["zh","en","ms"]){
   assert.doesNotMatch(textWithoutVideo(language),/video|视频|影片|lihat video/i);
 }
});
