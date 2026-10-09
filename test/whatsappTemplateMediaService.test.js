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


test("promotion expiry respects Malaysia-local midnight rather than UTC", () => {
  const offer = { validFrom: "2026-10-01", validUntil: "2026-10-31" };
  assert.equal(media.clinicLocalDate("2026-10-31T15:59:59.000Z"), "2026-10-31");
  assert.equal(media.clinicLocalDate("2026-10-31T16:00:00.000Z"), "2026-11-01");
  assert.equal(media.currentlyValid(offer, "2026-10-31T15:59:59.000Z"), true);
  assert.equal(media.currentlyValid(offer, "2026-10-31T16:00:00.000Z"), false);
  assert.equal(media.currentlyValid(offer, "2026-09-30T15:59:59.000Z"), false);
  assert.equal(media.currentlyValid(offer, "2026-09-30T16:00:00.000Z"), true);
  assert.equal(media.clinicLocalDate("2026-10-31T16:00:00.000Z", "Invalid/Timezone"),
    "2026-11-01", "bad timezone must not silently shift expiration to UTC");
});

test("only 9D and 3D+9D current promotions qualify for free meridian gift templates", () => {
  const promotions = [
    { name: "Pelvis", linkedService: "骨盆调理", validUntil: "2026-10-31",
      packages: [
        { name: "Package A", imageUrl: "/promo-images/30",
          caption: "包括经络穴位按摩" },
        { name: "Package B", imageUrl: "/promo-images/31",
          caption: "Female care" },
      ],
    },
    { name: "3D", linkedService: "3D 小颜术", validUntil: "2026-10-31",
      followUpMessage: "本月另外再送 全身通淋巴按摩 1 小时",
      imageUrl: "/promo-images/32" },
    { name: "9D", linkedService: "9D 逆龄抗衰", validUntil: "2026-10-31",
      followUpMessage: "Free 全身通十二经络按摩 - 1 小时",
      imageUrl: "/promo-images/21" },
    { name: "Combo", linkedService: "3D + 9D 组合", validUntil: "2026-10-31",
      followUpMessage: "额外免费送你 1 小时经络穴位按摩",
      imageUrl: "/promo-images/22" },
  ];
  const config = { promotions, automatedFollowUp: { additionalSteps: [] } };
  const now = Date.parse("2026-10-09T00:00:00Z");
  const items = media.listReusableMedia({ config, now });
  const eligible = items.filter((item) => media.isTemplateCompatible("ns_fu_meridian_gift", item));
  assert.deepEqual(eligible.map((item) => item.imageId).sort(), [21, 22]);
  const combo = items.find((item) => item.imageId === 22);
  const packageB = items.find((item) => item.imageId === 31);
  assert.equal(media.expectedMediaValue(combo, "en_US"), "3D + 9D Combination");
  assert.equal(media.expectedMediaValue(combo, "ms"), "Gabungan 3D + 9D");
  assert.equal(media.expectedMediaValue(packageB, "ms"), "Pakej B Penjagaan Pelvis");
  assert.throws(() => media.validateTemplateMediaChoice("ns_fu_meridian_gift", "zh_CN",
    packageB.id, { body: ["骨盆调理 Package B"] }, { config, now }), /requires the matching/);
  assert.throws(() => media.validateTemplateMediaChoice("ns_fu_meridian_gift", "zh_CN",
    combo.id, { body: ["骨盆调理 Package B"] }, { config, now }), /package name must match/);
  assert.equal(media.validateTemplateMediaChoice("ns_fu_meridian_gift", "en_US",
    combo.id, { body: ["3D + 9D Combination"] }, { config, now }).imageId, 22);
  assert.throws(() => media.validateTemplateMediaChoice("ns_fu_pricing_graphic", "en_US",
    packageB.id, { body: ["Pelvis Care Package A"] }, { config, now }), /package name must match/);
  assert.throws(() => media.validateTemplateMediaChoice("ns_fu_meridian_gift", "zh_CN",
    "", { body: [] }, { config, now }), /requires the matching/);
  assert.equal(media.listReusableMedia({ config, now: Date.parse("2026-10-31T16:00:00Z") })
    .length, 0, "expired offers must disappear at Malaysia midnight");
});

test("service-specific video headers select only configured matching follow-up stage and service", () => {
  const config = { automatedFollowUp: { additionalSteps: [
    { serviceOverrides: [{ serviceName: "骨盆调理",
      videoKey: "messages/follow-up-config/pain.mp4" }] },
    { serviceOverrides: [
      { serviceName: "骨盆调理", videoKey: "messages/follow-up-config/pelvis.mp4" },
      { serviceName: "3D 小颜术", videoKey: "messages/follow-up-config/face.mp4" },
    ] },
  ] } };
  const choices = media.listReusableMedia({ config });
  const pelvis2 = choices.find((item) => item.stepNumber === 2);
  const pelvis3 = choices.find((item) => item.stepNumber === 3 && item.serviceName === "骨盆调理");
  const face3 = choices.find((item) => item.serviceName === "3D 小颜术");
  assert.equal(media.isTemplateCompatible("ns_fu2_pelvis_video", pelvis2), true);
  assert.equal(media.isTemplateCompatible("ns_fu3_pelvis_feedback", pelvis2), false);
  assert.equal(media.isTemplateCompatible("ns_fu3_pelvis_feedback", pelvis3), true);
  assert.equal(media.isTemplateCompatible("ns_fu3_face_feedback", pelvis3), false);
  assert.equal(media.isTemplateCompatible("ns_fu3_face_feedback", face3), true);
});

test("the reusable-media selector exposes compatibility without leaking private R2 keys", () => {
  const options = media.publicMediaOptions(media.listReusableMedia({
    config: { automatedFollowUp: { additionalSteps: [
      { serviceOverrides: [{serviceName:"骨盆调理",
        videoKey:"messages/follow-up-config/video.mp4"}] },
    ] } },
  }));
  assert.equal(options.length, 1);
  assert.equal(options[0].compatibleTemplates.includes("ns_fu2_pelvis_video"), true);
  assert.equal(Object.hasOwn(options[0], "mediaKey"), false);
});
