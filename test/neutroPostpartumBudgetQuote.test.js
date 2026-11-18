"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveNeutroPostpartumBudgetQuote } =
  require("../src/utils/neutroPostpartumBudgetQuote");
const { recentVerifiedPricingSession } =
  require("../src/utils/shadowPriceException");

const now = Date.now();
const turn = (role, content, sec, staff = false) => ({
  role, content, pricingCreatedAtMs: now - sec * 1000,
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
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "产后", officialService: "产后调理" },
];
const promotions = [
  {
    name: "脉冲波调理 Promotion", linkedService: "脉冲波调理",
    sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
    imageUrl: "https://example.test/pulse.jpg",
    caption: "脉冲能量波\n1次只需要\nRM388!",
    pricing: { currency: "MYR", offer: 388, normal: 688 },
  },
  {
    name: "骨盆调理套餐", linkedService: "骨盆调理",
    sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
    packages: [
      {
        name: "Package A", title: "尊享护理配套",
        caption: "原价 RM488\n优惠后仅需 RM388",
        imageUrl: "https://example.test/pelvic-a.jpg",
        pricing: { currency: "MYR", offer: 388, normal: 488 },
      },
      {
        name: "Package B", title: "女性护理配套",
        caption: "原价 RM388\n现在只需 RM288",
        imageUrl: "https://example.test/pelvic-b.jpg",
        pricing: { currency: "MYR", offer: 288, normal: 388 },
      },
    ],
  },
];
const question = "weekend\n可以先知道疗程/每次大概收费会是？想大约知道budget在哪里";
const realConversation = () => [
  turn("user",
    "Hi～我对 Neutro Sense TCM 黄金脉冲技术有兴趣，可以跟进我，有优惠也发我看看 😊", 410),
  turn("assistant", "想了解我们的脉冲波调理对吗？", 407),
  turn("user", "产后身材变化\n 肚子/小 骨盆 手臂 臀围 \n也不确定是不是骨盆需要调整", 105),
  turn("assistant",
    "中医师会先帮你做一个1对1的体态评估+体验，看看骨盆和整体体态状态，再看适合从骨盆调理、脉冲波还是其他产后方案开始。", 100),
  turn("user", "已经很久了 一年半了", 80),
  turn("assistant", "请问你平时比较方便 weekdays 还是 weekend 过来 PJ 面诊呢？", 74),
  turn("user", question, 20),
];
const quote = (history = realConversation(), text = question, offers = promotions) =>
  resolveNeutroPostpartumBudgetQuote({
    customerText: text,
    session: recentVerifiedPricingSession(history, text, now),
    services, serviceAliases, promotions: offers, language: "zh", now,
  });

test("Neutro #9156: budget price after pulse ad + uncertain postpartum pelvic care shows all three verified options", () => {
  const result = quote();
  assert.ok(result, "must recover a text-only quote for the real conversation pattern");
  assert.equal(result.source, "verified_postpartum_budget_options");
  assert.equal(result.prices.length, 2, "two separate treatments, not a three-treatment combo");
  assert.match(result.reply, /脉冲波调理.*RM388/u);
  assert.match(result.reply, /骨盆调理 Package A.*RM388/u);
  assert.match(result.reply, /骨盆调理 Package B.*RM288/u);
  assert.doesNotMatch(result.reply, /RM688|RM488/u, "normal prices are not sale quotes");
  assert.doesNotMatch(result.reply, /组合收费是/u);
  assert.equal(result.imageUrl, undefined, "no automatic pricing image in a mixed-treatment enquiry");
  assert.equal(result.prices.some(p => p.treatment === "产后调理"), false);
});

test("Neutro #9156: staff or an untrusted timestamp never authorizes the quote", () => {
  const staff = realConversation();
  staff[3] = { ...staff[3], pricingStaffAuthored: true };
  assert.equal(quote(staff), null);
  const missing = realConversation();
  delete missing[2].pricingCreatedAtMs;
  assert.equal(quote(missing), null);
  const stale = realConversation();
  stale[0].pricingCreatedAtMs = now - 8 * 24 * 60 * 60 * 1000;
  assert.equal(quote(stale), null);
});

test("Neutro #9156: budget objections, price-free questions and administrative fees do not quote", () => {
  for (const text of [
    "我的budget是RM300", "weekend，怎样安排面诊？",
    "想先知道评估费多少，budget有限", "想了解全部疗程的收费和budget",
    "不想了解价格，budget先不谈",
  ]) {
    const history = realConversation();
    history[history.length - 1] = turn("user", text, 20);
    assert.equal(quote(history, text), null, text);
  }
});

test("Neutro #9156: no customer pulse selection, no pelvic uncertainty, or no bot alternatives means no quote", () => {
  const wrongFirst = realConversation();
  wrongFirst[0] = turn("user", "我只是想知道你们有哪些服务", 410);
  assert.equal(quote(wrongFirst), null);
  const certain = realConversation();
  certain[2] = turn("user", "我想直接做骨盆调理，已经决定了", 105);
  assert.equal(quote(certain), null);
  const noMenu = realConversation();
  noMenu[3] = turn("assistant", "建议先评估骨盆是否需要调整", 100);
  assert.equal(quote(noMenu), null);
  const switched = realConversation();
  switched[4] = turn("user", "我要做9D 逆龄", 80);
  assert.equal(quote(switched), null);
});

test("Neutro #9156: missing/expired/conflicting price configuration fails closed", () => {
  const expired = structuredClone(promotions);
  expired[0].validUntil = "2001-01-01";
  assert.equal(quote(realConversation(), question, expired), null);
  const missingB = structuredClone(promotions);
  missingB[1].packages.pop();
  assert.equal(quote(realConversation(), question, missingB), null);
  const conflicting = structuredClone(promotions);
  conflicting.push({ ...structuredClone(promotions[0]), name: "conflicting pulse offer",
    caption: "现在只需 RM399", pricing: { currency: "MYR", offer: 399 } });
  assert.equal(quote(realConversation(), question, conflicting), null);
});

test("Neutro #9156: guarded server path remains text-only; existing media gate not bypassed", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.match(server, /resolveNeutroPostpartumBudgetQuote\(/u);
  assert.match(server, /if \(twoTreatmentQuote\) \{[\s\S]{0,450}two_treatments_text_only/u);
  assert.match(server, /const promoBundle = \(twoTreatmentQuote && !comboMediaPricingDecision\)/u);
});
