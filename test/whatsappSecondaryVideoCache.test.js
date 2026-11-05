"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { secondaryVideoCacheEligible, dispatchSecondaryFollowUpVideo } =
  require("../src/services/whatsappSecondaryVideoCache");
const { recordOutboundPayload, takeOutboundPayloadSnapshot } =
  require("../src/utils/outboundPayloadDiagnostics");

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
  assert.equal(got.coverage, "attempted_upload_payload_only");
  assert.deepEqual(got.buckets.find(x => x.category === "meta_secondary_media"), {
    category: "meta_secondary_media", attempts: 1, payloadMiB: 2,
  });
  assert.equal(takeOutboundPayloadSnapshot().buckets.find(
    x => x.category === "meta_secondary_media").attempts, 0);
});
