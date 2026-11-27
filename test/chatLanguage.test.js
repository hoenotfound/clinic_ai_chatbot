const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectMessageLanguage,
  detectConversationLanguage,
  detectReplyConversationLanguage,
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
  for (const text of ["English", "English please", "In English please", "In English pls", "Please in English", "Hi, English", "Please reply in English"]) {
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


test("short price/location questions keep an established Chinese or Malay reply language", () => {
  assert.equal(detectConversationLanguage([
    "price ?", "location ?", "Hi～想了解 3D 小颜术",
  ]), "zh");
  assert.equal(detectConversationLanguage([
    "price ?", "Saya nak tahu pasal rawatan ini",
  ]), "ms");
  assert.equal(detectConversationLanguage(["price ?"]), "en");
  assert.equal(detectConversationLanguage([
    "Please reply in English", "想了解 9D 护理",
  ]), "en");
  assert.equal(detectReplyConversationLanguage([
    "In English please", "Hi～我对黄金脉冲技术有兴趣",
  ]), "en");
  assert.equal(detectConversationLanguage([
    "How much is the current price?", "想了解 9D 护理",
  ]), "en");
});

test("English or Malay questions with Chinese treatment names use the customer's sentence", () => {
  assert.equal(detectMessageLanguage("How much for 骨盆调理?"), "en");
  assert.equal(detectMessageLanguage("Can I book 3D小颜术 tomorrow?"), "en");
  assert.equal(detectMessageLanguage("Interested in 骨盆调理"), "en");
  assert.equal(detectMessageLanguage("骨盆调理 available tomorrow?"), "en");
  assert.equal(detectMessageLanguage("Nak tahu 骨盆调理"), "ms");
  assert.equal(detectMessageLanguage("Is 9D逆龄疗程 available?"), "en");
  assert.equal(detectMessageLanguage("We want to try 9D逆龄"), "en");
  assert.equal(detectMessageLanguage("Saya nak tahu 骨盆调理"), "ms");
  assert.equal(detectMessageLanguage("我想了解3D小颜术 price?"), "zh");
  assert.equal(detectMessageLanguage("可以介绍 9D逆龄 package 吗？"), "zh");
  // Ambiguous shorthand uses prior customer language, not a named treatment.
  assert.equal(detectMessageLanguage("骨盆调理 price?"), null);
  assert.equal(detectReplyConversationLanguage(["骨盆调理 price?", "How much for 骨盆调理?"]), "en");
  assert.equal(detectReplyConversationLanguage(["骨盆调理 price?", "我想了解骨盆调理"]), "zh");
});

test("Hor Yen appointment conversation stays English despite Chinese AI replies", () => {
  const customerOnlyLatestFirst = [
    "ok sure thanks",
    "ok no problem",
    "10am ok",
    "Morning dear. If morning ok?",
    "Period heavy flow",
  ];
  assert.equal(detectReplyConversationLanguage(customerOnlyLatestFirst), "en");
  assert.equal(detectReplyConversationLanguage(["10am ok", "Morning dear. If morning ok?"]), "en");
  assert.equal(detectReplyConversationLanguage(["ok ya", "Saya nak tanya harga"]), "ms");
});

test("legacy follow-up language stays Chinese for Chinese service-name shorthand", () => {
  assert.equal(detectConversationLanguage(["3D 小颜术 / 9D 逆龄抗衰 price?"]), "zh");
  assert.equal(detectConversationLanguage(["Package A 跟 Package B 有什么分别？"]), "zh");
  assert.equal(detectReplyConversationLanguage(["How much for 骨盆调理?"]), "en");
});

test("AI replies and follow-ups use the same customer-language evidence", () => {
  for (const customerTurns of [
    ["Interested in 骨盆调理"],
    ["骨盆调理 available tomorrow?"],
    ["How much for 骨盆调理?", "I want to book"],
    ["骨盆调理 price?", "Morning dear, what is the cost?"],
    ["nak tahu 骨盆调理"],
    ["我想了解骨盆调理", "好的"],
    ["3D 小颜术 / 9D 逆龄抗衰 price?"],
    ["Package A 跟 Package B 有什么分别？"],
  ]) {
    assert.equal(detectReplyConversationLanguage(customerTurns),
      detectConversationLanguage(customerTurns), JSON.stringify(customerTurns));
  }
  assert.equal(detectConversationLanguage(["Interested in 骨盆调理"]), "en");
  assert.equal(detectConversationLanguage(["骨盆调理 available tomorrow?"]), "en");
  assert.equal(detectConversationLanguage(["骨盆调理 price?", "Morning dear"]), "en");
  assert.equal(detectConversationLanguage(["骨盆调理 price?"]), "zh",
    "ambiguous name-only shorthand defaults to its existing Chinese template");
});

test("contextual language information requests are substantive and select the requested locale", () => {
  const variants = {
    en: ["English Info pls", "English information please", "Hi, English details please", "Can explain in English?", "Could you explain this in English?", "Send me the information in English please", "请用英文介绍一下"],
    ms: ["Malay info pls", "BM details please", "Bahasa Malaysia explanation", "Can explain in Malay?", "Boleh terangkan dalam Bahasa Malaysia?", "请用马来文介绍"],
    zh: ["Mandarin info pls", "Chinese information please", "Can you explain in Mandarin?", "请用中文解释一下", "中文资料"],
  };
  for (const [language, messages] of Object.entries(variants)) {
    for (const message of messages) {
      assert.equal(detectExplicitLanguagePreference(message), language, message);
      assert.equal(detectMessageLanguage(message), language, message);
      assert.equal(isGreetingOrLanguageOnly(message), false, message);
      assert.equal(detectReplyConversationLanguage([message, "我想了解骨盆调理"]), language, message);
      assert.equal(detectConversationLanguage(["price?", "ok", message, "我想了解骨盆调理"]), language, message);
    }
  }
  for (const message of ["English price list", "English version of the price list", "My English is not good", "I studied in English"]) {
    assert.equal(detectExplicitLanguagePreference(message), null, message);
  }
  assert.equal(detectConversationLanguage(["English Info pls", "我想了解骨盆调理"]), "en");
  assert.equal(detectConversationLanguage(["中文", "English Info pls", "我想了解骨盆调理"]), "zh");
  assert.equal(isGreetingOrLanguageOnly("English please"), true);
  assert.equal(shouldGenerateLocalizedIntro("English Info pls", "你好，欢迎来到 Neutro Sense"), true);
});

test("contextual language requests tolerate emoji and named treatment", () => {
  for (const text of ["English info pls 😊","English info for pelvis pls","可以用英文介绍骨盆吗？","Information in English please","English details about pelvic adjustment"]) {
    assert.equal(detectExplicitLanguagePreference(text),"en",text);
    assert.equal(isGreetingOrLanguageOnly(text),false,text);
  }
  assert.equal(detectExplicitLanguagePreference("My English teacher"),null);
  assert.equal(detectExplicitLanguagePreference("English price list"),null);
});
test("saved preference survives the history limit and newer explicit requests win", () => {
  const old=Array(25).fill("price?");
  assert.equal(detectReplyConversationLanguage(old,"zh","en"),"en");
  assert.equal(detectConversationLanguage(old,"zh","ms"),"ms");
  assert.equal(detectConversationLanguage(["中文资料",...old],"en","ms"),"zh");
});
