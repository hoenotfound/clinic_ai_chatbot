"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldTryDirectInboxVideo, tryDirectInboxVideo, VIDEO_URL_TTL_SECONDS } =
  require("../src/services/inboxDirectR2VideoService");
const source = require("node:fs").readFileSync(require("node:path").join(__dirname,
  "../src/routes/conversations.js"), "utf8");

function setup({ mime = "video/mp4", bytes = 12345, throws = false } = {}) {
  const calls = [];
  const storage = {
    isOwnedStoredMediaKey: (key) => { calls.push(["owned", key]); return true; },
    headMediaObject: async (key) => {
      calls.push(["head", key]);
      if (throws) throw Object.assign(new Error("sensitive object key"), { code: "R2_TEMPORARY" });
      return { mimeType: mime, bytes };
    },
    createPresignedGetUrl: (key, options) => {
      calls.push(["sign", key, options]);
      return "https://example.r2.cloudflarestorage.com/private?X-Amz-Signature=placeholder";
    },
  };
  const res = {
    set(headers) { calls.push(["headers", headers]); },
    redirect(status, url) { calls.push(["redirect", status, url]); },
  };
  return { calls, storage, res };
}

const ref = { media_key: "messages/follow-up-config/old-video.mp4", media_mime_type: "video/mp4" };
const enabled = { INBOX_DIRECT_R2_VIDEO_ENABLED: "true" };
const disabled = {};

test("flag defaults off and only signed MP4s, never audio/images/documents", () => {
  assert.equal(shouldTryDirectInboxVideo(ref, {}, disabled), false);
  assert.equal(shouldTryDirectInboxVideo(ref, {}, enabled), true);
  for (const type of ["audio/ogg", "image/jpeg", "application/pdf", "video/quicktime"]) {
    assert.equal(shouldTryDirectInboxVideo({ ...ref, media_mime_type: type }, {}, enabled), false);
  }
  assert.equal(shouldTryDirectInboxVideo(ref, { delivery: "proxy" }, enabled), false);
  assert.equal(shouldTryDirectInboxVideo({ ...ref, media_key: null }, {}, enabled), false);
});

test("direct signed R2 video is authorized by route, ownership-checked, and short-lived", async () => {
  const { calls, storage, res } = setup();
  assert.equal(await tryDirectInboxVideo({ mediaRef: ref, res, storage, env: enabled }), true);
  assert.deepEqual(calls[0], ["owned", ref.media_key]);
  assert.deepEqual(calls[1], ["head", ref.media_key]);
  assert.deepEqual(calls[2], ["sign", ref.media_key, { expiresSeconds: VIDEO_URL_TTL_SECONDS }]);
  assert.ok(VIDEO_URL_TTL_SECONDS <= 600);
  assert.deepEqual(calls[3][1], {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  assert.equal(calls[4][0], "redirect");
  assert.equal(calls[4][1], 302);
  assert.match(calls[4][2], /X-Amz-Signature/);
  const route = source.slice(source.indexOf('router.get("/:contactId/messages/:messageId/media"'),
    source.indexOf('router.post("/:contactId/takeover"'));
  assert.ok(route.indexOf("canAccessContact(req.user, contactId)") >= 0);
  assert.ok(route.indexOf("getMessageMediaReferenceForContact") < route.indexOf("canAccessContact(req.user, contactId)"));
  assert.ok(route.indexOf("canAccessContact(req.user, contactId)") < route.indexOf("tryDirectInboxVideo"));
  assert.match(route, /mp4DirectMode && !await canAccessContact/);
});

test("missing ownership, wrong R2 MIME, and empty objects retain Render fallback", async () => {
  for (const obj of [{ mime: "application/octet-stream" }, { mime: "video/mp4", bytes: 0 }]) {
    const { calls, storage, res } = setup(obj);
    assert.equal(await tryDirectInboxVideo({ mediaRef: ref, res, storage, env: enabled }), false);
    assert.equal(calls.some((item) => item[0] === "sign"), false);
  }
  const { calls, storage, res } = setup();
  storage.isOwnedStoredMediaKey = () => false;
  assert.equal(await tryDirectInboxVideo({ mediaRef: ref, res, storage, env: enabled }), false);
  assert.equal(calls.length, 0);
});

test("proxy override and disabled flag do not even query R2 metadata", async () => {
  for (const [env, query] of [[disabled, {}], [enabled, { delivery: "proxy" }]]) {
    const { calls, storage, res } = setup();
    assert.equal(await tryDirectInboxVideo({ mediaRef: ref, query, res, storage, env }), false);
    assert.equal(calls.length, 0);
  }
});

test("R2 signing or HEAD errors quietly fall back without exposing media details", async () => {
  const { calls, storage, res } = setup({ throws: true });
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(await tryDirectInboxVideo({ mediaRef: ref, res, storage, env: enabled }), false);
  } finally {
    console.warn = original;
  }
  assert.equal(calls.some((item) => item[0] === "sign"), false);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes(ref.media_key), false);
  assert.equal(JSON.stringify(warnings).includes("sensitive object key"), false);
});
