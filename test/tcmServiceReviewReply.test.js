const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bareServiceName, isStandaloneSpinalConcern, planTcmReviewReply, recoverTcmServiceReviewReply } =
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


function planFor(customerText, previous = [], pendingClinicalReview = false, language = "en") {
  return planTcmReviewReply({
    ...options(customerText, language),
    pendingClinicalReview,
    conversationHistory: [...previous, { role: "user", content: customerText }],
  });
}

test("original three-message conversation receives safe acknowledgements without repeat invitations", () => {
  const history = [
    { role: "user", content: "Can I know where is your location?" },
    { role: "assistant", content: "We are in Petaling Jaya. Are you asking about posture assessment or another treatment?" },
  ];
  const first = planFor("Lumber spine 4 + 5", history);
  assert.equal(isStandaloneSpinalConcern("Lumber spine 4 + 5"), true);
  assert.equal(first.preserveReview, true);
  assert.match(first.reply, /lower back|practitioner/i);
  history.push({ role: "user", content: "Lumber spine 4 + 5" }, { role: "assistant", content: first.reply });

  const second = planFor("Pelvic adjustment", history, true);
  assert.equal(second.preserveReview, true);
  assert.match(second.reply, /pelvic adjustment/i);
  assert.match(second.reply, /health concern.*practitioner/i);
  assert.doesNotMatch(second.reply, /would you like to arrange/i);
  history.push({ role: "user", content: "Pelvic adjustment" }, { role: "assistant", content: second.reply });

  const third = planFor("Face alignment", history, true);
  assert.equal(third.preserveReview, true);
  assert.match(third.reply, /face alignment/i);
  assert.doesNotMatch(third.reply, /would you like to arrange/i);
  const all = [first.reply, second.reply, third.reply].join("\n");
  assert.equal((all.match(/would you like to arrange/gi) || []).length, 1);
  assert.doesNotMatch(all, /\bRM\s*\d|guarantee|cure|fix.*spine|align.*bones/i);
});

test("historical clinical context or pending review cannot be downgraded to a normal sales reply", () => {
  for (const earlier of [
    "I had surgery last week.",
    "My lumbar spine L4/L5 is injured.",
    "I am pregnant.",
    "I have severe back pain.",
    "我的腰椎有椎间盘突出",
  ]) {
    const plan = planFor("Pelvic adjustment", [{ role: "user", content: earlier }]);
    assert.equal(plan?.preserveReview, true, earlier);
    assert.match(plan?.reply, /practitioner.*assess/i, earlier);
  }
  assert.equal(planFor("Face alignment", [], true)?.preserveReview, true);
  const urgent = planFor("Pelvic adjustment", [
    { role: "user", content: "I can't breathe and I feel faint." },
  ]);
  assert.equal(urgent?.preserveReview, true);
  assert.equal(urgent?.reply, null);
});

test("consecutive service enquiries receive one invitation with or without clinical context", () => {
  const first = planFor("Pelvic adjustment");
  assert.equal(first.preserveReview, false);
  assert.match(first.reply, /arrange a 1-to-1 assessment/i);
  const second = planFor("Face alignment", [
    { role: "user", content: "Pelvic adjustment" },
    { role: "assistant", content: first.reply },
  ]);
  assert.equal(second.preserveReview, false);
  assert.equal(second.alreadyInvited, true);
  assert.doesNotMatch(second.reply, /arrange a 1-to-1 assessment/i);
  const afterLocation = planFor("Pelvic adjustment", [
    { role: "assistant", content: "Are you asking about posture assessment or another treatment?" },
  ]);
  assert.match(afterLocation.reply, /arrange a 1-to-1 assessment/i);
});

test("Malay and Chinese with medical history remain safe and skip repeat invitations", () => {
  const zh = planFor("骨盆调理", [
    { role: "user", content: "刚刚做了手术" },
    { role: "assistant", content: "您想先安排1对1评估吗？" },
  ], true, "zh");
  assert.equal(zh.preserveReview, true);
  assert.match(zh.reply, /中医师.*评估/);
  assert.doesNotMatch(zh.reply, /您想先安排/);
  const ms = planFor("Pelvic adjustment", [
    { role: "user", content: "Saya baru menjalani pembedahan" },
    { role: "assistant", content: "Nak aturkan sesi penilaian 1-ke-1?" },
  ], true, "ms");
  assert.equal(ms.preserveReview, true);
  assert.match(ms.reply, /penilaian/i);
  assert.doesNotMatch(ms.reply, /Nak aturkan/);
  assert.doesNotMatch(zh.reply + ms.reply, /\bRM\s*\d/i);
});

test("unsafe or unverified context never allows reply recovery", () => {
  assert.equal(planTcmReviewReply({
    ...options("Pelvic adjustment"),
    pendingClinicalReview: null,
    conversationHistory: [{ role: "user", content: "Pelvic adjustment" }],
  }), null);
  assert.equal(planTcmReviewReply(options("Pelvic adjustment")), null);
  for (const message of [
    "Can pelvic adjustment fix my L4/L5?",
    "Pelvic adjustment after surgery",
    "Face alignment and sudden facial drooping",
    "Unknown manipulation therapy",
  ]) assert.equal(planFor(message), null, message);
});

test("runtime acknowledgement path persists review and exits before promotional media", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const review = server.split("if (flagged && reviewRequired) {")[1].split("} else if (flagged) {")[0];
  const saved = review.indexOf("await contactsRepo.setAiReviewAttention(");
  const guard = review.indexOf("if (clinicalAcknowledgement) {");
  const sent = review.indexOf("await sendTrackedText(");
  const returned = review.lastIndexOf("return { wasFirstMessage, keywordReason };");
  assert.ok(saved >= 0 && saved < guard && guard < sent && sent < returned);
  assert.match(review, /getAiOwnedContact/);
  assert.match(review, /canSendAutomatedReply/);
  assert.doesNotMatch(review, /sendImageByUrl|markBookingReadyForContact|resolvePricePromotionForReply/);
  assert.match(server, /hasPendingClinicalAiReview\(contact.id\)/);
  assert.match(server, /plan\.preserveReview/);
  assert.match(server, /plan\.alreadyInvited/);
});
