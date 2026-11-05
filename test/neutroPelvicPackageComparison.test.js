"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveNeutroPelvicPackageComparison } = require("../src/utils/neutroPelvicPackageComparison");

const services = [
  { name: "骨盆调理" }, { name: "9D 逆龄抗衰" }, { name: "1对1体态评估" },
  { name: "子宫调理" }, { name: "艾灸" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "子宫护理", officialService: "子宫调理" },
  { alias: "子宫", officialService: "子宫调理" },
  { alias: "艾灸调理", officialService: "艾灸" },
];
const promo = {
  linkedService: "骨盆调理", name: "骨盆调理套餐",
  validFrom: "2026-10-01", validUntil: "2026-11-30", sendOnPriceQuery: true,
  packages: [
    {
      name: "Package A", title: "尊享护理配套｜2小时30分钟",
      imageUrl: "https://example.test/promo-images/30",
      caption: "本月限时优惠\n原价 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣\n尊享护理配套｜2小时30分钟\n包含：\n✅骨盆调整与体态矫正疗程\n✅经络穴位按摩\n✅子宫草药护理\n✅AI 身体检测",
      pricing: { offer: 388, normal: 488, currency: "MYR" },
      mediaTranslations: { zh: { caption: "限时\n✅骨盆调整与体态矫正疗程\n✅经络穴位按摩\n✅子宫草药护理\n✅AI 身体检测" },
        en: { caption: "Limited time\n✅Pelvic and posture treatment\n✅Meridian massage\n✅Herbal womb care\n✅AI body assessment" } },
    },
    {
      name: "Package B", title: "1小时30分钟女性护理配套",
      imageUrl: "https://example.test/promo-images/31",
      caption: "本月限时优惠\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣\n1小时30分钟女性护理配套\n✅骨盆调整与体态矫正疗程\n✅子宫护理\n✅艾灸桶护理｜排湿・驱寒",
      pricing: { offer: 288, normal: 388, currency: "MYR" },
      mediaTranslations: { zh: { caption: "限时\n✅骨盆调整与体态矫正疗程\n✅子宫护理\n✅艾灸桶护理｜排湿・驱寒" },
        en: { caption: "Limited time\n✅Pelvic and posture treatment\n✅Womb care\n✅Moxibustion barrel treatment" } },
    },
  ],
};
const now = Date.parse("2026-11-05T06:26:20Z");
const text = "RM388和RM288的配套有什么分别？";
const rows = [
  ["user", "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊"],
  ["assistant", "我们的骨盆调理主要是通过中医师的手法来调整体态，先做1对1体态评估+体验。"],
  ["user", "我对你们的骨盆调理有兴趣，想了解一下。"],
  ["assistant", "中医师会先帮你做一个1对1的体态评估+体验。"],
  ["user", "我平时久坐，腰有点酸，小腹也比较突出。"],
  ["assistant", "你可以先让中医师做体态评估+体验。"],
  ["user", "那这种调理是做一次就行了吗？想了解价钱看看"],
  ["assistant", "你之前咨询的是骨盆调理 😊 这项收费我暂时无法核对准确金额。"],
  ["user", "那这种调理是做一次就行了吗？想了解价钱看看"],
  ["assistant", "骨盆调理目前的配套价格是：\n• Package A（2小时30分钟）：RM388\n• Package B（1小时30分钟）：RM288\n\nPackage A 上述价格是优惠券后价格。"],
  ["assistant", "本月限时优惠\n优惠后仅需 RM3️⃣8️⃣8️⃣"],
  ["assistant", "本月限时优惠\n优惠后仅需 RM2️⃣8️⃣8️⃣"],
  ["user", text],
];
const history = rows.map(([role, content], i) => ({
  role, content, pricingCreatedAtMs: now - (rows.length - i) * 20000,
}));
function compare(overrides = {}) {
  return resolveNeutroPelvicPackageComparison({
    customerText: text, conversationHistory: history, services,
    serviceAliases, promotions: [promo], now, language: "zh", ...overrides,
  });
}

test("fresh contact 8943: compare two previously quoted pelvic packages using current configuration", () => {
  const result = compare();
  assert.equal(result?.treatment, "骨盆调理");
  assert.equal(result?.type, "text_only");
  assert.match(result.reply, /Package A \(RM388/);
  assert.match(result.reply, /2小时30分钟/);
  assert.match(result.reply, /经络穴位按摩/);
  assert.match(result.reply, /子宫草药护理/);
  assert.match(result.reply, /AI 身体检测/);
  assert.match(result.reply, /Package B \(RM288/);
  assert.match(result.reply, /1小时30分钟/);
  assert.match(result.reply, /子宫护理/);
  assert.match(result.reply, /艾灸桶护理/);
  assert.match(result.reply, /优惠券使用条件/);
  assert.doesNotMatch(result.reply, /无法核对准确金额/);
  assert.equal(result.imageUrl, undefined, "comparison cannot authorize image delivery");
});

test("comparison is not a fresh price enquiry or permission to send repeated images", () => {
  assert.equal(compare({ customerText: "请问骨盆调理多少钱？" }), null);
  assert.equal(compare({ customerText: "Package A和Package B有什么分别？" }), null,
    "this narrowly scoped recovery requires the two exact configured amounts");
  assert.equal(compare({ customerText: "RM388和RM288我明天可以转账吗？" }), null);
  assert.equal(compare({ customerText: "RM388和RM288的价格太贵，不要发促销" }), null);
  assert.equal(compare({ customerText: "9D的RM388和RM288的配套有什么分别？" }), null);
  assert.equal(compare({ customerText: "RM388和RM488的配套有什么分别？" }), null);
  assert.equal(compare({ customerText: "RM388和RM288和RM488的配套有什么分别？" }), null);
  assert.equal(compare({ customerText: "RM388和RM288的配套有什么分别？还要问诊吗，最近持续剧痛" }), null);
});

test("no quote, no customer treatment selection, staff takeover or stale session fails closed", () => {
  assert.equal(compare({ conversationHistory: [
    ...history.slice(0, 9), history.at(-1),
  ] }), null, "a previous price pair from the model is required");
  assert.equal(compare({ conversationHistory: history.map((turn, index) =>
    [0, 2].includes(index) ? { ...turn, content: "你好" } : turn) }), null);
  assert.equal(compare({ conversationHistory: history.map((turn,index) =>
    index===9 ? { ...turn, pricingStaffAuthored: true } : turn) }), null);
  assert.equal(compare({ now: now + 4*60*60*1000 }), null);
  assert.equal(compare({ promotions: [{
    ...promo, validUntil: "2026-11-04",
  }] }), null);
  assert.equal(compare({ promotions: [{
    ...promo, packages: promo.packages.map(p => p.name === "Package B"
      ? { ...p, pricing: { ...p.pricing, offer: 299 } } : p),
  }] }), null, "a price change must not reuse the former package quote");
  assert.equal(compare({ promotions: [promo, {...promo}] }), null,
    "conflicting active promotions must not be guessed");
});

test("EN comparison uses configured English caption details without generating new media", () => {
  const result = compare({ language: "en" });
  assert.match(result.reply, /Pelvic and posture treatment/);
  assert.match(result.reply, /Meridian massage/);
  assert.match(result.reply, /Moxibustion barrel treatment/);
  assert.equal(result.type, "text_only");
});


test("14:44 live test: one WhatsApp Business App staff inclusion note does not erase a prior AI quote", () => {
  // 14:29 staff sent a factual A/B inclusion comparison while contact #8943
  // stayed AI-owned; 14:44 user repeated the same exact price-pair question.
  // Trusted inbound/AI evidence and active prices still authorize TEXT ONLY.
  const note = {
    role: "assistant", pricingStaffAuthored: true,
    pricingCreatedAtMs: now - 30_000,
    content: "Package A 有包括骨盆矫正 + 1小时全身经络按摩和子宫护理\n\nPackage B\n骨盆矫正 + 局部按摩 和温宫草药",
  };
  const withNote = [...history.slice(0,-1), note, history.at(-1)];
  const result = compare({ conversationHistory: withNote });
  assert.equal(result?.type, "text_only");
  assert.match(result.reply, /Package A \(RM388/);
  assert.match(result.reply, /Package B \(RM288/);
  assert.match(result.reply, /经络穴位按摩/);
  assert.match(result.reply, /艾灸桶护理/);
  assert.equal(result.imageUrl, undefined);
});

test("staff note exception cannot authorize a new quote, a takeover, changed price or other treatment", () => {
  const base = {
    role: "assistant", pricingStaffAuthored: true,
    pricingCreatedAtMs: now - 30_000,
    content: "Package A 包括经络穴位按摩；Package B 包括子宫护理。",
  };
  const withStaff = (note, baseHistory=history) =>
    [...baseHistory.slice(0,-1), note, baseHistory.at(-1)];
  for (const message of [
    "我已接手这个聊天，请不要自动回复。",
    "人工接手，稍后确认。",
    "Package B 现在改成 RM299。",
    "其实你也可以考虑9D逆龄抗衰疗程。",
    "我建议先停止自动消息。",
  ]) {
    assert.equal(compare({ conversationHistory: withStaff({ ...base, content: message }) }),
      null, "a staff override or competing treatment must block: " + message);
  }
  assert.equal(compare({ conversationHistory: withStaff(base, [
    ...history.slice(0,9), history.at(-1),
  ]) }), null, "manual package descriptions cannot substitute for an AI-verified quote");
  assert.equal(compare({ conversationHistory: withStaff({
    ...base, pricingCreatedAtMs: null,
  }) }), null, "missing staff timestamp fails closed");
  assert.equal(compare({ conversationHistory: withStaff({
    ...base, pricingCreatedAtMs: now - 3_000,
  }) }), null, "out-of-order manual message fails closed");
  assert.equal(compare({ conversationHistory: withStaff({
    ...base, pricingCreatedAtMs: now - 30_000,
  }, history.map((turn, index) =>
    index === 2 ? { ...turn, content: "你好" } :
      index === 0 ? { ...turn, content: "你好" } : turn
  )) }), null, "a confirmed customer-selected treatment is required");
  assert.equal(compare({ conversationHistory: [
    ...history.slice(0,-1),
    {...base, pricingCreatedAtMs: now-31_000},
    {...base, pricingCreatedAtMs: now-30_000},
    history.at(-1),
  ] }), null, "multiple manual staff interventions require review");
});

test("comparison remains current-config-only after manual note", () => {
  const note = {
    role: "assistant", pricingStaffAuthored: true,
    pricingCreatedAtMs: now - 30_000,
    content: "Package A 与 Package B 分别有不同护理内容。",
  };
  const conversationHistory = [...history.slice(0,-1), note, history.at(-1)];
  assert.equal(compare({
    conversationHistory,
    promotions: [{...promo, packages: promo.packages.map(p =>
      p.name === "Package A" ? { ...p, pricing: { ...p.pricing, offer: 399 } } : p)}],
  }), null, "current price updates invalidate an older AI quote");
  assert.equal(compare({
    conversationHistory,
    promotions: [{...promo, validUntil: "2026-11-04"}],
  }), null, "expired offer must not be compared");
});
