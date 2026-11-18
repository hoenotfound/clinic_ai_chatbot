"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isStandardAdPrefill, resolveFixedAdFirstReply } =
  require("../src/utils/fixedAdFirstReply");
const { resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");
const { prepareConfigUpdatePayload } = require("../src/routes/config");

const services = [
  { name: "骨盆调理" },
  { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" },
];
const aliases = [
  { alias: "骨盆,盆骨,pelvic", officialService: "骨盆调理" },
  { alias: "3D,小颜", officialService: "3D 小颜术" },
  { alias: "9D,逆龄", officialService: "9D 逆龄抗衰" },
  { alias: "3D小颜术", officialService: "3D 小颜术" },
  { alias: "9D护理,9D脸部提升", officialService: "9D 逆龄抗衰" },
];
const configuredPrefill = (value) => isStandardAdPrefill(value, {
  services, serviceAliases: aliases, businessName: "Neutro Sense TCM Centre",
});
const translations = { zh: "Hi～欢迎了解骨盆调理 😊 你最想改善哪方面呢？", en: "Hi! How can we help with pelvic care?", ms: "Hai! Apa yang anda ingin tahu?" };
const config = { enabled: true, replies: [{ service: "骨盆调理", translations }] };
const now = Date.parse("2026-10-21T08:00:00Z");
const ad = { serviceHint: "骨盆调理", serviceHintSource: "creative", headline: "骨盆调理", attributedAt: new Date(now - 60_000).toISOString() };

function attempt(overrides = {}) {
  return resolveFixedAdFirstReply({
    config, isFirstMessage: true,
    conversationHistory: [{ role: "user", content: "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看" }],
    customerText: "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看",
    language: "zh", metaAdContext: ad,
    metaAdCreativeService: "骨盆调理",
    services, serviceAliases: aliases, businessName: "Neutro Sense TCM Centre",
    now, ...overrides,
  });
}

test("Neutro RM68 breast campaign sends exact first reply without changing treatment-wide scripts", () => {
  const customerText = "你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？";
  const campaignNow = Date.parse("2026-11-14T14:00:00Z");
  const campaignAd = {
    headline: "胸部专业检查 RM68体验优惠",
    body: "胸部健康评估 + 脉冲波护理 12月5日与6日",
    attributedAt: new Date(campaignNow - 60_000).toISOString(),
  };
  const expected = [
    "您好💕 欢迎咨询 Neutro Sense TCM！",
    "",
    "我们目前推出【胸部专业检查 + 脉冲波疏通乳腺护理】限时体验优惠 🌸",
    "",
    "✨ 首次体验只需 RM68（原价以门店公告为准）",
    "📅 活动日期：12月5日 & 6日",
    "⏰ RM68胸部护理约45分钟；加上赠送护理，全程约 1小时30分钟",
    "🎁 免费赠送艾灸护理",
    "",
    "护理包含：",
    "✅ 专业胸部健康评估",
    "✅ 脉冲波舒缓护理，帮助放松胸部周围组织",
    "✅ 胸部日常护理建议",
    "",
    "💗 具体名额需要由门店确认，建议提前预约哦！",
    "",
    "请问您比较方便 12月5日（星期六）还是12月6日（星期日） 呢？😊",
  ].join("\n");
  const run = (overrides = {}) => attempt({
    customerText, conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: campaignAd, metaAdCreativeService: null,
    now: campaignNow, ...overrides,
  });
  const fixed = run();
  assert.equal(fixed?.reply, expected);
  assert.equal(fixed?.campaignKey, "neutro_breast_rm68_2026");
  assert.equal(fixed?.serviceQuery, false, "mixed treatment ad cannot enable wrong results media");
  assert.equal(fixed?.treatment, null);
  assert.equal(run({ metaAdContext: null }), null, "organic copy/paste is not a proven Meta ad");
  assert.equal(run({ config: { ...config, enabled: false } }), null);
  assert.equal(run({ businessName: "Other Clinic" }), null);
  assert.equal(run({ isFirstMessage: false }), null);
  assert.equal(run({ isTextMessage: false }), null);
  assert.equal(run({ hasExistingBooking: true }), null);
  assert.equal(run({ hasStaffHandoff: true }), null);
  assert.equal(run({ keywordReason: "urgent" }), null);
  assert.equal(run({ conversationHistory: [
    { role: "user", content: "Hi" }, { role: "user", content: customerText },
  ] }), null, "do not repeat the campaign greeting mid-conversation");
  assert.equal(run({ metaAdContext: {
    ...campaignAd,
    attributedAt: new Date(campaignNow - 8 * 86400000).toISOString(),
  } }), null, "stale attribution cannot enable the campaign");

  for (const edited of [
    customerText + "我有乳房肿块怎么办？",
    customerText + "请问今天可以预约吗？",
    "你好！我想了解【胸部专业检查 RM68体验优惠】",
    "你好！想了解你们家的【黄金脉冲技术】",
  ]) {
    assert.equal(run({
      customerText: edited,
      conversationHistory: [{ role: "user", content: edited }],
    })?.campaignKey, undefined, "other or edited enquiries must not use the campaign: " + edited);
  }
});

test("returning RM68 Meta-ad enquiry uses THIS signed referral instead of old lead attribution", () => {
  const customerText = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
  const campaignNow = Date.parse("2026-11-17T15:10:38Z");
  const currentAdReferral = {
    source: "meta_ads", sourceType: "ad", adId: "verified-ad-789",
    headline: "由 KKM 认证中医师操作",
    body: "Neutro Sense TCM 胸部护理限时体验，只需 RM68！12月5日 & 6日",
  };
  const history = [
    { role: "assistant", content: "7月份的旧聊天记录" },
    { role: "user", content: customerText },
  ];
  const run = (overrides = {}) => attempt({
    isFirstMessage: false, conversationHistory: history,
    customerText, now: campaignNow, metaAdContext: null,
    metaAdCreativeService: null, currentAdReferral, ...overrides,
  });
  assert.equal(run()?.campaignKey, "neutro_breast_rm68_2026");
  assert.match(run()?.reply || "", /首次体验只需 RM68/);
  assert.match(run()?.reply || "", /具体名额需要由门店确认/);
  assert.doesNotMatch(run()?.reply || "", /RM388/);
  assert.equal(run()?.serviceQuery, false);
  assert.equal(run()?.treatment, null);
  assert.equal(run({ currentAdReferral: null }), null);
  assert.equal(run({ currentAdReferral: { ...currentAdReferral, adId: null } }), null);
  assert.equal(run({ currentAdReferral: { ...currentAdReferral, source: "direct" } }), null);
  assert.equal(run({ currentAdReferral: { ...currentAdReferral, sourceType: "post" } }), null);
  assert.equal(run({ currentAdReferral: { ...currentAdReferral,
    body: "一般黄金脉冲技术 RM388", headline: "黄金脉冲技术" } }), null);
  assert.equal(run({ currentAdReferral: null, metaAdContext: {
    attributedAt: new Date(campaignNow).toISOString(),
    headline: "胸部护理 RM68",
  } }), null, "old lead ad cannot reopen a returning conversation");
  assert.equal(run({ hasExistingBooking: true }), null);
  assert.equal(run({ hasStaffHandoff: true }), null);
  assert.equal(run({ keywordReason: "complaint" }), null);
  assert.equal(run({ businessName: "Other Clinic" }), null);
  assert.equal(run({ isTextMessage: false }), null);
  assert.equal(run({ conversationHistory: [
    ...history.slice(0, -1), { role: "user", content: "不同的消息" },
  ] }), null);
  const edited = customerText + " 我怀孕了可以做吗？";
  assert.equal(run({ customerText: edited, conversationHistory: [
    history[0], { role: "user", content: edited },
  ] }), null, "medical questions must reach the normal clinical path");
  assert.equal(run({ customerText: "Hi～我对骨盆调理有兴趣",
    conversationHistory: [history[0], { role: "user", content: "Hi～我对骨盆调理有兴趣" }],
  }), null, "other treatments never use the returning RM68 exception");
});

test("new Neutro RM68 opt-in-style CTWA prefill preserves campaign intro and guards", () => {
  const customerText = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
  const campaignNow = Date.parse("2026-11-15T01:00:00Z");
  const campaignAd = {
    headline: "胸部专业检查 RM68体验优惠",
    body: "胸部健康评估 + 脉冲波护理 12月5日与6日",
    attributedAt: new Date(campaignNow - 60_000).toISOString(),
  };
  const run = (overrides = {}) => attempt({
    customerText, conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: campaignAd, metaAdCreativeService: null, now: campaignNow,
    ...overrides,
  });
  const first = run();
  assert.equal(first?.campaignKey, "neutro_breast_rm68_2026");
  assert.match(first?.reply || "", /首次体验只需 RM68/);
  assert.match(first?.reply || "", /12月5日 & 6日/);
  assert.doesNotMatch(first?.reply || "", /RM388/);
  assert.equal(first?.treatment, null, "do not confuse RM68 chest with regular Pulse Wave");
  assert.equal(run({ metaAdContext: null }), null);
  assert.equal(run({ metaAdContext: { ...campaignAd,
    headline: "黄金脉冲技术 RM388", body: "一般脉冲波护理" } }), null);
  assert.equal(run({ hasStaffHandoff: true }), null);
  assert.equal(run({ hasExistingBooking: true }), null);
  assert.equal(run({ isFirstMessage: false }), null);
  for (const edited of [
    customerText + " 我怀孕了可以做吗？",
    customerText + " 那今天有位吗？",
  ]) {
    assert.equal(run({ customerText: edited,
      conversationHistory: [{ role: "user", content: edited }] })?.campaignKey,
    undefined, "real edited questions must not be swallowed by an ad script");
  }
});

test("Neutro RM68 reply expires at midnight 7 December Malaysia time", () => {
  const customerText = "你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？";
  const adAt = new Date("2026-12-06T12:00:00Z").toISOString();
  const base = {
    customerText,
    conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: { headline: "胸部专业检查 RM68", attributedAt: adAt },
    metaAdCreativeService: null,
  };
  const active = attempt({ ...base, now: Date.parse("2026-12-06T15:59:59Z") });
  const expired = attempt({ ...base, now: Date.parse("2026-12-06T16:00:00Z") });
  assert.match(active?.reply || "", /首次体验只需 RM68/);
  assert.match(expired?.reply || "", /活动已经结束/);
  assert.doesNotMatch(expired.reply, /首次体验只需 RM68|名额有限/);
  assert.equal(expired.campaignKey, "neutro_breast_rm68_2026");
});

test("Neutro golden pulse ad prefill selects 脉冲波调理 and bypasses Gemini safely", () => {
  const pulseServices = [...services, { name: "脉冲波调理" }];
  const pulseAliases = [
    ...aliases,
    { alias: "黄金脉冲技术", officialService: "脉冲波调理" },
  ];
  const customerText = "你好！想了解你们家的【黄金脉冲技术】";
  const pulseReply = "Hi～欢迎来到 Neutro Sense 😊\\n\\n想了解我们的脉冲波调理对吗～";
  const pulseConfig = { enabled: true, replies: [{
    service: "脉冲波调理",
    translations: { zh: pulseReply, en: "Pulse Wave enquiry", ms: "Pertanyaan Pulse Wave" },
  }] };
  const pulseCreative = {
    attributedAt: ad.attributedAt,
    headline: "黄金脉冲技术",
    body: "黄金脉冲技术介绍",
  };
  const first = attempt({
    config: pulseConfig,
    customerText,
    conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: pulseCreative,
    metaAdCreativeService: "脉冲波调理",
    services: pulseServices,
    serviceAliases: pulseAliases,
  });
  assert.equal(isStandardAdPrefill(customerText, {
    services: pulseServices, serviceAliases: pulseAliases,
  }), true);
  assert.equal(first?.reply, pulseReply);
  assert.equal(first?.treatment, "脉冲波调理");
  assert.equal(first?.serviceQuery, true);
  assert.equal(first?.serviceQuerySource, "customer_message");
  assert.equal(configuredPrefill(customerText), false,
    "unknown alias must not match another treatment");
  assert.equal(attempt({
    config: pulseConfig,
    customerText,
    conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: pulseCreative,
    metaAdCreativeService: "脉冲波调理",
    services: pulseServices,
    serviceAliases: aliases,
  }), null, "without the configured alias the fixed reply is blocked");
  assert.equal(attempt({
    config: pulseConfig,
    customerText,
    conversationHistory: [{ role: "user", content: customerText }],
    metaAdContext: { ...pulseCreative, headline: "9D 逆龄抗衰", body: "9D 护理" },
    metaAdCreativeService: "9D 逆龄抗衰",
    services: pulseServices,
    serviceAliases: pulseAliases,
  }), null, "mismatched creative must not send a pulse script");
});

test("new golden pulse CTWA prefill keeps verified 脉冲波调理 first reply", () => {
  const customerText = "Hi～我对 Neutro Sense TCM 黄金脉冲技术有兴趣，可以跟进我，有优惠也发我看看 😊";
  const pulseServices = [...services, { name: "脉冲波调理" }];
  const pulseAliases = [...aliases, { alias: "黄金脉冲技术", officialService: "脉冲波调理" }];
  const reply = "您好，欢迎了解我们的黄金脉冲技术 😊";
  const first = attempt({
    customerText, conversationHistory: [{ role: "user", content: customerText }],
    services: pulseServices, serviceAliases: pulseAliases,
    config: { enabled: true, replies: [{
      service: "脉冲波调理", translations: { zh: reply },
    }] },
    metaAdContext: { headline: "黄金脉冲技术", body: "黄金脉冲技术介绍",
      attributedAt: ad.attributedAt },
    metaAdCreativeService: "脉冲波调理",
  });
  assert.equal(isStandardAdPrefill(customerText, {
    services: pulseServices, serviceAliases: pulseAliases,
    businessName: "Neutro Sense TCM Centre",
  }), true);
  assert.equal(first?.reply, reply);
  assert.equal(first?.treatment, "脉冲波调理");
  assert.equal(first?.serviceQuery, true);
  const mismatch = attempt({
    customerText, conversationHistory: [{ role: "user", content: customerText }],
    services: pulseServices, serviceAliases: pulseAliases,
    metaAdContext: { headline: "3D 小颜术", body: "3D 小颜术",
      attributedAt: ad.attributedAt }, metaAdCreativeService: "3D 小颜术",
  });
  assert.equal(mismatch, null);
});

test("golden pulse prefill keeps substantive and edited enquiries on AI", () => {
  const pulseServices = [...services, { name: "脉冲波调理" }];
  const pulseAliases = [
    ...aliases,
    { alias: "黄金脉冲技术", officialService: "脉冲波调理" },
  ];
  const exact = "你好！想了解你们家的【黄金脉冲技术】";
  const isPulsePrefill = text => isStandardAdPrefill(text, {
    services: pulseServices, serviceAliases: pulseAliases,
  });
  assert.equal(isPulsePrefill(exact), true);
  assert.equal(isPulsePrefill("你好！想了解你们家【黄金脉冲技术】"), true);
  assert.equal(isPulsePrefill("你好！想了解贵店的【黄金脉冲技术】"), true);
  for (const edited of [
    exact + "多少钱？",
    exact + "可以预约明天吗？",
    exact + "有什么副作用？",
    exact + "和9D有什么不同？",
    exact + "，我怀孕了能做吗？",
    "你好！想了解你们家的【陌生疗程】",
  ]) {
    assert.equal(isPulsePrefill(edited), false, edited);
  }
});

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
  assert.equal(attempt({ metaAdContext: { ...ad, serviceHint: "3D 小颜术" } })?.treatment, "骨盆调理",
    "independently matched creative and explicit customer treatment override a stale service hint");
  assert.equal(attempt({ metaAdCreativeService: "3D 小颜术" }), null);
  assert.equal(attempt({ metaAdCreativeService: null, customerText: "Hi, I'm interested in this" }), null,
    "a generic enquiry must not use treatment guessed from ad name");
  const adNameOnly = { ...ad, headline: null, serviceHintSource: "ad_name" };
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
    "我对骨盆调理不感兴趣",
    "我对骨盆调理没有兴趣",
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
  assert.equal(configuredPrefill("我对9D逆龄抗衰有兴趣，可以跟进我，有优惠也发我看看"), true);
  assert.equal(configuredPrefill("Hi, I'm interested in this"), true);
  assert.equal(configuredPrefill("I am interested in 3D 小颜术"), true);
  assert.equal(configuredPrefill("你好！我想了解你们骨盆的疗程"), true);
  assert.equal(configuredPrefill("Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊"), true);
  assert.equal(configuredPrefill("Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～"), true);
  assert.equal(configuredPrefill("Hi～想了解 Neutro Sense TCM 9D 护理，有后续配套和优惠可以 WhatsApp 发我 😊"), true);
  assert.equal(configuredPrefill("我想了解【3D小颜术】疗程！"), true);
  assert.equal(configuredPrefill("我想了解【9D脸部提升】疗程！"), true);
  assert.equal(configuredPrefill("我想了解骨盆的疗程"), true);
  assert.equal(configuredPrefill("我想了解3D 小颜术护理"), true);
  assert.equal(configuredPrefill("我对骨盆调理有兴趣"), true);
  assert.equal(configuredPrefill("你好！我想了解你们骨盆的疗程"), true);
  assert.equal(configuredPrefill("I'm interested in 9D and want to know the process"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D dan nak tahu cara rawatan"), false);
  assert.equal(configuredPrefill("Saya nak tahu tentang 9D"), true);
  assert.equal(configuredPrefill("Saya berminat dengan 9D"), true);
  assert.equal(configuredPrefill("I am interested in 9D"), true);
  assert.equal(configuredPrefill("I am interested in 9D does it work"), false);
  assert.equal(configuredPrefill("I am interested in 9D is it effective"), false);
  assert.equal(configuredPrefill("I am interested in 9D do you have pictures"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D bagaimana prosesnya"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D saya dah cuba sebelum ni"), false);
  assert.equal(configuredPrefill("我对9D不感兴趣"), false);
  assert.equal(configuredPrefill("我对9D没有兴趣"), false);
  assert.equal(configuredPrefill("我对9D不是很有兴趣"), false);
  assert.equal(configuredPrefill("我对9D没什么兴趣"), false);
  assert.equal(configuredPrefill("I am interested in 9D not really"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D tak jadi"), false);
  assert.equal(configuredPrefill("我对骨盆调理有兴趣，不过要多少钱？"), false);
  for (const edited of [
    "想了解骨盆调理需要准备什么",
    "想了解骨盆调理需要带什么",
    "想了解骨盆调理怎么预约",
    "想了解骨盆调理的地址",
    "想了解骨盆调理有没有效果",
    "想了解骨盆调理的注意事项",
    "想了解骨盆调理适合谁",
    "想了解骨盆调理多久做一次",
    "想了解骨盆调理后的恢复时间",
    "想了解骨盆调理的副作用",
    "想了解骨盆调理需要准备什么，可以跟进我，有优惠也发我看看",
    "Hi～想了解 Neutro Sense TCM 3D 小颜术需要准备什么，可以 WhatsApp 跟进我和发相关优惠～",
    "我对骨盆调理怎么做有兴趣",
    "我对骨盆调理收费有兴趣",
    "我对骨盆调理和9D逆龄抗衰有兴趣",
    "我想了解【3D小颜术】疗程能不能改善大小脸",
    "我想了解没有配置的陌生疗程",
  ]) {
    assert.equal(configuredPrefill(edited), false, edited);
  }
  assert.equal(configuredPrefill("我对骨盆调理有兴趣\n我要退款"), false);
  assert.equal(configuredPrefill("我对骨盆调理有兴趣，医生讲我有问题"), false);
  assert.equal(configuredPrefill("我想了解骨盆调理大概几次能见效"), false);
  assert.equal(configuredPrefill("I am interested in pelvic treatment but how long does it take"), false);
  assert.equal(configuredPrefill("I am interested in 9D tomorrow at 3pm"), false);
  assert.equal(configuredPrefill("I am interested in 9D at 3"), false);
  assert.equal(configuredPrefill("I am interested in 9D next weekend"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D esok petang"), false);
  assert.equal(configuredPrefill("Saya berminat dengan 9D pukul 3"), false);
  assert.equal(configuredPrefill("我对骨盆调理有兴趣，明天可以预约吗"), false);
  assert.equal(configuredPrefill("我对9D有兴趣，下午3点有位吗"), false);
  assert.equal(configuredPrefill("想了解骨盆调理，可以现在发我优惠吗"), false);
  assert.equal(configuredPrefill("Hi～想了解 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠，多少钱"), false);
  assert.equal(configuredPrefill("我想了解骨盆疗程是不是适合怀孕的人"), false);
  assert.equal(configuredPrefill("你好！我想了解骨盆疗程，但是我已经预约明天了"), false);
  assert.equal(configuredPrefill("I am interested in 3D 小颜术"), true);
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
  assert.match(source, /fixedAdFirstReply\?\.campaignKey !== "neutro_breast_rm68_2026"/);
  assert.match(source, /neutro_breast_rm68_campaign_text_only/);
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
    const verifiedFirstReadableAd = options.verifiedFirstReadableAd === true;
    const history = options.history || [{ role: "user", content: text }];
    const incoming = options.incoming || { attribution: null };
    const replyHistory = history;
    const isFirstMessage = history.length === 1;
    const generateFirstIntro = false;
    const mediaLanguage = options.language || "zh";
    const metaAdContext = options.metaAdContext;
    const metaAdCreativeService = options.metaAdCreativeService;
    const mediaType = options.mediaType || null;
    const bookingContext = options.bookingContext || null;
    const acceptedStaffOffer = options.acceptedStaffOffer || null;
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
    // Pin the synthetic attribution clock so this test does not expire after 7 real days.
    resolveFixedAdFirstReply: options => resolveFixedAdFirstReply({ ...options, now }),
    clinicConfig: { adFirstReply: config, services, serviceAliases: aliases,
      businessName: "Neutro Sense TCM" },
    ai: { getReply: async () => { aiCalls++; return { text: "MODEL ANSWER" }; } },
    parseAiReplyResult: raw => raw,
    correctReplyLanguage: async draft => draft,
    ...require("../src/utils/chatLanguage"),
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
  const rm68Returning = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
  const returning = await runtime({
    text: rm68Returning, wasFirstMessage: false,
    metaAdContext: null, metaAdCreativeService: null,
    incoming: { attribution: {
      source: "meta_ads", sourceType: "ad", adId: "live-verified-456",
      body: "胸部护理 RM68 体验 12月5日与6日",
    } },
    history: [
      { role: "assistant", content: "old session" },
      { role: "user", content: rm68Returning },
    ],
  });
  assert.equal(returning.fixedAdFirstReply?.campaignKey, "neutro_breast_rm68_2026");
  assert.match(returning.aiReply, /首次体验只需 RM68/);
  assert.equal(aiCalls, 2, "actual returning Meta referral bypasses Gemini");

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

test("saving ad-first-reply settings rejects stale treatment links while preserving disabled drafts", () => {
  const good = { enabled: true, replies: [{
    service: "骨盆调理", translations,
  }] };
  const current = {
    services: services.map(item => ({
      ...item, description: "", priceRange: "", duration: "",
    })),
    adFirstReply: good,
    resultMedia: [],
    automatedFollowUp: { enabled: false, additionalSteps: [] },
  };
  const accepted = prepareConfigUpdatePayload({ adFirstReply: good }, current);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.updates.adFirstReply.enabled, true);

  const stale = {
    enabled: true,
    replies: [{ service: "Previously Removed Treatment", translations }],
  };
  const declined = prepareConfigUpdatePayload({ adFirstReply: stale }, current);
  assert.equal(declined.ok, false);
  assert.deepEqual(declined.invalidKeys, ["adFirstReply"]);

  const disabledDraft = prepareConfigUpdatePayload({
    adFirstReply: { ...stale, enabled: false },
  }, current);
  assert.equal(disabledDraft.ok, true, "disabled drafts can be saved for later repair");

  const removed = prepareConfigUpdatePayload({
    services: current.services.filter(item => item.name !== "骨盆调理"),
  }, current);
  assert.equal(removed.ok, false, "cannot silently orphan an enabled first reply");
  assert.deepEqual(removed.invalidKeys, ["adFirstReply"]);
});


test("real Neutro Sense Meta first-message prefills select advertised services, not ambiguous ad-name guesses", () => {
  const expandedServices = [...services, { name: "徒手体态调理" }, { name: "产后调理" }];
  const expandedAliases = [
    ...aliases,
    { alias: "骨盆", officialService: "骨盆调理" },
    { alias: "骨盆调整", officialService: "骨盆调理" },
    { alias: "整骨", officialService: "徒手体态调理" },
    { alias: "徒手整骨", officialService: "徒手体态调理" },
    { alias: "小颜术", officialService: "3D 小颜术" },
    { alias: "3D小颜术", officialService: "3D 小颜术" },
    { alias: "9D护理", officialService: "9D 逆龄抗衰" },
    { alias: "9D脸部提升", officialService: "9D 逆龄抗衰" },
  ];
  const fullConfig = {
    enabled: true,
    replies: [
      { service: "骨盆调理", translations },
      { service: "3D 小颜术", translations: { ...translations, zh: "3D 固定回复" } },
      { service: "9D 逆龄抗衰", translations: { ...translations, zh: "9D 固定回复" } },
    ],
  };
  const pelvicAd = {
    attributedAt: ad.attributedAt,
    headline: "徒手整骨｜从头到脚",
    body: "针对骨盆调整、产后调理和全身整骨的一系列项目",
  };
  const facialAd = {
    attributedAt: ad.attributedAt,
    headline: "1次就能看到明显效果",
    body: "中医小颜术介绍：3D小颜术护理，帮助调整面部线条",
  };
  const targets = [
    ["你好！我想了解你们骨盆的疗程", pelvicAd, "骨盆调理"],
    ["Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊", pelvicAd, "骨盆调理"],
    ["Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～", facialAd, "3D 小颜术"],
    ["我想了解【3D小颜术】疗程！", facialAd, "3D 小颜术"],
    ["我想了解【9D脸部提升】疗程！", {
      attributedAt: ad.attributedAt, headline: "9D脸部提升", body: "9D逆龄抗衰护理",
    }, "9D 逆龄抗衰"],
    ["Hi～想了解 Neutro Sense TCM 9D 护理，有后续配套和优惠可以 WhatsApp 发我 😊", {
      attributedAt: ad.attributedAt, headline: "9D脸部提升", body: "9D护理",
    }, "9D 逆龄抗衰"],
  ];
  for (const [message, creative, expected] of targets) {
    const result = attempt({
      config: fullConfig,
      customerText: message,
      conversationHistory: [{ role: "user", content: message }],
      metaAdContext: creative,
      metaAdCreativeService: null,
      services: expandedServices,
      serviceAliases: expandedAliases,
    });
    assert.equal(result?.treatment, expected, message);
    assert.equal(result?.serviceQuerySource, "customer_message", message);
  }
  // A 9D prefill must not be routed to a 3D fixed reply just because the
  // ad name is "小颜术 5" and other customers send 3D prefills there.
  const wrongCreative = attempt({
    config: fullConfig,
    customerText: targets[5][0],
    conversationHistory: [{ role: "user", content: targets[5][0] }],
    metaAdContext: facialAd,
    metaAdCreativeService: "3D 小颜术",
    services: expandedServices,
    serviceAliases: expandedAliases,
  });
  assert.equal(wrongCreative, null, "different treatment requires Gemini");
  const generic = attempt({
    config: fullConfig,
    customerText: "Hello! Can I get more info on this?",
    conversationHistory: [{ role: "user", content: "Hello! Can I get more info on this?" }],
    metaAdContext: pelvicAd,
    metaAdCreativeService: null,
    services: expandedServices,
    serviceAliases: expandedAliases,
  });
  assert.equal(generic, null, "a multi-treatment ad cannot unlock generic prefills");
});

test("edited first-message questions reach Gemini even when ad creative verifies the treatment", () => {
  const edited = [
    "想了解骨盆调理需要准备什么",
    "你好！我想了解你们骨盆的疗程需要带什么",
    "我对骨盆调理收费有兴趣",
    "我想了解骨盆调理的注意事项",
    "我对骨盆调理怎么做有兴趣，可以跟进我，有优惠也发我看看",
  ];
  for (const customerText of edited) {
    const reasons = [];
    assert.equal(attempt({
      customerText,
      conversationHistory: [{ role: "user", content: customerText }],
      onSkip: reason => reasons.push(reason),
    }), null, customerText);
    assert.deepEqual(reasons, ["substantive_or_unsafe_message"], customerText);
  }
  assert.equal(configuredPrefill("Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～"), true);
  assert.equal(configuredPrefill("Hi～想了解 Neutro Sense TCM 9D 护理，有后续配套和优惠可以 WhatsApp 发我 😊"), true);
  assert.equal(configuredPrefill("你好！我想了解你们骨盆的疗程"), true);
  assert.equal(isStandardAdPrefill("我对骨盆调理有兴趣"), false,
    "No configured services means no unverifiable Chinese named-treatment fast path");
});

test("historical non-prefill questions, staff or spam text remain on Gemini", () => {
  const notStandard = [
    "你好！我长期坐着会导致我的骨盆问题吗？",
    "你好！我想问看我刚刚身孕完，感觉骨盆有点前倾，可以来面诊吗？",
    "我可以直接预约你们的Signature【9D Lifting疗程】吗",
    "我想知道价格",
    "Pm多少钱",
    "请问推脸一次多少钱",
    "地点？收费？",
    "请问在哪里",
    "Can I know where is your location?",
    "Where is ur shop located?",
    "Location",
    "English",
    "Yes",
    "Hi",
    "请问有筋膜放松吗？肩颈和腰部",
    "你好！想了解骨盆的副作用和次数",
    "Hi, I am interested in 3D can I book tomorrow",
  ];
  for (const message of notStandard) {
    assert.equal(attempt({
      customerText: message,
      conversationHistory: [{ role: "user", content: message }],
    }), null, message);
  }
});
