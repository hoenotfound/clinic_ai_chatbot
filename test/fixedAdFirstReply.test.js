"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isStandardAdPrefill, resolveFixedAdFirstReply } =
  require("../src/utils/fixedAdFirstReply");

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
  assert.equal(attempt({ config: { enabled: true, replies: [] } }), null);
  assert.equal(attempt({ config: { enabled: true, replies: [config.replies[0], config.replies[0]] } }), null);
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
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣，不过要多少钱？"), false);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣\n我要退款"), false);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣，医生讲我有问题"), false);
  assert.equal(isStandardAdPrefill("我想了解骨盆调理大概几次能见效"), false);
  assert.equal(isStandardAdPrefill("I am interested in pelvic treatment but how long does it take"), false);
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
});
