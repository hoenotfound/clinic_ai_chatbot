"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const messaging = require("../src/services/channelMessagingService");
const cache = require("../src/services/whatsappVideoMediaCache");
const storage = require("../src/services/mediaStorageService");
const whatsapp = require("../src/services/whatsappService");
const policy = require("../src/services/whatsappPolicyService");

test("cached shared video bypasses R2 download and Meta upload but still calls guarded WhatsApp sender", async (t) => {
  const oldEnv = process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
  const original = { resolve:cache.resolveMediaId, invalidate:cache.invalidateIfRejected,
    isShared:storage.isSharedFollowUpConfigKey, download:storage.downloadMedia,
    upload:whatsapp.uploadMedia, send:whatsapp.sendVideoById, guard:policy.checkFreeformAllowed };
  t.after(() => {
    if (oldEnv === undefined) delete process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
    else process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED = oldEnv;
    cache.resolveMediaId=original.resolve; cache.invalidateIfRejected=original.invalidate;
    storage.isSharedFollowUpConfigKey=original.isShared; storage.downloadMedia=original.download;
    whatsapp.uploadMedia=original.upload; whatsapp.sendVideoById=original.send;
    policy.checkFreeformAllowed=original.guard;
  });
  process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED="true";
  policy.checkFreeformAllowed=async()=>({allowed:true});
  storage.isSharedFollowUpConfigKey=()=>true;
  const trace=[];
  cache.resolveMediaId=async()=>({kind:"ready",mediaId:"99887766",cacheHit:true,
    fingerprint:"a".repeat(64),phoneId:"123456"});
  cache.invalidateIfRejected=async(resolved,result)=>{trace.push(["invalidate",result.success]);};
  storage.downloadMedia=async()=>{throw Error("Unexpected video download");};
  whatsapp.uploadMedia=async()=>{throw Error("Unexpected video upload");};
  whatsapp.sendVideoById=async(...args)=>{trace.push(["send",...args]);return {success:true,wamid:"wamid-test"};};
  const result=await messaging.sendVideoByStoredKey(
    {id:1,channel:"whatsapp",whatsapp_number:"60123456789"},
    "clients/demo/messages/follow-up-config/test.mp4","Personalized caption",null,{purpose:"follow_up"}
  );
  assert.equal(result.wamid,"wamid-test");
  assert.equal(trace.filter(x=>x[0]==="send").length,1);
  assert.equal(trace[0][1],"60123456789");
  assert.equal(trace[0][2],"99887766");
  assert.equal(trace[0][3],"Personalized caption");
});

test("explicit Meta rejection invalidates cached ID but does not resend", async (t) => {
  const oldEnv=process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
  const originals={resolve:cache.resolveMediaId,invalidate:cache.invalidateIfRejected,
    isShared:storage.isSharedFollowUpConfigKey,send:whatsapp.sendVideoById,guard:policy.checkFreeformAllowed};
  t.after(()=>{
    if(oldEnv===undefined)delete process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
    else process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED=oldEnv;
    cache.resolveMediaId=originals.resolve;cache.invalidateIfRejected=originals.invalidate;
    storage.isSharedFollowUpConfigKey=originals.isShared;
    whatsapp.sendVideoById=originals.send;policy.checkFreeformAllowed=originals.guard;
  });
  process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED="true";
  policy.checkFreeformAllowed=async()=>({allowed:true});
  storage.isSharedFollowUpConfigKey=()=>true;
  cache.resolveMediaId=async()=>({kind:"ready",mediaId:"99887766",cacheHit:true});
  let sent=0,invalidated=0;
  whatsapp.sendVideoById=async()=>{sent++;return{success:false,wamid:null,ambiguous:false,
    providerStatus:400,providerErrorCode:100,error:"Invalid media ID"};};
  cache.invalidateIfRejected=async()=>{invalidated++;};
  const result=await messaging.sendVideoByStoredKey(
    {id:2,channel:"whatsapp",whatsapp_number:"60123456789"},
    "clients/demo/messages/follow-up-config/test.mp4","Caption"
  );
  assert.equal(result.success,false);
  assert.equal(sent,1);
  assert.equal(invalidated,1);
});

test("pre-send cancellation prevents even a cache lookup and preserves the blocked send", async (t) => {
  const oldEnv=process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
  const original={resolve:cache.resolveMediaId,guard:policy.checkFreeformAllowed};
  t.after(()=>{
    if(oldEnv===undefined)delete process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
    else process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED=oldEnv;
    cache.resolveMediaId=original.resolve;policy.checkFreeformAllowed=original.guard;
  });
  process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED="true";
  policy.checkFreeformAllowed=async()=>({allowed:true});
  cache.resolveMediaId=async()=>{throw Error("Cache must not be called");};
  const result=await messaging.sendVideoByStoredKey(
    {id:3,channel:"whatsapp",whatsapp_number:"60123456789"},
    "clients/demo/messages/follow-up-config/test.mp4","Caption",null,
    {purpose:"follow_up",preSendCheck:async()=>false}
  );
  assert.equal(result.cancelled,true);
});
