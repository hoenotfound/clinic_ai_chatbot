"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCache, definitelyInvalidMediaId } = require("../src/services/whatsappVideoMediaCache");

function fixture() {
  const rows = new Map();
  const calls = { head: 0, download: 0, upload: 0, invalidate: 0, release: 0 };
  let etag = "first-version";
  let number = "1234567890";
  let uploadId = "9876543210123";
  let uploadDelay = 0;
  let valid = true;
  const key = "clients/demo/messages/follow-up-config/treatment-video.mp4";
  const recordKey = (phone, fingerprint) => phone + ":" + fingerprint;
  const repo = {
    async get(phone, hash) {
      return rows.get(recordKey(phone, hash))?.mediaId || null;
    },
    async claim(phone, hash, mimeType, claimId) {
      const k = recordKey(phone, hash);
      if (rows.get(k)) return false;
      rows.set(k, { claimId, mimeType });
      return true;
    },
    async save(phone, hash, claimId, mediaId) {
      const k = recordKey(phone, hash);
      if (rows.get(k)?.claimId !== claimId) return false;
      rows.set(k, { mediaId });
      return true;
    },
    async release(phone, hash, claimId) {
      calls.release += 1;
      const k = recordKey(phone, hash);
      if (rows.get(k)?.claimId === claimId) rows.delete(k);
    },
    async invalidate(phone, hash, mediaId) {
      calls.invalidate += 1;
      const k = recordKey(phone, hash);
      if (rows.get(k)?.mediaId === mediaId) rows.delete(k);
    },
  };
  const storage = {
    isSharedFollowUpConfigKey(v) { return v === key; },
    async getSharedFollowUpMediaInfo() {
      calls.head += 1;
      return { mimeType: "video/mp4", bytes: 9_000_000, etag };
    },
    async downloadMedia() { calls.download += 1; return Buffer.from("test-video"); },
  };
  const whatsapp = {
    async uploadMedia() {
      calls.upload += 1;
      if (uploadDelay) await new Promise((resolve) => setTimeout(resolve, uploadDelay));
      return valid ? uploadId : null;
    },
  };
  const cache = createCache({ repo, mediaStorage: storage, whatsappApi: whatsapp,
    phoneNumberId: () => number });
  const resolve = (videoKey = key) => cache.resolveMediaId({
    videoKey, mimeType: "video/mp4", filename: "video.mp4",
  });
  return { calls, cache, resolve, key, rows,
    setVersion(v) { etag = v; }, setPhone(v) { number = v; },
    setUploadId(v) { uploadId = v; }, setUploadDelay(v) { uploadDelay = v; },
    setUploadSuccess(v) { valid = v; } };
}

test("video cache uploads once, then reuses across customers", async () => {
  const f = fixture();
  const first = await f.resolve();
  const second = await f.resolve();
  assert.equal(first.kind, "ready");
  assert.equal(first.cacheHit, false);
  assert.equal(second.kind, "ready");
  assert.equal(second.cacheHit, true);
  assert.equal(first.mediaId, second.mediaId);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.download, 1);
});

test("video cache isolates WhatsApp phones and overwritten R2 versions", async () => {
  const f = fixture();
  await f.resolve();
  f.setPhone("999888777");
  await f.resolve();
  f.setVersion("replaced");
  await f.resolve();
  assert.equal(f.calls.upload, 3);
  assert.equal(f.calls.download, 3);
});

test("only shared clinic videos are cached", async () => {
  const f = fixture();
  const result = await f.resolve("clients/demo/messages/contact-private-video.mp4");
  assert.equal(result.kind, "bypass");
  assert.equal(f.calls.head, 0);
  assert.equal(f.calls.upload, 0);
});

test("simultaneous follow-ups share a single Meta upload", async () => {
  const f = fixture();
  f.setUploadDelay(25);
  const results = await Promise.all([f.resolve(),f.resolve(),f.resolve()]);
  assert.equal(results.filter((r) => r.kind === "ready").length, 3);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.download, 1);
});

test("failed upload releases claim and can recover on a later attempt", async () => {
  const f = fixture();
  f.setUploadSuccess(false);
  assert.equal((await f.resolve()).kind, "upload_failed");
  f.setUploadSuccess(true);
  assert.equal((await f.resolve()).kind, "ready");
  assert.equal(f.calls.upload, 2);
  assert.equal(f.calls.release, 1);
});

test("only definite invalid-media rejection invalidates; no automatic resend", async () => {
  const f = fixture();
  const r = await f.resolve();
  const unknown = { success:false, ambiguous:true, providerStatus:400, error:"invalid media ID" };
  assert.equal(await f.cache.invalidateIfRejected(r,unknown), false);
  assert.equal(f.calls.invalidate, 0);
  const definite = { success:false, ambiguous:false, providerStatus:400, providerErrorCode:100,
    error:"Invalid media ID" };
  assert.equal(definitelyInvalidMediaId(definite),true);
  assert.equal(await f.cache.invalidateIfRejected(r, definite),true);
  assert.equal(f.calls.invalidate,1);
  assert.equal((await f.resolve()).kind,"ready");
  assert.equal(f.calls.upload,2);
});

test("policy or unrelated provider errors never invalidate media IDs", () => {
  assert.equal(definitelyInvalidMediaId({ success:false, policyBlocked:true, providerStatus:403,
    error:"Invalid media ID" }),false);
  assert.equal(definitelyInvalidMediaId({ success:false, ambiguous:false, providerStatus:400,
    error:"Customer outside 24-hour window" }),false);
});
