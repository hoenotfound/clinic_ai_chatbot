const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectMessageLanguage,
  detectConversationLanguage,
  detectExplicitLanguagePreference,
  isGreetingOrLanguageOnly,
  shouldGenerateLocalizedIntro,
} = require("../src/utils/chatLanguage");

test("detects English, Bahasa Malaysia, and Chinese customer messages", () => {
  assert.equal(detectMessageLanguage("How much is this treatment?"), "en");
  assert.equal(detectMessageLanguage("Boleh tahu berapa harga rawatan ini?"), "ms");
  assert.equal(detectMessageLanguage("Price berapa?"), "ms");
  assert.equal(detectMessageLanguage("Berkesan ke?"), "ms");
  assert.equal(detectMessageLanguage("请问这个疗程多少钱？"), "zh");
});

test("does not mistake Malaysian-English ya for Bahasa Malaysia", () => {
  assert.equal(
    detectMessageLanguage("Busy now. Will msg you after ya"),
    "en"
  );
  assert.equal(detectMessageLanguage("Can later ya"), "en");
  assert.equal(detectMessageLanguage("ok ya"), null);
  assert.equal(detectMessageLanguage("Saya busy now ya"), "ms");

  // Real Malay signals still win in code-mixed messages.
  assert.equal(detectMessageLanguage("Price berapa?"), "ms");
  assert.equal(detectMessageLanguage("Nak tahu harga ya"), "ms");
});

test("an ambiguous ya-only reply inherits earlier conversation language", () => {
  assert.equal(
    detectConversationLanguage(["ok ya", "How much is this treatment?"]),
    "en"
  );
  assert.equal(
    detectConversationLanguage(["ok ya", "Boleh tahu berapa harga rawatan ini?"]),
    "ms"
  );
});

test("uses an earlier meaningful message when the newest reply is ambiguous", () => {
  assert.equal(
    detectConversationLanguage(["ok", "Saya nak tanya harga rawatan ini"]),
    "ms"
  );
});

test("falls back to English when no recent message reveals a language", () => {
  assert.equal(detectConversationLanguage(["👍", "ok"]), "en");
});


test("language-only requests take priority over configured greeting language", () => {
  const intro = "Hi 你好 👋 欢迎来到 Neutro Sense TCM~";
  for (const text of ["English", "English please", "Hi, English", "Please reply in English"]) {
    assert.equal(detectMessageLanguage(text), "en");
    assert.equal(isGreetingOrLanguageOnly(text), true);
    assert.equal(shouldGenerateLocalizedIntro(text, intro), true);
  }
  for (const text of ["BM", "Bahasa Melayu", "Hai, Bahasa Malaysia"]) {
    assert.equal(detectMessageLanguage(text), "ms");
    assert.equal(shouldGenerateLocalizedIntro(text, intro), true);
  }
  assert.equal(detectMessageLanguage("中文"), "zh");
  assert.equal(shouldGenerateLocalizedIntro("中文", intro), false);
  assert.equal(shouldGenerateLocalizedIntro("How much?", "Hi 你好 欢迎来到 Neutro Sense"), true);
  assert.equal(shouldGenerateLocalizedIntro("English", "Hi, welcome to Neutro Sense"), false);
});

test("a language request with a real treatment enquiry still permits enquiry logic", () => {
  assert.equal(detectMessageLanguage("Please reply in English. 骨盆调理 price?"), "en");
  assert.equal(isGreetingOrLanguageOnly("English price?"), false);
  assert.equal(detectMessageLanguage("English please, 骨盆调理 price?"), "en");
  assert.equal(isGreetingOrLanguageOnly("English please, 骨盆调理 price?"), false);
  assert.equal(isGreetingOrLanguageOnly("Please reply in English. 骨盆调理 price?"), false);
  assert.equal(isGreetingOrLanguageOnly("Hi, how much for 骨盆调理?"), false);
  assert.equal(isGreetingOrLanguageOnly("BM, what are your prices?"), false);
  assert.equal(isGreetingOrLanguageOnly("Hello"), true);
  assert.equal(isGreetingOrLanguageOnly("你好"), true);
  assert.equal(detectExplicitLanguagePreference("English price list"), null);
});
