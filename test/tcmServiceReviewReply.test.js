const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bareServiceName, recoverTcmServiceReviewReply } =
  require("../src/utils/tcmServiceReviewReply");

const services = [
  { name: "徒手体态调理" },
  { name: "骨盆调理" },
  { name: "3D 小颜术" },
];
const serviceAliases = [
  { alias: "整骨", officialService: "徒手体态调理" },
  { alias: "pelvic adjustment", officialService: "骨盆调理" },
  { alias: "face alignment", officialService: "3D 小颜术" },
  { alias: "facial alignment", officialService: "3D 小颜术" },
];
const options = (customerText, language = "en") => ({
  businessType: "tcm_clinic", customerText, language, services, serviceAliases,
});

test("exactly configured service mentions recover from model-only review", () => {
  const lumbar = recoverTcmServiceReviewReply(options("Lumber spine 4 + 5"));
  const pelvic = recoverTcmServiceReviewReply(options("Pelvic adjustment"));
  const face = recoverTcmServiceReviewReply(options("Face alignment"));
  // The spinal description still needs a practitioner's review. The next
  // two ordinary service enquiries must not stay silent.
  assert.equal(lumbar, null);
  assert.match(pelvic, /pelvic adjustment/i);
  assert.match(face, /face alignment/i);
  for (const reply of [pelvic, face]) {
    assert.match(reply, /practitioner/i);
    assert.match(reply, /assessment/i);
    assert.doesNotMatch(reply, /\bRM\s?\d|cure|guarantee|fix your spine|realign your bones/i);
  }
});

test("clinical qualifications and suitability requests never get a service fallback", () => {
  for (const text of [
    "Can pelvic adjustment fix L4/L5?",
    "Pelvic adjustment for my slipped disc?",
    "Pelvic adjustment after surgery",
    "Pelvic adjustment if pregnant",
    "Face alignment after Botox",
    "Face alignment and sudden facial drooping",
    "Pelvic adjustment, I need to speak to a staff member",
    "Do you treat both pelvic adjustment and face alignment?",
    "Lumber spine 4 + 5",
    "Pelvic adjustment多少钱?",
    "Can I receive pelvic adjustment?",
    "Face alignment is safe for me?",
    "Face alignment! I have severe pain",
    "How much is pelvic adjustment?",
  ]) {
    assert.equal(recoverTcmServiceReviewReply(options(text)), null, text);
  }
});

test("requires a unique currently configured alias and a TCM industry", () => {
  assert.equal(recoverTcmServiceReviewReply({
    ...options("Face alignment"),
    serviceAliases: serviceAliases.filter((x) => x.alias !== "face alignment"),
  }), null);
  assert.equal(recoverTcmServiceReviewReply({
    ...options("Pelvic adjustment"),
    businessType: "aesthetic_clinic",
  }), null);
  assert.equal(recoverTcmServiceReviewReply({
    ...options("Pelvic adjustment"),
    serviceAliases: [{ alias: "pelvic adjustment", officialService: "Unknown treatment" }],
  }), null);
  assert.equal(bareServiceName("Pelvic adjustment!", services, serviceAliases)?.service.name, "骨盆调理");
});

test("recovery is localized and keeps assessment-first without pricing", () => {
  const zh = recoverTcmServiceReviewReply(options("骨盆调理", "zh"));
  const ms = recoverTcmServiceReviewReply(options("Pelvic adjustment", "ms"));
  assert.match(zh, /中医师.*评估/);
  assert.match(ms, /menilai.*penilaian/i);
  assert.doesNotMatch(zh + ms, /RM\s?\d|首购|promo/i);
});

test("runtime recovery sits behind the model review outcome and preserves staff reviews", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const prompt = fs.readFileSync(path.join(__dirname, "../src/utils/systemPrompt.js"), "utf8");
  const start = server.indexOf("if (flagged && reviewRequired && !keywordReason)");
  const end = server.indexOf("// Do not permit a model", start);
  assert.ok(start > 0 && end > start);
  const block = server.slice(start, end);
  assert.match(block, /recoverTcmServiceReviewReply/);
  assert.match(block, /businessType: clinicConfig\.businessType/);
  assert.match(block, /priceQuery = false/);
  assert.match(block, /packageQuery = false/);
  assert.match(server.slice(end), /if \(flagged && reviewRequired\)[\s\S]*?setAiReviewAttention/);
  assert.match(prompt, /A customer merely naming a body area/);
  assert.match(prompt, /If they ask whether a specific treatment will fix their spinal condition/);
});
