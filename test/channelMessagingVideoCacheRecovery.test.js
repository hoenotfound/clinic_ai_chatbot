"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const messaging = require("../src/services/channelMessagingService");
const cache = require("../src/services/whatsappVideoMediaCache");
const storage = require("../src/services/mediaStorageService");
const whatsapp = require("../src/services/whatsappService");
const policy = require("../src/services/whatsappPolicyService");

const contact = { id: 12, channel: "whatsapp", whatsapp_number: "60123456789" };
const key = "clients/demo/messages/follow-up-config/test.mp4";

function mockVideo(t, { results, allowed = () => true, preSendCheck = async () => true }) {
  const original = {
    flag: process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED,
    resolve: cache.resolveMediaId,
    invalidate: cache.invalidateIfRejected,
    recovery: cache.recordRecovery,
    shared: storage.isSharedFollowUpConfigKey,
    guard: policy.checkFreeformAllowed,
    send: whatsapp.sendVideoById,
    download: storage.downloadMedia,
    upload: whatsapp.uploadMedia,
  };
  t.after(() => {
    if (original.flag === undefined) delete process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED;
    else process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED = original.flag;
    cache.resolveMediaId = original.resolve;
    cache.invalidateIfRejected = original.invalidate;
    cache.recordRecovery = original.recovery;
    storage.isSharedFollowUpConfigKey = original.shared;
    policy.checkFreeformAllowed = original.guard;
    whatsapp.sendVideoById = original.send;
    storage.downloadMedia = original.download;
    whatsapp.uploadMedia = original.upload;
  });
  process.env.WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED = "true";
  storage.isSharedFollowUpConfigKey = () => true;
  let guards = 0;
  policy.checkFreeformAllowed = async () => {
    guards += 1;
    return { allowed: allowed(guards), code: "window_closed", message: "Window closed" };
  };
  const trace = [];
  let lookups = 0;
  cache.resolveMediaId = async () => {
    lookups += 1;
    return {
      kind: "ready", mediaId: lookups === 1 ? "old-id" : "new-id",
      cacheHit: lookups === 1, phoneId: "123456", fingerprint: "a".repeat(64),
    };
  };
  cache.invalidateIfRejected = async (resolved, result) => {
    trace.push(["invalidate", resolved.mediaId, result.success]);
    return result.success === false && result.providerStatus === 400 &&
      result.ambiguous === false && result.error === "Invalid media ID";
  };
  cache.recordRecovery = () => trace.push(["recovered"]);
  whatsapp.sendVideoById = async (to, mediaId, caption, options) => {
    trace.push(["send", mediaId, caption, options?.currentMessageId]);
    return results.shift();
  };
  storage.downloadMedia = async () => { throw new Error("Never download cached video"); };
  whatsapp.uploadMedia = async () => { throw new Error("Never re-upload cached video"); };
  return { trace, getLookups: () => lookups, getGuards: () => guards,
    options: { purpose: "follow_up", currentMessageId: 101, preSendCheck } };
}

test("definite invalid cached video ID is refreshed and resent once through normal sender", async (t) => {
  const f = mockVideo(t, {
    results: [
      { success: false, wamid: null, providerStatus: 400, ambiguous: false, error: "Invalid media ID" },
      { success: true, wamid: "wamid-recovered" },
    ]
  });
  const result = await messaging.sendVideoByStoredKey(contact,key,"客户关心的疗程",null,f.options);
  assert.equal(result.success,true);
  assert.equal(result.wamid,"wamid-recovered");
  assert.equal(f.getLookups(),2);
  assert.equal(f.trace.filter(x => x[0] === "send").length,2);
  assert.deepEqual(f.trace.filter(x => x[0] === "send").map(x => x[1]),["old-id","new-id"]);
  assert.equal(f.trace.filter(x => x[0] === "send")[1][3],101);
  assert.equal(f.trace.filter(x => x[0] === "recovered").length,1);
  assert.ok(f.getGuards() >= 3, "Recovery must revalidate policy");
});

test("ambiguous provider timeout never triggers a duplicate WhatsApp send", async (t) => {
  const f = mockVideo(t, { results: [
    { success:false, wamid:null, ambiguous:true, unknown:true, error:"Invalid media ID", providerStatus:400 },
  ] });
  const r = await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.ambiguous,true);
  assert.equal(f.getLookups(),1);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,1);
});

test("policy closing after first provider rejection stops recovery", async (t) => {
  const f = mockVideo(t, {
    results: [{success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"}],
    allowed: (n) => n < 3,
  });
  const r = await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.policyBlocked,true);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,1);
  assert.equal(f.getLookups(),1);
});

test("staff cancellation after first 400 blocks retry without another upload", async (t) => {
  let n = 0;
  const f = mockVideo(t, {
    results:[{success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"}],
    preSendCheck:async()=>(++n <= 2),
  });
  const r=await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.cancelled,true);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,1);
  assert.equal(f.getLookups(),1);
});

test("recovery itself does not recursively retry even when its new ID is rejected", async(t)=>{
  const f=mockVideo(t,{results:[
    {success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"},
    {success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"},
  ]});
  const r=await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.success,false);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,2);
  assert.equal(f.trace.filter(x=>x[0]==="invalidate").length,2);
  assert.equal(f.trace.filter(x=>x[0]==="recovered").length,0);
});

test("cache wait cancellation never turns into a normal delivery", async(t)=>{
  const f=mockVideo(t,{results:[]});
  cache.resolveMediaId=async()=>({kind:"cancelled"});
  const r=await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.cancelled,true);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,0);
});

test("lost invalidation race uses another worker's refreshed ID without a third send", async (t) => {
  const f = mockVideo(t, {results:[
    {success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"},
    {success:true,wamid:"wamid-refreshed-by-other"},
  ]});
  cache.invalidateIfRejected = async (resolved, result) => {
    f.trace.push(["invalidation-lost-race", resolved.mediaId]);
    return false; // Other worker already cleared the old ID and refreshed.
  };
  const r = await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.wamid,"wamid-refreshed-by-other");
  assert.deepEqual(f.trace.filter(x => x[0] === "send").map(x => x[1]),["old-id","new-id"]);
  assert.equal(f.getLookups(),2);
  assert.equal(f.trace.filter(x => x[0] === "send").length,2);
});

test("lost invalidation race never retries if cache still resolves the same rejected ID", async (t) => {
  const f = mockVideo(t, {results:[
    {success:false,wamid:null,providerStatus:400,ambiguous:false,error:"Invalid media ID"},
  ]});
  cache.invalidateIfRejected = async () => false;
  cache.resolveMediaId = async () => ({
    kind:"ready", mediaId:"old-id", cacheHit:true, phoneId:"123456",fingerprint:"a".repeat(64)
  });
  const r=await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.success,false);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,1);
});

test("provider timeout does not retry even if another worker refreshed the cache", async (t)=>{
  const f=mockVideo(t,{results:[
    {success:false,wamid:null,ambiguous:true,unknown:true,error:"Invalid media ID",providerStatus:400}
  ]});
  cache.invalidateIfRejected=async()=>false;
  const r=await messaging.sendVideoByStoredKey(contact,key,"Caption",null,f.options);
  assert.equal(r.unknown,true);
  assert.equal(f.trace.filter(x=>x[0]==="send").length,1);
  assert.equal(f.getLookups(),1);
});
