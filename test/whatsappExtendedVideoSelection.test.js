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

test("48h and 66h fallback proceeds through the guarded provider-send path as configured", async (t) => {
  const { pool } = require("../src/db/db");
  const clinicConfig = require("../src/config/clinicConfig");
  const zeroCostGuard = require("../src/services/whatsappZeroCostGuard");
  const messagesRepo = require("../src/db/messagesRepo");
  const realtime = require("../src/utils/realtimeEvents");
  const keys = ["WHATSAPP_FEP_FOLLOWUPS_ENABLED", "AUTOMATED_REPLIES_ENABLED"];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => { process.env[key] = "true"; });
  const original = {
    query: pool.query, connect: pool.connect,
    auto: clinicConfig.automatedFollowUp, services: clinicConfig.services,
    enabled: zeroCostGuard.enabled, preflight: zeroCostGuard.preflightTemplate,
    send: templates.sendApprovedTemplate,
    save: messagesRepo.saveMessage, setWamid: messagesRepo.setWhatsappMessageId,
    setStatus: messagesRepo.setDeliveryStatusById, publish: realtime.publish,
  };
  t.after(() => {
    keys.forEach((key) => {
      if (previousEnv[key] == null) delete process.env[key];
      else process.env[key] = previousEnv[key];
    });
    pool.query = original.query;
    pool.connect = original.connect;
    clinicConfig.automatedFollowUp = original.auto;
    clinicConfig.services = original.services;
    zeroCostGuard.enabled = original.enabled;
    zeroCostGuard.preflightTemplate = original.preflight;
    templates.sendApprovedTemplate = original.send;
    messagesRepo.saveMessage = original.save;
    messagesRepo.setWhatsappMessageId = original.setWamid;
    messagesRepo.setDeliveryStatusById = original.setStatus;
    realtime.publish = original.publish;
  });
  clinicConfig.services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }];
  clinicConfig.automatedFollowUp = {
    enabled: true, quietHours: { enabled: false },
    freeEntry: { enabled: true, activatedAt: "2026-10-01T00:00:00Z",
      templateName: active.templateName, language: active.language,
      fallbackLanguage: "zh_CN", slotsHours: [48, 66],
      templateRules: active.templateRules },
  };
  zeroCostGuard.enabled = () => false;
  zeroCostGuard.preflightTemplate = async () => ({ allowed: true });
  let fresh;
  let nextId = 710;
  const sent = [], saved = [];
  pool.query = async (sql) => {
    if (sql.includes("FROM contacts c")) return { rows: [fresh] };
    if (sql.includes("INSERT INTO whatsapp_free_entry_followup_attempts")) {
      return { rows: [{ id: 555 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  pool.connect = async () => ({ query: (...args) => pool.query(...args), release() {} });
  templates.sendApprovedTemplate = async (_contact, payload) => {
    sent.push(payload);
    return { success: true, wamid: "wamid.fallback-" + sent.length };
  };
  messagesRepo.saveMessage = async (...args) => {
    saved.push(args);
    return { id: nextId++ };
  };
  messagesRepo.setWhatsappMessageId = async () => {};
  messagesRepo.setDeliveryStatusById = async () => {};
  realtime.publish = () => {};
  const configured = worker.settings();
  assert.ok(configured);
  const now = new Date();
  for (const [hours, key, expected] of [
    [48, media.pelvisIntro, "ns_enquiry_reengagement"],
    [66, media.pelvisFeedback, "ns_fu2_general_checkin"],
  ]) {
    const firstReply = new Date(now.getTime() - (hours + 0.3) * 3600000);
    const firstInbound = new Date(firstReply.getTime() - 60_000);
    fresh = {
      ...candidate("骨盆调理", [key]),
      contact_id: 30 + hours, whatsapp_number: "60112223333",
      whatsapp_opt_in_at: firstInbound.toISOString(),
      first_inbound_at: firstInbound, first_reply_at: firstReply,
      last_inbound_at: firstInbound, first_reply_message_id: 1000 + hours,
      source_is_ctwa: true, evidence_type: "free_entry_point",
      claimed_slots: [], lead_temperature: "warm",
    };
    const resolved = await worker.selectEligibleTemplate(
      fresh, hours, configured, catalog);
    assert.equal(resolved?.template.name, expected);
    assert.equal(resolved.spec.mediaKey, "");
    assert.equal(await worker.processCandidate(
      fresh, configured, resolved.template, now, resolved.spec, catalog), "accepted");
    assert.equal(sent.at(-1)?.templateName, expected);
    assert.equal(sent.at(-1)?.components.some((comp) => comp.type === "header"), false);
    assert.equal(saved.at(-1)?.[8]?.whatsappTemplate?.name, expected);
  }
  assert.equal(sent.length, 2);
  assert.equal(saved.length, 2);
});

test("missing same-slot text rule fails closed, never borrowing the global default", async () => {
  const no48Text = { ...active, templateRules: active.templateRules.filter(
    (r) => !(r.slotHours === 48 && r.serviceName === "*")) };
  const no66Text = { ...active, templateRules: active.templateRules.filter(
    (r) => !(r.slotHours === 66 && r.serviceName === "*")) };
  assert.equal(await choose(candidate("骨盆调理", [media.pelvisIntro]), 48, no48Text), null);
  assert.equal(await choose(candidate("骨盆调理", [media.pelvisFeedback]), 66, no66Text), null);
  assert.equal(await choose(candidate("骨盆调理"), 48, no48Text)
    .then((x) => x?.template.name), "ns_pelvis_followup_video",
    "unseen approved video can still send when the fallback is not needed");
});

test("post-claim video race resolves to the exact approved text template before writing", async () => {
  const previous = [media.pelvisIntro];
  const recovered = await worker.selectClaimedVideoFallback(
    candidate("骨盆调理"), 48, active, catalog, previous, {
      resolve, validate: async () => true,
    });
  assert.equal(recovered?.template.name, "ns_enquiry_reengagement");
  assert.equal(recovered.spec.mediaKey, "");
  assert.equal(recovered.template.header?.format || "TEXT", "TEXT");
  const noText = { ...active, templateRules: active.templateRules.filter(
    (r) => !(r.slotHours === 48 && r.serviceName === "*")) };
  assert.equal(await worker.selectClaimedVideoFallback(
    candidate("骨盆调理"), 48, noText, catalog, previous,
    { resolve, validate: async () => true }), null);
});

test("post-claim race cannot substitute unapproved, media-bearing or wrong-language fallback", async () => {
  const lead = candidate("骨盆调理");
  const args = [lead, 48, active, catalog, [media.pelvisIntro]];
  assert.equal(await worker.selectClaimedVideoFallback(...args, {
    resolve: () => ({
      template: createTemplate("ns_fu3_face_feedback", "VIDEO"),
      spec: { mediaKey: media.face },
    }), validate: async () => true,
  }), null);
  assert.equal(await worker.selectClaimedVideoFallback(...args, {
    resolve: () => ({ template: createTemplate("ns_enquiry_reengagement"),
      spec: { mediaKey: "", mediaUrl: "" } }),
    validate: async () => false,
  }), null);
  assert.equal(await worker.selectClaimedVideoFallback(...args.slice(0, 3), null,
    [media.pelvisIntro], { resolve, validate: async () => true }), null);
});

test("claimed duplicate recovery is wired to the outbound worker before saveMessage", () => {
  const fs = require("node:fs"), path = require("node:path");
  const code = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  const recovery = code.indexOf("const fallback = await selectClaimedVideoFallback(");
  const persisted = code.indexOf("message = await messagesRepo.saveMessage(");
  assert.ok(recovery >= 0 && persisted > recovery);
  assert.match(code, /template = fallback\.template;\s*spec = fallback\.spec/);
});
