"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/utils/followUpTemplateMediaPolicy");
const storage = require("../src/services/mediaStorageService");
const { validateApprovedMedia } = require("../src/utils/freeEntryTemplateSelection");

const key = "messages/follow-up-config/copied-package.jpg";
const video = "messages/follow-up-config/face-feedback.mp4";
const at = (day) => new Date(day + "T12:00:00+08:00").getTime();
const config = {
  services: [{ name: "骨盆调理" }, { name: "3D 小颜术" }],
  timezone: "Asia/Kuala_Lumpur",
  automatedFollowUp: {
    additionalSteps: [
      { serviceOverrides: [{ serviceName: "3D 小颜术", videoKey: video, videoFilename: "face-feedback.mp4" }] },
    ],
    freeEntry: { templateRules: [] },
  },
  promotions: [{
    name: "Pelvic Package",
    linkedService: "骨盆调理",
    imageUrl: "/promo-images/42",
    validFrom: "2026-10-01",
    validUntil: "2026-10-31",
  }],
};
const promoSpec = {
  templateName: "ns_custom_pricing_image",
  serviceName: "骨盆调理",
  identifiedTreatment: "骨盆调理",
  mediaKey: key, mediaUrl: "", mediaSourceId: "promo:42",
};
const imageTemplate = { name: "ns_custom_pricing_image", header: { format: "IMAGE" } };

test("configured promotional image is valid only for its original service and active date", () => {
  assert.equal(policy.isSafeTemplateMediaContext(promoSpec, imageTemplate, {
    config, now: at("2026-10-09"),
  }), true);
  assert.equal(policy.isSafeTemplateMediaContext(promoSpec, imageTemplate, {
    config, now: at("2026-11-02"),
  }), false);
  assert.equal(policy.isSafeTemplateMediaContext({ ...promoSpec, identifiedTreatment: "3D 小颜术" },
    imageTemplate, { config, now: at("2026-10-09") }), false);
  assert.equal(policy.invalidConfiguredMediaRule([
    { ...promoSpec, slotHours: 50 },
  ], config, at("2026-10-09")), null, "active clinic promotion can be saved");
  assert.equal(policy.invalidConfiguredMediaRule([
    { ...promoSpec, slotHours: 50 },
  ], config, at("2026-11-02"))?.reason,
  "The source image/video is no longer active or available.");
});

test("automated sends verify R2 origin metadata as well as promotion validity", async () => {
  const mediaStore = {
    isSharedFollowUpConfigKey: () => true,
    getSharedFollowUpMediaInfo: async () => ({
      bytes: 1000, mimeType: "image/jpeg",
      metadata: { "clinic-promo-image-id": "42" },
    }),
  };
  assert.equal(await validateApprovedMedia(imageTemplate, promoSpec, {
    config, now: at("2026-10-09"), mediaStore,
  }), true);
  assert.equal(await validateApprovedMedia(imageTemplate, promoSpec, {
    config, now: at("2026-11-02"), mediaStore,
  }), false);
  assert.equal(await validateApprovedMedia(imageTemplate, promoSpec, {
    config, now: at("2026-10-09"),
    mediaStore: { ...mediaStore, getSharedFollowUpMediaInfo: async () => ({
      bytes: 1000, mimeType: "image/jpeg",
      metadata: { "clinic-promo-image-id": "99" },
    }) },
  }), false);
});

test("copied Package A promotion media cannot be sent without an explicit A choice", async () => {
  const withPackages = {
    ...config,
    promotions: [{
      name: "Pelvis offer", linkedService: "骨盆调理",
      validFrom: "2026-10-01", validUntil: "2026-10-31",
      packages: [
        { name: "Package A", imageUrl: "/promo-images/55" },
        { name: "Package B", imageUrl: "/promo-images/56" },
      ],
    }],
  };
  const spec = { ...promoSpec, mediaSourceId: "promo:55" };
  const mediaStore = {
    isSharedFollowUpConfigKey: () => true,
    getSharedFollowUpMediaInfo: async () => ({
      bytes: 1000, mimeType: "image/jpeg",
      metadata: { "clinic-promo-image-id": "55" },
    }),
  };
  const validate = (messages) => validateApprovedMedia(imageTemplate, {
    ...spec, recentInboundMessages: messages,
  }, { config: withPackages, now: at("2026-10-09"), mediaStore });
  assert.equal(await validate(["我要 Package A"]), true);
  assert.equal(await validate(["我要 Package B"]), false);
  assert.equal(await validate(["Package A or B?"]), false);
  assert.equal(await validate(["想知道骨盆调理"]), false);
});

test("pelvic/face templates cannot reuse media intended for another treatment", () => {
  const spec = {
    templateName: "ns_fu3_pelvis_feedback",
    serviceName: "骨盆调理", identifiedTreatment: "骨盆调理",
    mediaKey: video, mediaSourceId: "", videoCodecVerified: true,
  };
  const template = { name: "ns_fu3_pelvis_feedback", header: { format: "VIDEO" } };
  assert.equal(policy.isSafeTemplateMediaContext(spec, template, {
    config, now: at("2026-10-09"),
  }), false);
  assert.match(policy.invalidConfiguredMediaRule([spec], config)?.reason || "", /different treatment|template/i);
  assert.equal(policy.isSafeTemplateMediaContext({
    ...spec, serviceName: "*",
  }, template, { config }), false);
  assert.equal(policy.allowedForTreatment("ns_fu3_pelvis_feedback", "3D 小颜术"), false);
});

test("an unverified reused or remote MP4 is blocked before extended WhatsApp activation", () => {
  const common = {
    templateName: "ns_fu3_face_feedback",
    serviceName: "3D 小颜术",
    mediaKey: video,
    mediaUrl: "",
    videoCodecVerified: false,
  };
  assert.match(policy.invalidConfiguredMediaRule([common], config)?.reason || "",
    /verify.*H\.264\/AAC MP4/i);
  assert.equal(policy.invalidConfiguredMediaRule([
    { ...common, mediaKey: "", mediaUrl: "https://approved.example.test/video.mp4" },
  ], config)?.reason?.includes("Verify"), true);
  assert.equal(policy.invalidConfiguredMediaRule([
    { ...common, videoCodecVerified: true },
  ], config), null);
});

test("legacy R2 preview requires an exact clinic reference, not just a shared prefix", () => {
  const env = { CLIENT_SLUG: "clinic-one" };
  const ownedKey = "clients/clinic-one/messages/follow-up-config/copied-package.jpg";
  const own = { automatedFollowUp: {
    videoKey: "messages/follow-up-config/clinic-video.mp4",
    freeEntry: { templateRules: [{ mediaKey: ownedKey }, { mediaKey: key }] },
  } };
  assert.equal(storage.isReferencedClinicFollowUpMediaKey(ownedKey, own, env), true);
  assert.equal(storage.isReferencedClinicFollowUpMediaKey(key, own, env), false,
    "legacy shared-bucket prefix cannot establish tenant ownership");
  assert.equal(storage.isReferencedClinicFollowUpMediaKey("messages/follow-up-config/foreign.jpg", own, env), false);
  assert.equal(storage.isReferencedClinicFollowUpMediaKey("clients/another-clinic/messages/follow-up-config/video.mp4", own, env), false);
});
