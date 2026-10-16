"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");
const templates = require("../src/services/whatsappTemplateService");
const { buildStaticMarketingTemplate } = require("../src/utils/freeEntryTemplateSelection");

const media = {
  pelvisIntro: "messages/follow-up-config/pelvis-intro.mp4",
  pelvisFeedback: "messages/follow-up-config/pelvis-feedback.mp4",
  face: "messages/follow-up-config/face.mp4",
};
const rule = (slotHours, serviceName, templateName, mediaKey = "") =>
  ({ slotHours, serviceName, templateName, mediaKey, mediaUrl: "",
    videoCodecVerified: Boolean(mediaKey) });
const active = {
  language: "zh_CN", templateName: "ns_enquiry_reengagement",
  templateRules: [
    rule(48, "*", "ns_enquiry_reengagement"),
    rule(48, "骨盆调理", "ns_pelvis_followup_video", media.pelvisIntro),
    rule(48, "3D 小颜术", "ns_fu3_face_feedback", media.face),
    rule(66, "*", "ns_fu2_general_checkin"),
    rule(66, "骨盆调理", "ns_fu3_pelvis_feedback", media.pelvisFeedback),
  ],
};
const createTemplate = (name, format = "TEXT", language = "zh_CN") =>
  templates.normalizeTemplate({
    name, category: "MARKETING", status: "APPROVED", language,
    components: [
      ...(format === "VIDEO" ? [{ type: "HEADER", format: "VIDEO" }] : []),
      { type: "BODY", text: "Neutro Sense TCM customer follow-up" },
    ],
  });
const catalog = [
  createTemplate("ns_enquiry_reengagement"),
  createTemplate("ns_fu2_general_checkin"),
  createTemplate("ns_pelvis_followup_video", "VIDEO"),
  createTemplate("ns_fu3_pelvis_feedback", "VIDEO"),
  createTemplate("ns_fu3_face_feedback", "VIDEO"),
  createTemplate("ns_enquiry_reengagement", "TEXT", "en_US"),
  createTemplate("ns_fu2_general_checkin", "TEXT", "en_US"),
  createTemplate("ns_fu3_face_feedback", "VIDEO", "en"),
];
const candidate = (treatment_interest, previous = [], overrides = {}) => ({
  treatment_interest, recent_inbound_messages: [],
  used_template_names: [], previously_sent_media_keys: previous,
  ...overrides,
});
// Keep real selection, service-interest matching and approved template
// normalization, while substituting the R2 presigned URL for this unit test.
const resolve = (lead, hours, cfg, approved, opts = {}) =>
  worker.resolveSafeTemplate(lead, hours, cfg, approved, {
    materialize: (spec) => ({ ...spec,
      mediaUrl: spec.mediaKey ? "https://clinic.example/test-video.mp4" : "" }),
    build: buildStaticMarketingTemplate,
    ...opts,
  });
const choose = (lead, hours, cfg = active, approved = catalog, opts = {}) =>
  worker.selectEligibleTemplate(lead, hours, cfg, approved, {
    resolve, validate: async () => true, isDuplicate: async () => false, ...opts,
  });

test("48h new pelvis lead selects approved first pelvic video and builds VIDEO header", async () => {
  const chosen = await choose(candidate("骨盆调理"), 48);
  assert.equal(chosen?.template.name, "ns_pelvis_followup_video");
  assert.equal(chosen.spec.mediaKey, media.pelvisIntro);
  const built = buildStaticMarketingTemplate(chosen.template, {
    ...chosen.spec, mediaUrl: "https://clinic.example/test-video.mp4",
  }, templates);
  assert.equal(built.components[0].type, "header");
  assert.equal(built.components[0].parameters[0].type, "video");
});

test("48h prior pelvis video falls back ONLY to 48h configured re-engagement text", async () => {
  const chosen = await choose(candidate("骨盆调理", [media.pelvisIntro]), 48);
  assert.equal(chosen?.template.name, "ns_enquiry_reengagement");
  assert.equal(chosen.spec.mediaKey, "");
  const built = buildStaticMarketingTemplate(chosen.template, chosen.spec, templates);
  assert.ok(built);
  assert.equal(built.components.some((c) => c.type === "header"), false);
});

test("66h prior pelvis testimonial falls back ONLY to 66h general text", async () => {
  const chosen = await choose(candidate("骨盆调理", [media.pelvisFeedback]), 66);
  assert.equal(chosen?.template.name, "ns_fu2_general_checkin");
  assert.equal(chosen.spec.mediaKey, "");
});

test("same-content video with different filename uses the slot text fallback", async () => {
  const lead = candidate("3D 小颜术", ["messages/follow-up-config/9d.mp4"]);
  const chosen = await choose(lead, 48, active, catalog, {
    isDuplicate: async (key, keys) => key === media.face && keys.length === 1,
  });
  assert.equal(chosen?.template.name, "ns_enquiry_reengagement");
});

test("if the clip is unavailable, fall back to same-slot text without changing approved copy", async () => {
  const chosen = await choose(candidate("骨盆调理"), 66, active, catalog, {
    validate: async (template) => template.header?.format !== "VIDEO",
  });
  assert.equal(chosen?.template.name, "ns_fu2_general_checkin");
});

test("unapproved or already used fallback must never trigger another template or duplicate send", async () => {
  const lead = candidate("骨盆调理", [media.pelvisIntro],
    { used_template_names: ["ns_enquiry_reengagement"] });
  assert.equal(await choose(lead, 48), null);
  assert.equal(await choose(candidate("骨盆调理", [media.pelvisFeedback]), 66,
    active, catalog.filter((t) => t.name !== "ns_fu2_general_checkin")), null);
});

test("other treatments never inherit pelvis video rules", async () => {
  assert.equal((await choose(candidate("3D 小颜术"), 48))?.template.name, "ns_fu3_face_feedback");
  assert.equal((await choose(candidate("9D 逆龄抗衰"), 48))?.template.name, "ns_enquiry_reengagement");
});

test("Meta's approved en video variant is selected for an English face enquiry", async () => {
  const settings = { ...active, language: "auto" };
  const english = candidate("3D 小颜术", [], {
    recent_inbound_messages: ["Hello, I am interested in 3D face sculpting"],
  });
  const chosen = await choose(english, 48, settings);
  assert.equal(chosen?.template.name, "ns_fu3_face_feedback");
  assert.equal(chosen?.template.language, "en");
});

test("final send path uses a new eligibility selection instead of trusting the initial snapshot", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const code = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /await selectEligibleTemplate\(fresh, slotHours, liveActive, templateCatalog\)/);
  assert.match(code, /await selectEligibleTemplate\(\s*candidate, slotHours, active, catalog\.templates\)/);
  assert.match(code, /await mediaAlreadyShared\(spec\.mediaKey/);
  assert.match(code, /preflightTemplate/);
  assert.match(code, /marketing_consent = 'opted_in'/);
});
