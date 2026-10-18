"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { resolveNumberedPricingMenuSelection } = require("../src/utils/numberedPricingMenuSelection");
const {
  isContinuedTreatmentPriceQuestion, resolveContinuedTreatmentPriceService,
  resolveVerifiedPriceFollowUpService,
} = require("../src/utils/priceFollowUpContext");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { ensureVerifiedPriceReply, verifiedPricesForService } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const now = Date.now();
const services = [
  { name: "骨盆调理", priceRange: "" },
  { name: "徒手体态调理", priceRange: "" },
  { name: "3D 小颜术", priceRange: "" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆矫正", officialService: "骨盆调理" },
  { alias: "体态调整", officialService: "徒手体态调理" },
  { alias: "3D", officialService: "3D 小颜术" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理", sendOnPriceQuery: true,
  packages: [{
    name: "Package A", title: "尊享护理配套",
    imageUrl: "https://example.test/a.jpg",
    caption: "本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
  }, {
    name: "Package B", title: "女性护理配套",
    imageUrl: "https://example.test/b.jpg",
    caption: "本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣",
  }],
}];
const options = { services, serviceAliases, promotions, resultMedia: [] };
const turn = (role, content, offsetSeconds = 0, staff = false) => ({
  role, content, pricingCreatedAtMs: now + offsetSeconds * 1000, pricingStaffAuthored: staff,
});
const originalPrice = "请问一次收费是多少呢";
const menu = "我们这边主要有：\n\n1. 骨盆/体态调理：中医师徒手调理\n2. 3D 小颜术：非注射的脸型护理\n3. 脉冲波调理：身体塑形\n\n你主要想先了解哪一个项目的收费呢？😊";
const historyForPrice = () => [
  turn("user", "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我", -100),
  turn("assistant", "我们的骨盆调理主要是中医师通过手法来做体态调理", -98),
  turn("assistant", [
    { type: "text", text: "这个是骨盆调理的 Before & After" },
    { type: "image", data: "synthetic" },
  ], -96),
  turn("assistant", [
    { type: "text", text: "再给你看一个顾客体态变化的 Before & After" },
    { type: "image", data: "synthetic" },
  ], -94),
  turn("user", originalPrice, -50),
];
const numberedHistory = () => [
  ...historyForPrice(),
  turn("assistant", "请问你想了解哪一项疗程的价格呢？", -45),
  turn("user", "有哪几种疗程呢", -35),
  turn("assistant", menu, -25),
  turn("user", "1", -20),
];

async function withAssessmentFirst(action) {
  const prior = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = { ...prior, assessmentFirstPricingEnabled: true };
  try { return await action(); }
  finally { clinicConfig.automatedFollowUp = prior; }
}
async function media({ text, history, selected, ...extra }) {
  return resolvePricePromotionForReply({
    ...options, priceQuery: true, packageQuery: false,
    customerText: text, conversationHistory: history,
    treatment: selected, verifiedServiceFromText: selected,
    verifiedNumberedSelection: text === "1" ? selected : null,
    flagged: false, bookingReady: false, needsAttention: false,
    keywordReason: null, textSendSucceeded: true,
    contactId: 26, language: "zh",
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    ...extra,
  });
}

test("customer-stated 骨盆 survives two Before & After photos before a session-fee question", async () => {
  await withAssessmentFirst(async () => {
    const history = historyForPrice();
    assert.equal(isContinuedTreatmentPriceQuestion(originalPrice), true);
    assert.equal(resolveContinuedTreatmentPriceService({
      customerText: originalPrice, conversationHistory: history, ...options, now,
    })?.name, "骨盆调理");
    assert.equal(resolveVerifiedPriceFollowUpService({
      customerText: originalPrice, conversationHistory: history, ...options,
      allowContinuedPriceContext: true,
    })?.name, "骨盆调理");
    const pricing = resolveAiPricingDecision({
      customerText: originalPrice, conversationHistory: history,
      priceQuery: true, ...options, now,
    });
    assert.equal(pricing?.treatment, "骨盆调理");
    const quote = ensureVerifiedPriceReply({
      ...options, customerText: originalPrice, conversationHistory: history,
      treatment: "骨盆调理", reply: "你想了解哪个价格呢？",
      allowContinuedPriceContext: true,
    });
    assert.match(quote.reply, /Package A.*RM388/su);
    assert.match(quote.reply, /Package B.*RM288/su);
    const result = await media({ text: originalPrice, history, selected: "骨盆调理" });
    assert.deepEqual(result?.packages.map(p => p.name), ["Package A", "Package B"]);
  });
});

test("a numbered price menu converts 1 into verified 骨盆 price and two matching graphics", async () => {
  await withAssessmentFirst(async () => {
    const history = numberedHistory();
    const selection = resolveNumberedPricingMenuSelection({
      customerText: "1", conversationHistory: history, ...options, now,
    });
    assert.deepEqual(selection, { treatment: "骨盆调理", source: "numbered_price_menu" });
    const prices = verifiedPricesForService(
      selection.treatment, promotions, "1", history,
      { clarifiedPriceService: selection.treatment },
    );
    assert.deepEqual(prices.map(p => p.price), ["RM388", "RM288"]);
    const reply = ensureVerifiedPriceReply({
      ...options, customerText: "1", conversationHistory: history,
      treatment: selection.treatment, clarifiedPriceService: selection.treatment,
      reply: "我帮你核对价格 😊", priceOnlyResponse: true,
    });
    assert.match(reply.reply, /Package A.*RM388/su);
    assert.match(reply.reply, /Package B.*RM288/su);
    const result = await media({ text: "1", history, selected: selection.treatment });
    assert.deepEqual(result?.packages.map(p => p.name), ["Package A", "Package B"]);
  });
});

test("numeric pricing rejects stale or staff menus, unrelated choices and duplicates", async () => {
  const resolve = (history, customerText = "1") => resolveNumberedPricingMenuSelection({
    customerText, conversationHistory: history, ...options, now,
  });
  const base = numberedHistory();
  assert.equal(resolve(base, "9"), null);
  assert.equal(resolve(base, "10"), null);
  assert.equal(resolve(base, "1 please"), null);
  assert.equal(resolve([...base.slice(0, -2), turn("assistant", "No numbered menu", -25), base.at(-1)]), null);
  assert.equal(resolve([...base.slice(0, -2), turn("assistant", menu, -25, true), base.at(-1)]), null);
  assert.equal(resolve([...base.slice(0, -2), turn("assistant", "[Verified STAFF message] " + menu, -25), base.at(-1)]), null);
  assert.equal(resolve([...base.slice(0, -1), turn("user", "1", -90000)]), null);
  assert.equal(resolve([
    turn("user", "我想了解骨盆调理", -100),
    turn("assistant", "你想知道什么？", -90),
    turn("user", "有哪几种疗程呢", -40),
    turn("assistant", menu, -30),
    turn("user", "1", -20),
  ]), null, "a menu alone never authorizes promotional prices");
  await withAssessmentFirst(async () => {
    assert.equal(await media({
      text: "1", history: base, selected: "3D 小颜术",
      verifiedNumberedSelection: "骨盆调理",
    }), null);
    assert.equal(await media({
      text: "1", history: base, selected: "骨盆调理",
      hasUnconfirmedMediaDelivery: async () => true,
    }), null);
    assert.equal(await media({
      text: "1", history: base, selected: "骨盆调理",
      wasPromoRecentlySent: async () => true,
    }), null);
    assert.equal(await media({
      text: "1", history: base, selected: "骨盆调理",
      textSendSucceeded: false,
    }), null);
  });
});

test("continued price context rejects old conversations, staff and topic switches", () => {
  const resolve = history => resolveContinuedTreatmentPriceService({
    customerText: originalPrice, conversationHistory: history, ...options, now,
  });
  assert.equal(resolve([
    ...historyForPrice().slice(0, -1),
    turn("assistant", "真人已经接手了", -70, true),
    turn("user", originalPrice, -50),
  ]), null);
  const history = historyForPrice();
  history[0].pricingCreatedAtMs = now - 25 * 60 * 60 * 1000;
  assert.equal(resolve(history), null);
  const switched = [
    turn("user", "我对骨盆调理有兴趣", -100),
    turn("assistant", "骨盆调理可以了解一下", -90),
    turn("user", "我不想做骨盆了，我想了解3D", -80),
    turn("assistant", "我们也有3D", -70),
    turn("user", originalPrice, -50),
  ];
  assert.equal(resolve(switched), null);
});


test("mixed numbered options are not silently reduced to one priced service", () => {
  const base = numberedHistory();
  const menuAt = base.length - 2;
  const resolve = (heading, selected = "1") => {
    const copy = base.slice();
    copy[menuAt] = turn("assistant",
      "我们有：\n1. " + heading + "：疗程介绍\n2. 3D 小颜术：脸型护理\n\n你想了解哪项的收费呢？",
      -25);
    return resolveNumberedPricingMenuSelection({
      customerText: selected, conversationHistory: copy,
      ...options, now,
    });
  };
  assert.deepEqual(resolve("骨盆/体态调理"), {
    treatment: "骨盆调理", source: "numbered_price_menu",
  });
  for (const heading of [
    "3D/9D", "3D+9D", "骨盆/3D", "女性及产后调理",
    "骨盆和3D", "3D、骨盆", "骨盆 & 3D",
  ]) {
    assert.equal(resolve(heading), null, heading + " must not select first treatment");
  }
});

test("no verified numeric-menu price returns a clear confirmation in Enabled mode", () => {
  const reply = ensureVerifiedPriceReply({
    customerText: "1", reply: "我帮你核对这项疗程的最新配套价格 😊",
    treatment: "骨盆调理", verifiedNumberedSelection: "骨盆调理",
    pricingDecision: null, priceOnlyResponse: true,
    promotions: [], ...options, language: "zh",
  });
  assert.equal(reply.restored, true);
  assert.match(reply.reply, /骨盆调理.*价格需要由门店/u);
  assert.doesNotMatch(reply.reply, /我帮你核对|哪项疗程/u);
  const ordinary = ensureVerifiedPriceReply({
    customerText: "Hi", reply: "我可以介绍疗程",
    treatment: null, pricingDecision: null, ...options,
  });
  assert.equal(ordinary.reply, "我可以介绍疗程");
});
