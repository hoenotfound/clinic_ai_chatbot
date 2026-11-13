"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validMp4Container, secondaryVideoCacheEligible, dispatchSecondaryFollowUpVideo } =
  require("../src/services/whatsappSecondaryVideoCache");
const { recordOutboundPayload, recordOutboundRequest, recordHttp503,
  takeOutboundPayloadSnapshot } =
  require("../src/utils/outboundPayloadDiagnostics");
const { createCache } = require("../src/services/whatsappVideoMediaCache");

const enabled = {
  WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED: "true",
  WHATSAPP_SECONDARY_SENDER_KEY: "neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "222222",
  WHATSAPP_PHONE_NUMBER_ID: "111111",
};

function setup({ env = enabled, approved = () => true, check = async () => true } = {}) {
  const calls = { download: 0, upload: 0, send: 0, invalid: 0, mediaId: null };
  const storage = {
    isSharedFollowUpConfigKey: (key) => key === "clients/neutro/messages/follow-up-config/clip.mp4",
    downloadMedia: async () => { calls.download++; return Buffer.from("video"); },
  };
  const transport = {
    uploadMedia: async () => { calls.upload++; return { success: true, mediaId: "222999" }; },
    sendMediaById: async (type, id) => {
      assert.equal(type, "video");
      calls.mediaId = id; calls.send++;
      return { success: true, wamid: "wamid.secondary-accepted" };
    },
  };
  const args = {
    transport, env, storage, mediaKey: "clients/neutro/messages/follow-up-config/clip.mp4",
    mimeType: "video/mp4", filename: "clip.mp4", caption: "Approved follow-up",
    preSendCheck: check, liveVideoApproval: approved,
  };
  return { calls, args, transport, storage };
}

test("only the secondary Meta phone and shared clinic key qualify", () => {
  const f = setup();
  assert.equal(secondaryVideoCacheEligible({
    env: enabled, storage: f.storage, mediaKey: f.args.mediaKey,
  }), true);
  assert.equal(secondaryVideoCacheEligible({
    env: { ...enabled, WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "111111" },
    storage: f.storage, mediaKey: f.args.mediaKey,
  }), false);
  assert.equal(secondaryVideoCacheEligible({
    env: { ...enabled, WHATSAPP_SECONDARY_SENDER_KEY: "other_clinic" },
    storage: f.storage, mediaKey: f.args.mediaKey,
  }), false);
  assert.equal(secondaryVideoCacheEligible({
    env: enabled, storage: f.storage, mediaKey: "messages/other-customer/video.mp4",
  }), false);
  assert.equal(secondaryVideoCacheEligible({
    env: { ...enabled, WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED: "false" },
    storage: f.storage, mediaKey: f.args.mediaKey,
  }), false);
});

test("cache hit sends secondary media ID without downloading or uploading the MP4", async () => {
  const f = setup();
  let phoneId;
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: ({ phoneNumberId }) => {
      phoneId = phoneNumberId();
      return {
        resolveMediaId: async () => ({ kind: "ready", mediaId: "222888", cacheHit: true }),
        invalidateIfRejected: async () => assert.fail("Do not invalidate a successful send"),
      };
    },
  });
  assert.equal(phoneId, enabled.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  assert.equal(result.success, true);
  assert.equal(f.calls.mediaId, "222888");
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.send, 1);
});

test("cache miss uploads using verified secondary transport and saves for other recipients", async () => {
  const f = setup();
  let cacheUploader;
  let cachedPhone;
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: ({ phoneNumberId, whatsappApi }) => {
      cachedPhone = phoneNumberId();
      cacheUploader = whatsappApi;
      return {
        resolveMediaId: async () => ({
          kind: "ready",
          mediaId: await whatsappApi.uploadMedia(Buffer.from("video"), "video/mp4", "clip.mp4"),
          cacheHit: false,
        }),
        invalidateIfRejected: async () => false,
      };
    },
  });
  assert.equal(result.success, true);
  assert.equal(cachedPhone, "222222");
  assert.equal(typeof cacheUploader.uploadMedia, "function");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.send, 1);
});

test("cache unavailable falls back to the same one-shot secondary upload path", async () => {
  const f = setup();
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: () => ({ resolveMediaId: async () => ({ kind: "bypass" }) }),
  });
  assert.equal(result.success, true);
  assert.equal(f.calls.download, 1);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.send, 1);
});

test("cache OFF preserves prefetched upload behavior without looking up cache", async () => {
  const f = setup({ env: { ...enabled, WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED: "false" } });
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args, prefetchedBytes: Buffer.from("already-validated-video"),
    cacheFactory: () => assert.fail("Cache must remain off"),
  });
  assert.equal(result.success, true);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.send, 1);
});

test("policy revoked before upload blocks all provider calls", async () => {
  const f = setup({ check: async () => false });
  const result = await dispatchSecondaryFollowUpVideo({ ...f.args });
  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.send, 0);
});

test("treatment video revoked during cache lookup blocks the message", async () => {
  let permitted = true;
  const f = setup({ approved: () => permitted });
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: () => ({
      resolveMediaId: async () => { permitted = false; return { kind: "ready", mediaId: "333" }; },
      invalidateIfRejected: async () => false,
    }),
  });
  assert.equal(result.success, false);
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.upload, 0);
});

test("cached upload error never triggers a second Meta upload", async () => {
  const f = setup();
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: () => ({ resolveMediaId: async () => ({ kind: "upload_failed" }) }),
  });
  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.send, 0);
});

test("definite invalid-media rejection may invalidate cache, but cannot auto-resend", async () => {
  const f = setup();
  f.transport.sendMediaById = async () => {
    f.calls.send++;
    return { success: false, definitivelyRejected: true, ambiguous: false,
      providerStatus: 400, error: "Invalid media ID" };
  };
  await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: () => ({
      resolveMediaId: async () => ({ kind: "ready", mediaId: "222888", cacheHit: true }),
      invalidateIfRejected: async () => { f.calls.invalid++; return true; },
    }),
  });
  assert.equal(f.calls.invalid, 1);
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.upload, 0);
});

test("unknown provider outcome does not resend or invalidate cached upload", async () => {
  const f = setup();
  f.transport.sendMediaById = async () => {
    f.calls.send++;
    return { success: false, ambiguous: true, unknown: true };
  };
  const result = await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory: () => ({
      resolveMediaId: async () => ({ kind: "ready", mediaId: "222888" }),
      invalidateIfRejected: async () => { f.calls.invalid++; return false; },
    }),
  });
  assert.equal(result.unknown, true);
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.upload, 0);
  // The underlying cache helper inspects the result and never changes a row.
  assert.equal(f.calls.invalid, 1);
});

test("outbound diagnostics never record unless explicitly enabled", () => {
  takeOutboundPayloadSnapshot();
  assert.equal(recordOutboundPayload("meta_secondary_media", 1024, {}), false);
  assert.equal(recordOutboundPayload("patient_contact_abc", 1024, {
    DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true",
  }), false);
  assert.equal(recordOutboundPayload("meta_secondary_media", 2097152, {
    DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true",
  }), true);
  const got = takeOutboundPayloadSnapshot();
  assert.equal(got.coverage, "attempted_upload_known_json_and_content_length_only");
  assert.deepEqual(got.buckets.find(x => x.category === "meta_secondary_media"), {
    category: "meta_secondary_media", attempts: 1, payloadMiB: 2,
  });
  assert.equal(takeOutboundPayloadSnapshot().buckets.find(
    x => x.category === "meta_secondary_media").attempts, 0);
});

test("simultaneous secondary follow-ups share a pending upload without sharing sends", async () => {
  // Each recipient has its own verified sender transport and billing result.
  // Only the clinic-owned media upload is shared while pending.
  const f = setup();
  let uploadReady, finishUpload;
  const began = new Promise(resolve => { uploadReady = resolve; });
  const barrier = new Promise(resolve => { finishUpload = resolve; });
  const repoRows = new Map();
  const repo = {
    async get(phone, fingerprint) { return repoRows.get(phone + fingerprint)?.mediaId || null; },
    async claim(phone, fingerprint, mime, claimId) {
      const id = phone + fingerprint;
      if (repoRows.has(id)) return false;
      repoRows.set(id, { claimId }); return true;
    },
    async save(phone, fingerprint, claimId, mediaId) {
      const id = phone + fingerprint;
      if (repoRows.get(id)?.claimId !== claimId) return false;
      repoRows.set(id, { mediaId }); return true;
    },
    async release() {},
    async recordEvent() {},
  };
  const storage = {
    ...f.storage,
    getSharedFollowUpMediaInfo: async () => ({
      etag: "etag1", mimeType: "video/mp4", bytes: 512,
    }),
  };
  let downloads = 0, uploads = 0, sentA = 0, sentB = 0;
  storage.downloadMedia = async () => { downloads++; return Buffer.from("shared-video"); };
  const firstTransport = {
    uploadMedia: async () => {
      uploads++; uploadReady(); await barrier;
      return { success: true, mediaId: "222777" };
    },
    sendMediaById: async (_, id) => {
      assert.equal(id, "222777"); sentA++;
      return { success: true, wamid: "wamid.first" };
    },
  };
  const secondTransport = {
    uploadMedia: async () => { uploads++; return { success: true, mediaId: "222888" }; },
    sendMediaById: async (_, id) => {
      assert.equal(id, "222777"); sentB++;
      return { success: true, wamid: "wamid.second" };
    },
  };
  const factory = options => createCache({
    ...options, repo, mediaStorage: storage,
    sleep: async () => { throw new Error("Should share in-process flight instead of DB polling"); },
  });
  const a = dispatchSecondaryFollowUpVideo({
    ...f.args, transport: firstTransport, storage, cacheFactory: factory,
  });
  await began;
  const b = dispatchSecondaryFollowUpVideo({
    ...f.args, transport: secondTransport, storage, cacheFactory: factory,
  });
  await new Promise(resolve => setImmediate(resolve));
  finishUpload();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(resultA.success, true);
  assert.equal(resultB.success, true);
  assert.equal(downloads, 1);
  assert.equal(uploads, 1);
  assert.equal(sentA, 1);
  assert.equal(sentB, 1);
});

test("extended outbound counters count only known API request sizes and coarse 503 classes", () => {
  const env = { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" };
  takeOutboundPayloadSnapshot();
  assert.equal(recordOutboundRequest("meta_secondary_json", 4096, env), true);
  assert.equal(recordOutboundRequest("gemini_sdk", 0, env), true);
  assert.equal(recordOutboundRequest("arbitrary_external_url", 4096, env), false);
  assert.equal(recordHttp503({ statusCode: 503, pathname: "/api/conversations/123",
    readyAtStart: true, env }), true);
  assert.equal(recordHttp503({ statusCode: 503, pathname: "/health/ready",
    readyAtStart: false, env }), true);
  assert.equal(recordHttp503({ statusCode: 200, pathname: "/api/secret",
    readyAtStart: true, env }), false);
  const snap = takeOutboundPayloadSnapshot();
  assert.equal(snap.buckets.find(x => x.category === "meta_secondary_json").attempts, 1);
  assert.equal(snap.buckets.find(x => x.category === "gemini_sdk").attempts, 1);
  assert.equal(snap.http503.find(x => x.category === "api").count, 1);
  assert.equal(snap.http503.find(x => x.category === "startup").count, 1);
  assert.equal(JSON.stringify(snap).includes("conversations"), false);
  assert.equal(JSON.stringify(snap).includes("secret"), false);
});

test("MP4 preflight checks the container before attempting any provider upload",async()=>{
  const valid=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom00000000","ascii")]);
  assert.equal(validMp4Container(valid),true);
  assert.equal(validMp4Container(Buffer.from("not an mp4 file")),false);
  const f=setup({env:{...enabled,
    WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED:"false",
    WHATSAPP_SECONDARY_VIDEO_MP4_PREFLIGHT_ENABLED:"true"}});
  const blocked=await dispatchSecondaryFollowUpVideo({
    ...f.args,prefetchedBytes:Buffer.from("invalid video bytes"),
  });
  assert.equal(blocked.code,"sender_followup_video_invalid_mp4");
  assert.equal(blocked.definitivelyRejected,true);
  assert.equal(blocked.unknown,false);
  assert.equal(f.calls.upload,0);
  assert.equal(f.calls.send,0);
  const sent=await dispatchSecondaryFollowUpVideo({
    ...f.args,prefetchedBytes:valid,
  });
  assert.equal(sent.success,true);
  assert.equal(f.calls.upload,1);
  assert.equal(f.calls.send,1);
});

test("definitive /media upload rejection does not create an uncertain message outcome",async()=>{
  const f=setup({env:{...enabled,
    WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED:"false"}});
  f.transport.uploadMedia=async()=>{
    f.calls.upload++;
    return {success:false,ambiguous:false,definitivelyRejected:true,
      providerStatus:400,providerErrorCode:131053,
      providerFailureKind:"http_rejection"};
  };
  const result=await dispatchSecondaryFollowUpVideo({...f.args});
  assert.equal(result.code,"sender_followup_video_upload_rejected");
  assert.equal(result.definitivelyRejected,true);
  assert.equal(result.providerErrorCode,131053);
  assert.equal(f.calls.upload,1);
  assert.equal(f.calls.send,0);
});

test("cached upload rejection and malformed cached download remain distinct from unknown sends",async()=>{
  const f=setup({env:{...enabled,WHATSAPP_SECONDARY_VIDEO_MP4_PREFLIGHT_ENABLED:"true"}});
  f.transport.uploadMedia=async()=>({success:false,ambiguous:false,
    definitivelyRejected:true,providerStatus:400,providerErrorCode:131053});
  const rejected=await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory:({whatsappApi})=>({
      resolveMediaId:async()=>{
        await whatsappApi.uploadMedia(Buffer.from("00000018ftypisom00000000"),
          "video/mp4","clip.mp4");
        return{kind:"upload_failed"};
      },
    }),
  });
  assert.equal(rejected.code,"sender_followup_video_upload_rejected");
  assert.equal(rejected.definitivelyRejected,true);
  const invalid=await dispatchSecondaryFollowUpVideo({
    ...f.args,
    cacheFactory:({mediaStorage})=>({
      resolveMediaId:async()=>{
        try{await mediaStorage.downloadMedia(f.args.mediaKey);}
        catch(error){return{kind:"download_failed",error};}
        return{kind:"ready",mediaId:"unused"};
      },
    }),
  });
  assert.equal(invalid.code,"sender_followup_video_invalid_mp4");
  assert.equal(invalid.definitivelyRejected,true);
  assert.equal(f.calls.send,0);
});
