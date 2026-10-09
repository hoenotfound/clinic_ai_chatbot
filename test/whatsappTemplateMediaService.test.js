const test = require("node:test");
const assert = require("node:assert/strict");
const media = require("../src/services/whatsappTemplateMediaService");
const { pool } = require("../src/db/db");
const messagesRepo = require("../src/db/messagesRepo");
const mediaStorage = require("../src/services/mediaStorageService");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64"
);
const jpeg = Buffer.from([
  0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0x02,0x00,0x02,0x03,
  0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,0xff,0xda,0x00,0x02,0x00,
  0xff,0xd9,
]);
const sharedVideo = "messages/follow-up-config/pelvis.mp4";
const baseConfig = {
  automatedFollowUp: { additionalSteps: [
    { serviceOverrides: [
      { serviceName: "骨盆调理", videoKey: sharedVideo, videoFilename: "pelvis.mp4" },
      { serviceName: "Duplicate", videoKey: sharedVideo },
      { serviceName: "Wrong namespace", videoKey: "clients/other/messages/follow-up-config/secret.mp4" },
    ] },
  ] },
  promotions: [
    { name: "Pelvis", validFrom: "2026-10-01", validUntil: "2026-10-31",
      packages: [
        { name: "Package A", imageUrl: "https://clinic.example/promo-images/30" },
        { name: "Patient", imageUrl: "/api/config/result-media/image/90" },
      ] },
    { name: "Expired", validUntil: "2026-09-30", imageUrl: "/promo-images/31" },
  ],
};

test("JPEG and PNG template validation rejects corrupted, oversized and unsupported uploads", async () => {
  assert.strictEqual(await media.prepareImage(jpeg, "image/jpeg"), jpeg);
  assert.strictEqual(await media.prepareImage(png, "image/png"), png);
  await assert.rejects(media.prepareImage(png, "image/jpeg"), /Invalid or oversized JPEG/);
  await assert.rejects(media.prepareImage(Buffer.from([0xff, 0xd8]), "image/jpeg"), /Invalid or oversized JPEG/);
  await assert.rejects(media.prepareImage(Buffer.concat([jpeg, Buffer.from([1])]), "image/jpeg"),
    /Invalid or oversized JPEG/);
  const oversizedPixels = Buffer.from(png);
  oversizedPixels.writeUInt32BE(100000, 16);
  await assert.rejects(media.prepareImage(oversizedPixels, "image/png"), /Invalid or oversized PNG/);
  await assert.rejects(media.prepareImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"), /5MB/);
  await assert.rejects(media.prepareImage(png, "image/webp"), /JPEG or PNG/);
  const progressive = Buffer.from(jpeg);
  progressive[3] = 0xc2;
  let normalized = 0;
  const result = await media.prepareImage(progressive, "image/jpeg", { normalize: async () => {
    normalized += 1;
    return jpeg;
  } });
  assert.equal(normalized, 1);
  assert.deepEqual(result, jpeg);
});

test("video codec verification rejects HEVC without converting or retaining temporary files", async () => {
  await assert.rejects(media.verifyVideoBuffer(Buffer.from("video"), {
    probe: async () => ({ videoCodec: "hevc", audioCodec: "aac" }),
  }), /unsupported codec/);
  const passed = await media.verifyVideoBuffer(Buffer.from("video"), {
    probe: async () => ({ videoCodec: "h264", audioCodec: "aac" }),
  });
  assert.equal(passed.toString(), "video");
});

test("available clinic media excludes expired promotions, private assets and cross-client keys", () => {
  const options = media.listReusableMedia({
    config: baseConfig, now: Date.parse("2026-10-09T00:00:00Z"),
  });
  assert.equal(options.length, 2);
  assert.equal(options.filter((o) => o.format === "VIDEO").length, 1);
  assert.equal(options.filter((o) => o.format === "IMAGE").length, 1);
  assert.equal(options.some((o) => o.imageId === 31 || o.imageId === 90), false);
  assert.equal(media.publicMediaOptions(options).every((o) => !o.mediaKey && !o.imageId), true);
  assert.equal(media.promoIdFromUrl("https://clinic/promo-images/30"), 30);
  assert.equal(media.promoIdFromUrl("https://clinic/api/config/result-media/image/90"), null);
});

test("reusable R2 video sends and retries resolve the same key without permanent copies", async () => {
  const options = media.listReusableMedia({
    config: baseConfig, now: Date.parse("2026-10-09T00:00:00Z"),
  });
  const id = options.find((option) => option.format === "VIDEO").id;
  let mediaReads = 0;
  const store = {
    getSharedFollowUpMediaInfo: async (key) => {
      assert.equal(key, sharedVideo);
      return { bytes: 5, mimeType: "video/mp4" };
    },
    downloadMedia: async (key) => {
      mediaReads++;
      assert.equal(key, sharedVideo);
      return Buffer.from("video");
    },
    uploadMedia: async () => { throw Error("must not duplicate permanent shared video"); },
  };
  for (let i = 0; i < 2; i++) {
    const result = await media.resolveReusableMedia(id, "VIDEO", {
      config: baseConfig, now: Date.parse("2026-10-09T00:00:00Z"),
      store, validateVideo: async (buffer) => buffer,
    });
    assert.equal(result.mediaKey, sharedVideo);
    assert.equal(result.mediaUrl, null);
    assert.equal(result.mimeType, "video/mp4");
  }
  assert.equal(mediaReads, 2);
  await assert.rejects(media.resolveReusableMedia(id, "IMAGE", { config: baseConfig }), /no longer available/);
});

test("existing promotional images use the original database asset and reject private or expired media", async () => {
  const id = media.listReusableMedia({ config: baseConfig, now: Date.parse("2026-10-09T00:00:00Z") })
    .find((option) => option.format === "IMAGE").id;
  const args = { config: baseConfig, now: Date.parse("2026-10-09T00:00:00Z"),
    promos: { getPublicImage: async (idValue) => {
      assert.equal(idValue, 30);
      return { mime_type: "image/png", data: png.toString("base64") };
    } },
  };
  const result = await media.resolveReusableMedia(id, "IMAGE", args);
  assert.equal(result.mediaKey, null);
  assert.equal(result.mediaUrl, "/promo-images/30");
  assert.deepEqual(result.buffer, png);
  await assert.rejects(media.resolveReusableMedia(id, "IMAGE", {
    ...args, promos: { getPublicImage: async () => null },
  }), /unavailable or private/);
  await assert.rejects(media.resolveReusableMedia(id, "IMAGE", {
    ...args, now: Date.parse("2026-11-01T00:00:00Z"),
  }), /no longer available/);
  await assert.rejects(media.resolveReusableMedia("promo:90", "IMAGE", args), /no longer available/);
});

test("template image retry loader retains R2 key without a base64 download", async (t) => {
  const query = pool.query;
  const download = mediaStorage.downloadMedia;
  t.after(() => { pool.query = query; mediaStorage.downloadMedia = download; });
  mediaStorage.downloadMedia = async () => { throw new Error("image template retry must use R2 key"); };
  pool.query = async (sql) => {
    assert.match(sql, /m\.whatsapp_template/);
    return { rows: [{
      id: 100, contact_id: 7, role: "assistant", media_key: "messages/7/offer.jpg",
      media_mime_type: "image/jpeg", delivery_status: "failed",
      whatsapp_template: { name: "ns_fu_pricing_graphic", mediaFormat: "IMAGE" },
    }] };
  };
  const result = await messagesRepo.getMessageForRetry(7, 100);
  assert.equal(result.media_key, "messages/7/offer.jpg");
  assert.equal(result.media_base64, null);
});

test("normal non-template image retries retain the original Base64 compatibility", async (t) => {
  const query = pool.query;
  const download = mediaStorage.downloadMedia;
  t.after(() => { pool.query = query; mediaStorage.downloadMedia = download; });
  mediaStorage.downloadMedia = async () => Buffer.from("old-image");
  pool.query = async () => ({ rows: [{
    id: 101, contact_id: 7, role: "assistant", media_key: "messages/7/old.jpg",
    media_mime_type: "image/jpeg", delivery_status: "failed",
    whatsapp_template: null,
  }] });
  const result = await messagesRepo.getMessageForRetry(7, 101);
  assert.equal(result.media_key, undefined);
  assert.equal(result.media_base64, Buffer.from("old-image").toString("base64"));
});
