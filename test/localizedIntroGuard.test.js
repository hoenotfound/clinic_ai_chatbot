const test = require("node:test");
const assert = require("node:assert/strict");
const {
  missingProtectedIntroFacts,
  preserveOriginalIntroFacts,
} = require("../src/utils/localizedIntroGuard");

test("approved local-language reply preserves offer identifiers without duplicate source", () => {
  const intro = "欢迎 Neutro Sense！3D first trial RM 488，WhatsApp +60 11-2345 6789。";
  const reply = "Welcome to Neutro Sense! 3D first trial RM488. WhatsApp +601123456789.";
  assert.deepEqual(missingProtectedIntroFacts(intro, reply), []);
  assert.deepEqual(preserveOriginalIntroFacts(intro, reply), {
    reply, usedOriginalFallback: false, missingCount: 0,
  });
});

test("omitted pricing, clinic phone or URL falls back to the full original intro", () => {
  const intro = "Neutro Sense 骨盆体验 RM388 + 免费经络按摩。预约 +60 11-3456 7890 https://clinic.example/book";
  const reply = "Welcome to Neutro Sense. We offer a pelvic trial, including a massage.";
  const result = preserveOriginalIntroFacts(intro, reply);
  assert.equal(result.usedOriginalFallback, true);
  assert.ok(result.missingCount >= 3);
  assert.ok(result.reply.includes(reply));
  assert.ok(result.reply.includes(intro));
  assert.equal(result.reply.match(/Original clinic introduction:/g)?.length, 1);
});

test("short introductions without immutable facts do not force untranslated content", () => {
  assert.deepEqual(preserveOriginalIntroFacts("您好，欢迎来到诊所", "Hello, welcome to our clinic!"), {
    reply: "Hello, welcome to our clinic!",
    usedOriginalFallback: false,
    missingCount: 0,
  });
});

test("preservation uses normalized spacing for prices and service codes", () => {
  const intro = "9D Treatment RM 888 - 20% off";
  const reply = "9D treatment RM888 with 20 % off";
  assert.deepEqual(missingProtectedIntroFacts(intro, reply), []);
});


test("free meridian massage must survive English translation even if the price survives", () => {
  const intro = "骨盆体验 RM388。免费经络按摩。";
  const missingFree = preserveOriginalIntroFacts(
    intro,
    "Our pelvic trial is RM388, with a free consultation.",
  );
  assert.equal(missingFree.usedOriginalFallback, true);
  assert.ok(missingFree.reply.includes("免费经络按摩"));

  const vagueFreeMassage = preserveOriginalIntroFacts(
    intro,
    "Our pelvic trial is RM388, with a free massage.",
  );
  assert.equal(vagueFreeMassage.usedOriginalFallback, true);
  assert.ok(vagueFreeMassage.reply.includes(intro));
});

test("correct English/BM free meridian translation does not duplicate the original", () => {
  const intro = "欢迎！免费经络按摩。";
  for (const reply of [
    "Welcome! Includes a free meridian massage.",
    "Welcome! Complimentary meridian massage is included.",
    "Selamat datang! Urutan meridian percuma disertakan.",
  ]) {
    assert.deepEqual(missingProtectedIntroFacts(intro, reply), [], reply);
    assert.equal(preserveOriginalIntroFacts(intro, reply).usedOriginalFallback, false, reply);
  }
});

test("free inclusion in a voucher or eligibility clause needs full source fallback", () => {
  const intro = "骨盆体验RM388。免费经络按摩仅限首次体验顾客。";
  const reply = "Pelvic trial RM388, including a free meridian massage.";
  const guarded = preserveOriginalIntroFacts(intro, reply);
  assert.equal(guarded.usedOriginalFallback, true);
  assert.ok(guarded.reply.includes("仅限首次体验顾客"));
});

test("missing voucher promise triggers source fallback even if money amount was copied", () => {
  const intro = "欢迎来到 Neutro Sense！送您RM100优惠券。";
  const reply = "Welcome to Neutro Sense. RM100 special value.";
  const guarded = preserveOriginalIntroFacts(intro, reply);
  assert.equal(guarded.usedOriginalFallback, true);
  assert.ok(guarded.reply.includes("优惠券"));
});

test("unknown complimentary service defaults to original offer, not an unsupported translation guess", () => {
  const intro = "首次体验赠送免费肩颈按摩";
  const reply = "Your first trial includes a free facial.";
  assert.equal(preserveOriginalIntroFacts(intro, reply).usedOriginalFallback, true);
});

test("non-promotional greetings remain concise without untranslated source", () => {
  assert.equal(preserveOriginalIntroFacts("你好，欢迎来到我们的诊所。", "Hello, welcome to our clinic.").usedOriginalFallback, false);
});


test("first-trial free meridian eligibility cannot disappear from localized greeting", () => {
  for (const intro of [
    "首次体验赠送免费经络按摩",
    "第一次来店附送免费经络按摩",
    "新顾客赠送免费经络按摩",
    "初次体验免费经络按摩",
    "新客免费经络按摩",
  ]) {
    const missingCondition = preserveOriginalIntroFacts(intro, "Includes a free meridian massage.");
    assert.equal(missingCondition.usedOriginalFallback, true, intro);
    assert.ok(missingCondition.reply.includes(intro), intro);
  }
});

test("verified first-trial and new-customer offers avoid unnecessary source duplication", () => {
  const examples = [
    ["首次体验赠送免费经络按摩", "First trial customers receive a free meridian massage."],
    ["新顾客赠送免费经络按摩", "New customers receive a complimentary meridian massage."],
    ["首次体验赠送免费经络按摩", "Pelanggan yang mencuba rawatan kali pertama mendapat urutan meridian percuma."],
  ];
  for (const [intro, reply] of examples) {
    assert.deepEqual(missingProtectedIntroFacts(intro, reply), [], reply);
    assert.equal(preserveOriginalIntroFacts(intro, reply).usedOriginalFallback, false, reply);
  }
});

test("negative or paid meridian claims are rejected rather than delivered alongside original", () => {
  const intro = "免费经络按摩";
  for (const reply of [
    "A free meridian massage is not included.",
    "We don't include a free meridian massage.",
    "Sorry, free meridian massage is unavailable.",
    "You must pay extra for a free meridian massage.",
    "Free meridian massage requires additional payment.",
    "The meridian massage is not free.",
    "没有免费经络按摩。",
    "Urutan meridian percuma tidak termasuk.",
  ]) {
    const guarded = preserveOriginalIntroFacts(intro, reply);
    assert.equal(guarded.usedOriginalFallback, true, reply);
    assert.equal(guarded.reply, intro, reply);
    assert.ok(guarded.missingCount >= 1, reply);
  }
});

test("negative statement elsewhere does not prevent a valid affirmative inclusion", () => {
  const intro = "欢迎！免费经络按摩。";
  const reply = "Welcome! Includes a free meridian massage. No extra charge for consultation.";
  assert.equal(preserveOriginalIntroFacts(intro, reply).usedOriginalFallback, false);
});

test("free meridian in a separate sentence does not validate first-trial eligibility", () => {
  const intro = "首次体验。免费经络按摩。";
  const reply = "You can book a first trial. Free meridian massage is included.";
  const guarded = preserveOriginalIntroFacts(intro, reply);
  assert.equal(guarded.usedOriginalFallback, true);
  assert.ok(guarded.reply.includes(intro));
});
