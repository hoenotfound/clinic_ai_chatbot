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
