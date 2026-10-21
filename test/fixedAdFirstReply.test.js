"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isStandardAdPrefill, resolveFixedAdFirstReply } =
  require("../src/utils/fixedAdFirstReply");
const { resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");

const services = [
  { name: "骨盆调理" },
  { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" },
];
const aliases = [
  { alias: "骨盆,盆骨,pelvic", officialService: "骨盆调理" },
  { alias: "3D,小颜", officialService: "3D 小颜术" },
  { alias: "9D,逆龄", officialService: "9D 逆龄抗衰" },
];
const translations = { zh: "Hi～欢迎了解骨盆调理 😊 你最想改善哪方面呢？", en: "Hi! How can we help with pelvic care?", ms: "Hai! Apa yang anda ingin tahu?" };
const config = { enabled: true, replies: [{ service: "骨盆调理", translations }] };
const now = Date.parse("2026-10-21T08:00:00Z");
const ad = { serviceHint: "骨盆调理", serviceHintSource: "creative", attributedAt: new Date(now - 60_000).toISOString() };

function attempt(overrides = {}) {
  return resolveFixedAdFirstReply({
    config, isFirstMessage: true,
    conversationHistory: [{ role: "user", content: "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看" }],
    customerText: "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看",
    language: "zh", metaAdContext: ad,
    metaAdCreativeService: "骨盆调理",
    services, serviceAliases: aliases, now, ...overrides,
  });
}

test("bypasses AI for recognised Chinese opt-in prefill without treating future discounts as a price request", () => {
  const match = attempt();
  assert.ok(match);
  assert.equal(match.reply, translations.zh);
  assert.equal(match.treatment, "骨盆调理");
  assert.equal(match.serviceQuery, true);
  assert.equal(match.serviceQuerySource, "customer_message");
});

test("contextual Meta enquiry uses independently verified ad creative", () => {
  const result = attempt({
    customerText: "Hi, I'd like to know more about this",
    conversationHistory: [{ role: "user", content: "Hi, I'd like to know more about this" }],
    language: "en",
  });
  assert.equal(result?.reply, translations.en);
  assert.equal(result?.serviceQuerySource, "meta_ad");
});

test("requires enabled, recent and unambiguous configured Meta-ad treatment", () => {
  assert.equal(attempt({ config: { ...config, enabled: false } }), null);
  assert.equal(attempt({ metaAdContext: null }), null);
  assert.equal(attempt({ metaAdContext: { ...ad, attributedAt: null } }), null);
  assert.equal(attempt({ metaAdContext: { ...ad, attributedAt: new Date(now - 8 * 86400_000).toISOString() } }), null);
  assert.equal(attempt({ metaAdContext: { ...ad, serviceHint: "3D 小颜术" } }), null);
  assert.equal(attempt({ metaAdCreativeService: "3D 小颜术" }), null);
  assert.equal(attempt({ metaAdCreativeService: null, customerText: "Hi, I'm interested in this" }), null,
    "a generic enquiry must not use treatment guessed from ad name");
  const adNameOnly = { ...ad, serviceHintSource: "ad_name" };
  assert.equal(attempt({ metaAdContext: adNameOnly, metaAdCreativeService: null })?.reply, config.replies[0].translations.zh,
    "explicit named treatment may safely match an ad-name-only service when no creative conflicts");
  assert.equal(attempt({ config: { enabled: true, replies: [] } }), null);
  assert.equal(attempt({ config: { enabled: true, replies: [config.replies[0], config.replies[0]] } }), null);
  const misses = [];
  assert.equal(attempt({ metaAdCreativeService: null, customerText: "Hi, I'm interested in this", onSkip: reason => misses.push(reason) }), null);
  assert.deepEqual(misses, ["generic_enquiry_without_verified_creative"]);
});

test("fails to AI on current price, appointment, clinical, service-switch or non-prefill questions", () => {
  for (const customerText of [
    "Hi, 骨盆调理多少钱？",
    "我对骨盆调理有兴趣，请问RM388还有吗？",
    "骨盆调理是怎么做的？",
    "我怀孕了可以做骨盆吗？",
    "我想预约明天下午做骨盆",
    "我对3D小颜术有兴趣",
    "我对骨盆调理有兴趣，可是我很痛，需要医生吗？",
    "stop promotions",
  ]) {
    assert.equal(attempt({ customerText }), null, customerText);
  }
});

test("only applies to a true first inbound turn, never to reopened or staff conversations", () => {
  assert.equal(attempt({ isFirstMessage: false }), null);
  assert.equal(attempt({ conversationHistory: [{ role: "user" }, { role: "assistant" }] }), null);
  assert.equal(attempt({ conversationHistory: [{ role: "assistant" }] }), null);
  assert.equal(attempt({ keywordReason: "complaint" }), null);
  assert.equal(attempt({ hasStaffHandoff: true }), null);
  assert.equal(attempt({ hasExistingBooking: true }), null);
  assert.equal(attempt({ isTextMessage: false }), null);
  assert.equal(attempt({ isFirstMessage: false, conversationHistory: [{role: "user"}] }), null,
    "filtered AI history is not sufficient to claim this is a first message");
});

test("uses exactly the customer's language and respects staff-configured copy", () => {
  assert.equal(attempt({ language: "ms-MY" })?.reply, translations.ms);
  assert.equal(attempt({ language: "en" })?.reply, translations.en);
  const untranslated = { enabled: true, replies: [{ service: "骨盆调理", translations: { ...translations, ms: "" } }] };
  assert.equal(attempt({ config: untranslated, language: "ms" }), null);
  const priceText = { enabled: true, replies: [{ service: "骨盆调理", translations: { ...translations, zh: "骨盆特价 RM388" } }] };
  assert.equal(attempt({ config: priceText })?.reply, "骨盆特价 RM388");
});

test("prefill recogniser does not absorb edited or compound customer questions", () => {
  assert.equal(isStandardAdPrefill("我对9D逆龄抗衰有兴趣，可以跟进我，有优惠也发我看看"), true);
  assert.equal(isStandardAdPrefill("Hi, I'm interested in this"), true);
  assert.equal(isStandardAdPrefill("I am interested in 3D 小颜术"), true);
  assert.equal(isStandardAdPrefill("I'm interested in 9D and want to know the process"), false);
  assert.equal(isStandardAdPrefill("Saya berminat dengan 9D dan nak tahu cara rawatan"), false);
  assert.equal(isStandardAdPrefill("Saya nak tahu tentang 9D"), true);
  assert.equal(isStandardAdPrefill("Saya berminat dengan 9D"), true);
  assert.equal(isStandardAdPrefill("I am interested in 9D"), true);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣，不过要多少钱？"), false);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣\n我要退款"), false);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣，医生讲我有问题"), false);
  assert.equal(isStandardAdPrefill("我想了解骨盆调理大概几次能见效"), false);
  assert.equal(isStandardAdPrefill("I am interested in pelvic treatment but how long does it take"), false);
  assert.equal(isStandardAdPrefill("I am interested in 9D tomorrow at 3pm"), false);
  assert.equal(isStandardAdPrefill("I am interested in 9D at 3"), false);
  assert.equal(isStandardAdPrefill("I am interested in 9D next weekend"), false);
  assert.equal(isStandardAdPrefill("Saya berminat dengan 9D esok petang"), false);
  assert.equal(isStandardAdPrefill("Saya berminat dengan 9D pukul 3"), false);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣，明天可以预约吗"), false);
  assert.equal(isStandardAdPrefill("我对9D有兴趣，下午3点有位吗"), false);
  assert.equal(isStandardAdPrefill("I am interested in 3D 小颜术"), true);
});

test("handler selects fixed reply before model and skips configured introductory duplication", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const first = source.indexOf("fixedAdFirstReply = !keywordReason");
  const bypass = source.indexOf("} else if (fixedAdFirstReply)");
  const model = source.indexOf("const rawAiReply = await ai.getReply");
  assert.ok(first > 0 && bypass > first && model > bypass);
  assert.match(source, /!generateFirstIntro && !fixedAdFirstReply/);
  assert.match(source, /generateFirstIntro && !fixedAdFirstReply/);
  assert.match(source, /serviceQuerySource = fixedAdFirstReply.serviceQuerySource/);
  assert.match(source, /isFirstMessage: wasFirstMessage === true/);
  assert.match(source, /assessmentFirstPricingEnabled === true &&\s*!fixedAdFirstReply/);
});

test("actual server decision branch skips Gemini for valid first ad message and falls back for custom questions", async () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const begin = server.indexOf("      fixedAdFirstReply = !keywordReason");
  const end = server.indexOf("      // A model can miss a clear complaint", begin);
  assert.ok(begin > 0 && end > begin, "actual decision branch must be found");
  const source = server.slice(begin, end);
  let aiCalls = 0;
  const logs = [];
  const runtime = vm.runInNewContext(`(async function runCase(options) {
    const text = options.text;
    const wasFirstMessage = options.wasFirstMessage;
    const history = [{ role: "user", content: text }];
    const replyHistory = history;
    const isFirstMessage = history.length === 1;
    const generateFirstIntro = false;
    const mediaLanguage = options.language || "zh";
    const metaAdContext = options.metaAdContext;
    const metaAdCreativeService = options.metaAdCreativeService;
    const mediaType = options.mediaType || null;
    const bookingContext = options.bookingContext || null;
    const channel = "whatsapp";
    const contact = { id: 7 };
    const savedInbound = { id: 100 };
    const keywordReason = null;
    const marketingStopQuestion = null;
    const numberedPricingSelection = null;
    let fixedAdFirstReply = null;
    let aiReply = null;
    let serviceQuery = false, serviceQuerySource = null;
    let details = null, flagged = false, reviewRequired = false, reviewType = null;
    let bookingReady = false, priceQuery = false, packageQuery = false;
    ${source}
    return { aiReply, details, serviceQuery, serviceQuerySource, fixedAdFirstReply };
  })`, {
    resolveFixedAdFirstReply,
    clinicConfig: { adFirstReply: config, services, serviceAliases: aliases },
    ai: { getReply: async () => { aiCalls++; return { text: "MODEL ANSWER" }; } },
    parseAiReplyResult: raw => raw,
    console: { info: (...parts) => logs.push(parts.join(" ")) },
  });
  const optIn = "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看";
  const fixed = await runtime({ text: optIn, wasFirstMessage: true, metaAdContext: ad, metaAdCreativeService: "骨盆调理" });
  assert.equal(fixed.aiReply, translations.zh);
  assert.equal(fixed.details.treatment, "骨盆调理");
  assert.equal(fixed.serviceQuery, true);
  assert.equal(aiCalls, 0, "Gemini not called for recognised fresh ad enquiry");
  assert.ok(logs.some(item => item.includes("treatment=骨盆调理")));

  const custom = await runtime({ text: "Hi, I'm interested in 骨盆调理 tomorrow at 3pm", wasFirstMessage: true, metaAdContext: ad, metaAdCreativeService: "骨盆调理" });
  assert.equal(custom.aiReply, "MODEL ANSWER");
  assert.equal(aiCalls, 1, "custom timing request uses AI");
  const historical = await runtime({ text: optIn, wasFirstMessage: false, metaAdContext: ad, metaAdCreativeService: "骨盆调理" });
  assert.equal(historical.aiReply, "MODEL ANSWER");
  assert.equal(aiCalls, 2, "a one-item filtered model history cannot bypass durable first-message evidence");
  const genericNameOnly = await runtime({ text: "Hi, I'd like to know more about this", language: "en", wasFirstMessage: true, metaAdContext: { ...ad, serviceHintSource: "ad_name" }, metaAdCreativeService: null });
  assert.equal(genericNameOnly.aiReply, "MODEL ANSWER");
  assert.equal(aiCalls, 3, "generic enquiry with ad-name-only hint requires AI");
  const genericCreative = await runtime({ text: "Hi, I'd like to know more about this", language: "en", wasFirstMessage: true, metaAdContext: ad, metaAdCreativeService: "骨盆调理" });
  assert.equal(genericCreative.aiReply, translations.en);
  assert.equal(aiCalls, 3, "verified generic creative saves a model call");
});

test("verified fixed-reply intent remains eligible for independently guarded Before & After media", async () => {
  const optIn = "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看";
  const resultMedia = [{
    service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
    autoSendCount: 1, items: [{
      imageUrl: "https://example.test/result.jpg",
      caption: "骨盆调理对比参考",
    }],
  }];
  const runSelector = (fixed, customerText, extra = {}) =>
    resolveResultMediaForReply({
      serviceQuery: fixed.serviceQuery,
      serviceQuerySource: fixed.serviceQuerySource,
      treatment: fixed.treatment,
      customerText,
      priorCustomerTexts: [],
      metaAdCreativeService: "骨盆调理",
      priceQuery: false, packageQuery: false, flagged: false,
      bookingReady: false, keywordReason: null, needsAttention: false,
      textSendSucceeded: true,
      resultMedia, services, serviceAliases: aliases, language: "zh",
      contactId: 7,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
      ...extra,
    });
  const fixed = attempt();
  assert.equal(fixed?.serviceQuery, true);
  const bundle = await runSelector(fixed, optIn);
  assert.equal(bundle?.service, "骨盆调理");
  assert.equal(bundle?.items.length, 1);
  assert.equal(bundle?.items[0].imageUrl, "https://example.test/result.jpg");

  const genericText = "Hi, I'd like to know more about this";
  const generic = attempt({
    customerText: genericText,
    conversationHistory: [{ role: "user", content: genericText }],
    language: "en",
  });
  assert.equal(generic?.serviceQuerySource, "meta_ad");
  assert.equal((await runSelector(generic, genericText))?.service, "骨盆调理");
  assert.equal((await runSelector(generic, genericText, { metaAdCreativeService: null })), null,
    "missing verified creative must never enable generic ad images");
  assert.equal((await runSelector(fixed, optIn, { textSendSucceeded: false })), null,
    "provider rejection must still prevent media");
});
