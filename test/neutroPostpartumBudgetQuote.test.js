"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveNeutroPostpartumBudgetQuote } =
  require("../src/utils/neutroPostpartumBudgetQuote");
const { recentVerifiedPricingSession } =
  require("../src/utils/shadowPriceException");
const { canRecoverTwoPriceInformationReview } =
  require("../src/utils/priceConversationRecovery");

const now = Date.now();
const turn = (role, content, secondsBefore, staff = false) => ({
  role, content, pricingCreatedAtMs: now - secondsBefore * 1000,
  pricingStaffAuthored: staff,
});
const services = [
  { name: "脉冲波调理" }, { name: "骨盆调理" },
  { name: "产后调理" }, { name: "1对1体态评估" },
  { name: "3D 小颜术" }, { name: "9D 逆龄抗衰" },
];
const serviceAliases = [
  { alias: "黄金脉冲技术", officialService: "脉冲波调理" },
  { alias: "脉冲波", officialService: "脉冲波调理" },
  { alias: "脉冲", officialService: "脉冲波调理" },
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "产后", officialService: "产后调理" },
];
const promotions = [
  {
    name: "脉冲波调理 Promotion", linkedService: "脉冲波调理",
    sendOnPriceQuery: true,
    imageUrl: "https://example.test/pulse.jpg",
    caption: "【脉冲能量波】\n1次只需要\nRM388❗\n",
    pricing: { currency: "MYR", offer: 388, normal: 688 },
    mediaTranslations: {
      en: { caption: "Pulse Wave First Trial RM388 (normal price RM688)" },
      ms: { caption: "Harga promosi RM388 (harga asal RM688)" },
    },
  },
  {
    name: "骨盆调理套餐", linkedService: "骨盆调理",
    sendOnPriceQuery: true,
    validFrom: "2026-10-01", validUntil: "2026-11-30",
    packages: [
      {
        name: "Package A", title: "尊享护理配套｜2小时30分钟",
        caption: "本月限时优惠 🔥\nRM100 优惠券限时领取（只限100位）\n原价 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
        imageUrl: "https://example.test/pelvic-a.jpg",
        pricing: { currency: "MYR", offer: 388, normal: 488 },
        mediaTranslations: {
          en: { caption: "RM100 voucher limited to 100 customers\nOriginal price RM488\nAfter voucher, only RM3️⃣8️⃣8️⃣" },
        },
      },
      {
        name: "Package B", title: "1小时30分钟女性护理配套",
        caption: "本月限时优惠 🔥 RM100 优惠券\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣\n限时礼遇 · 预约专享",
        imageUrl: "https://example.test/pelvic-b.jpg",
        pricing: { currency: "MYR", offer: 288, normal: 388 },
        mediaTranslations: {
          en: { caption: "RM100 voucher\nOriginal price RM388\nNow only RM2️⃣8️⃣8️⃣\nExclusive for appointments" },
        },
      },
    ],
  },
];
const question = "weekend\n可以先知道疗程/每次大概收费会是？想大约知道budget在哪里";

// Exact customer and assistant text from production contact #9156's bounded
// 2026-11-17 WhatsApp conversation, including BOTH result-media captions.
// Timestamps are safely shifted relative to now so the test remains reusable.
// This is deliberately not the later staff-authored outbound on 2026-11-18.
function productionConversation(text = question) {
  return [
    turn("user",
      "Hi～我对 Neutro Sense TCM 黄金脉冲技术有兴趣，可以跟进我，有优惠也发我看看 😊", 420),
    turn("assistant",
      "Hi～欢迎来到 Neutro Sense 😊\n\n想了解我们的脉冲波调理对吗～\n\n你目前比较在意小腹/腰部线条、产后身体变化，还是身体某个部位想重点调理呢？", 417),
    turn("assistant",
      "这是 Neutro Sense 脉冲波调理顾客的 Before & After 参考图 😊\n这是个别护理案例，实际变化因人而异，无法保证每个人都有相同效果。", 414),
    turn("assistant",
      "再分享一组 Neutro Sense 脉冲波调理的顾客 Before & After 参考图 😊\n图片仅供个别案例参考，是否适合调理及实际变化需由中医师评估。", 409),
    turn("user",
      "产后身材变化\n 肚子/小 骨盆 手臂 臀围 \n也不确定是不是骨盆需要调整", 115),
    turn("assistant",
      "产后的身材变化很常见哦～腹部、腰臀和手臂这些情况，我们一般不会只当普通减重来看。中医师会先帮你做一个1对1的体态评估+体验，看看骨盆和整体体态状态，再看适合从骨盆调理、脉冲波还是其他产后方案开始。\n\n请问你目前大概产后多久了呢？", 109),
    turn("user", "已经很久了 一年半了", 82),
    turn("assistant",
      "产后一年半可以安排体态调理了解哦～这个阶段很适合让中医师先帮你做一个1对1的体态评估+体验，看看目前的骨盆和整体体态情况，再建议适合的调理方向 😊\n\n请问你平时比较方便 weekdays 还是 weekend 过来 PJ 面诊呢？", 76),
    turn("user", text, 22),
  ];
}
function quote(history = productionConversation(), text = question,
  offers = promotions, time = now, language = "zh") {
  return resolveNeutroPostpartumBudgetQuote({
    customerText: text,
    session: recentVerifiedPricingSession(history, text, time),
    services, serviceAliases, promotions: offers, language, now: time,
  });
}
test("contact #9156 exact production dialogue including 2 result images: quotes three verified prices and voucher conditions", () => {
  const result = quote();
  assert.ok(result, "must recover real unpriced multi-treatment fee enquiry");
  assert.equal(result.source, "verified_discussed_treatment_price_options");
  assert.deepEqual(result.prices.map(p => p.treatment), ["脉冲波调理", "骨盆调理"]);
  assert.match(result.reply, /脉冲波调理：RM388/u);
  assert.match(result.reply, /骨盆调理 Package A：RM388.*RM100 优惠券/u);
  assert.match(result.reply, /骨盆调理 Package B：RM288.*RM100 优惠券/u);
  assert.match(result.reply, /须符合条件及确认名额/u);
  assert.match(result.reply, /预约专享/u);
  assert.doesNotMatch(result.reply, /RM688|RM488/u, "normal prices are not sale quotes");
  assert.equal(result.imageUrl, undefined, "no automatic media permission");
  assert.equal(result.prices.some(p => p.treatment === "产后调理"), false);
});

test("price, fee and session-cost requests work without the English word budget", () => {
  for (const text of [
    "请问每次多少钱？", "可以先告诉我收费大概多少吗？",
    "想知道这个疗程的费用", "可以给我一个大概价位吗？",
    "收费如何", "价钱", "价格",
  ]) {
    const result = quote(productionConversation(text), text);
    assert.ok(result, text);
    assert.match(result.reply, /脉冲波调理：RM388/u);
  }
  const en = "How much does each treatment cost?";
  const translated = quote(productionConversation(en), en, promotions, now, "en");
  assert.match(translated?.reply || "", /after RM100 voucher/u);
  const ms = "Boleh tahu harga untuk rawatan ini?";
  const malay = quote(productionConversation(ms), ms, promotions, now, "ms");
  assert.match(malay?.reply || "", /selepas baucar RM100/u);
});

test("a customer refusing pelvic but explicitly choosing pulse never receives pelvic pricing", () => {
  const text = "我不要做骨盆，只想知道脉冲波的价格和budget";
  const chosen = quote(productionConversation(text), text);
  assert.ok(chosen);
  assert.deepEqual(chosen.prices.map(p => p.treatment), ["脉冲波调理"]);
  assert.doesNotMatch(chosen.reply, /骨盆调理/u);
  const inverse = "我不想做脉冲波，只想知道骨盆调理收费多少？";
  const pelvis = quote(productionConversation(inverse), inverse);
  assert.ok(pelvis);
  assert.deepEqual(pelvis.prices.map(p => p.treatment), ["骨盆调理"]);
  assert.doesNotMatch(pelvis.reply, /脉冲波调理/u);
  const rejectedOnly = "我不要做骨盆，其他收费是多少？";
  assert.equal(quote(productionConversation(rejectedOnly), rejectedOnly), null);
});

test("customer's later choice supersedes the older mixed-treatment menu", () => {
  const text = "可以先告诉我每次收费吗？";
  const history = productionConversation(text);
  history.splice(-1, 0, turn("user", "我只想做脉冲波调理", 36),
    turn("assistant", "可以先了解脉冲波调理，评估后确认适合才安排。", 30));
  const selected = quote(history, text);
  assert.ok(selected);
  assert.deepEqual(selected.prices.map(p => p.treatment), ["脉冲波调理"]);
  const changed = productionConversation(text);
  changed.splice(-1, 0, turn("user", "现在想改做9D逆龄", 36));
  assert.equal(quote(changed, text), null);
});

test("staff, stale timestamp, and non-customer selection never unlock mixed quotes", () => {
  const staff = productionConversation();
  staff[3].pricingStaffAuthored = true;
  assert.equal(quote(staff), null);
  const missing = productionConversation();
  delete missing[4].pricingCreatedAtMs;
  assert.equal(quote(missing), null);
  const stale = productionConversation();
  stale[0].pricingCreatedAtMs = now - 8 * 24 * 60 * 60 * 1000;
  assert.equal(quote(stale), null);
  const wrongFirst = productionConversation();
  wrongFirst[0] = turn("user", "我想知道你们有什么服务", 420);
  assert.equal(quote(wrongFirst), null);
  const noMenu = productionConversation();
  noMenu[5] = turn("assistant", "建议先评估骨盆是否需要调整", 109);
  assert.equal(quote(noMenu), null);
});

test("budget statements, objections, other treatment and administrative fees do not authorize quotes", () => {
  for (const text of [
    "我的budget是RM300", "weekend，怎样安排面诊？",
    "想先知道评估费多少，budget有限", "想了解全部疗程的收费和budget",
    "不想了解价格，budget先不谈", "已经太贵了",
    "请问胸部专业检查是多少钱？", "以后第二次每次多少钱？",
  ]) {
    assert.equal(quote(productionConversation(text), text), null, text);
  }
});

test("missing, expired and contradictory offers fail closed", () => {
  const expired = structuredClone(promotions);
  expired[0].validUntil = "2001-01-01";
  assert.equal(quote(productionConversation(), question, expired), null);
  const missingB = structuredClone(promotions);
  missingB[1].packages.pop();
  assert.equal(quote(productionConversation(), question, missingB), null);
  const conflicting = structuredClone(promotions);
  conflicting.push({
    ...structuredClone(promotions[0]),
    name: "conflicting pulse offer",
    pricing: { currency: "MYR", offer: 399, normal: 688 },
    caption: "现在只需 RM399",
  });
  assert.equal(quote(productionConversation(), question, conflicting), null);
  const badVoucher = structuredClone(promotions);
  badVoucher[1].packages[0].pricing.offer = 368;
  assert.equal(quote(productionConversation(), question, badVoucher), null);
  const afterExpiry = new Date("2026-12-01T04:00:00Z").getTime();
  const future = productionConversation().map(t => ({
    ...t, pricingCreatedAtMs: afterExpiry - (now - t.pricingCreatedAtMs),
  }));
  assert.equal(quote(future, question, promotions, afterExpiry), null,
    "Nov 30 voucher offers must never be sent in December");
});

test("a verified single-option price can resolve only a safe information review", () => {
  const text = "我不要做骨盆，只想知道脉冲波的价格和budget";
  const single = quote(productionConversation(text), text);
  assert.ok(single && single.prices.length === 1);
  const conditions = { quote: single, flagged: true,
    reviewRequired: true, reviewType: "information" };
  assert.equal(canRecoverTwoPriceInformationReview({
    ...conditions, pendingClinicalReview: false,
  }), true);
  assert.equal(canRecoverTwoPriceInformationReview({
    ...conditions, pendingClinicalReview: true,
  }), false);
  assert.equal(canRecoverTwoPriceInformationReview({
    ...conditions, pendingClinicalReview: null,
  }), false);
  assert.equal(canRecoverTwoPriceInformationReview({
    ...conditions, reviewType: "clinical", pendingClinicalReview: false,
  }), false);
  assert.equal(canRecoverTwoPriceInformationReview({
    ...conditions, flagged: false, pendingClinicalReview: false,
  }), false);
});

test("guarded server path keeps this branch text-only and information reviews fail closed", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.match(server, /resolveNeutroPostpartumBudgetQuote\(/u);
  assert.match(server, /!\(shadowPriceException &&\s*safeServiceFromCustomer\(/u);
  assert.match(server, /if \(twoTreatmentQuote\) \{[\s\S]{0,450}two_treatments_text_only/u);
  assert.match(server, /const promoBundle = \(twoTreatmentQuote && !comboMediaPricingDecision\)/u);
});
