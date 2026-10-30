"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {verifyApprovedVideo}=require("../src/services/whatsappSecondaryFollowUpVideoApproval");
const env={
 WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
 WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
 WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
};
const input={
 slot:2,mediaKey:"clients/neutro/messages/follow-up-config/approved.mp4",
 mediaType:"video",confirmClinicVideoReuse:true,env,
 clinicConfig:{automatedFollowUp:{videoKey:"clients/neutro/messages/follow-up-config/approved.mp4"}},
};
const mock=()=>{
 const calls={ownership:0,head:0};
 return{calls,storage:{
   isReferencedClinicFollowUpMediaKey:(key,config,env)=>{
     calls.ownership++;return key===input.mediaKey &&
       config===input.clinicConfig && env===input.env;
   },
   getSharedFollowUpMediaInfo:async key=>{
     calls.head++;assert.equal(key,input.mediaKey);
     return{mimeType:"video/mp4",bytes:900_000};
   }
 }};
};
test("approved existing clinic video is reused only for 2h or 6h secondary slots",async()=>{
 for(const slot of [2,6]){
  const m=mock(),r=await verifyApprovedVideo({...input,slot,storage:m.storage});
  assert.deepEqual(r,{approved:true,key:input.mediaKey,
   mimeType:"video/mp4",filename:"clinic-followup.mp4"});
  assert.equal(m.calls.head,1);
 }
});
test("no media fetch for disabled parity, unapproved source, missing owner consent or 20h slot",async()=>{
 const cases=[
  {slot:20},{slot:48},{slot:72},{mediaType:"image"},
  {confirmClinicVideoReuse:false},{mediaKey:"messages/customer-private.mp4"},
  {env:{...env,WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false"}},
  {env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"false"}},
  {env:{...env,WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"false"}},
  {env:{...env,WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"other"}},
 ];
 for(const change of cases){
  const m=mock();
  const r=await verifyApprovedVideo({...input,...change,storage:m.storage});
  assert.equal(r.approved,false,JSON.stringify(change));
  assert.equal(m.calls.head,0);
 }
});
test("a non-owned/legacy media key is denied even if an operator supplied a string",async()=>{
 const m=mock();
 m.storage.isReferencedClinicFollowUpMediaKey=()=>false;
 const r=await verifyApprovedVideo({...input,storage:m.storage});
 assert.equal(r.approved,false);
 assert.equal(m.calls.head,0);
});
test("missing or oversized R2 video is rejected without saving a rule",async()=>{
 for(const item of [
  {mimeType:"image/jpeg",bytes:9000},
  {mimeType:"video/mp4",bytes:0},
  {mimeType:"video/mp4",bytes:17*1024*1024},
  {mimeType:"video/mp4",bytes:NaN},
 ]) {
  const m=mock();
  m.storage.getSharedFollowUpMediaInfo=async()=>item;
  assert.equal((await verifyApprovedVideo({...input,storage:m.storage})).approved,false);
 }
 const m=mock();
 m.storage.getSharedFollowUpMediaInfo=async()=>{throw Error("R2 not available")};
 assert.equal((await verifyApprovedVideo({...input,storage:m.storage})).approved,false);
});
