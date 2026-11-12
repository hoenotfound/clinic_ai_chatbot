"use strict";

// Regression for a Neutro secondary-number conversation: customer selected
// 骨盆调理, answered "产后" to a pelvic concern prompt, then asked for prices.
// No customer phone numbers or identifiable message metadata are included.
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "骨盆调理", priceRange: "" },
  { name: "产后调理", priceRange: "" },
  { name: "徒手体态调理", priceRange: "" },
  { name: "1对1体态评估", priceRange: "" },
  { name: "3D 小颜术", priceRange: "" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆调整", officialService: "骨盆调理" },
  { alias: "产后", officialService: "产后调理" },
  { alias: "体态评估", officialService: "1对1体态评估" },
  { alias: "整骨", officialService: "徒手体态调理" },
];
const promotions = [{
  name: "骨盆调理套餐",
  linkedService: "骨盆调理",
  validFrom: "2026-10-01",
  validUntil: "2026-11-30",
  sendOnPriceQuery: true,
  packages: [
    { name: "Package A",
      imageUrl: "https://example.test/pelvic-a.jpg",
      caption: "本月限时优惠 原价RM488 优惠后仅需 RM388",
      pricing: { currency: "MYR", offer: 388, normal: 488 } },
    { name: "Package B",
      imageUrl: "https://example.test/pelvic-b.jpg",
      caption: "本月限时优惠 原价RM388 现在只需 RM288",
      pricing: { currency: "MYR", offer: 288, normal: 388 } },
  ],
}];
const priceQuestion = "想问一下价格大概是多少";
const conversation = [
  ["user", "骨盆调理"],
  ["assistant", "骨盆调理主要是用徒手手法来调整体态、骨盆平衡。中医师会先帮你做一个1对1的体态评估+体验。你主要是平时容易腰酸、久坐、小腹比较凸，还是产后体态想调整呢？"],
  ["assistant", "这个是顾客护理后的骨盆 Before & After 😊"],
  ["assistant", "再给你看一个顾客护理后的 Before & After 😊"],
  ["user", "产后"],
  ["assistant", "产后体态调理需要先了解恢复情况，中医师会先安排1对1体态评估+体验。请问产后大概多久了呢？"],
  ["user", "六周左右"],
  ["assistant", "了解，是否还有不适呢？"],
  ["user", "最近有点腰酸，其他没有明显不舒服"],
  ["assistant", "产后容易腰酸常跟骨盆和核心受力变化有关。中医师会先帮你做一个1对1的体态评估+体验，看看目前骨盆和体态状态。你平日或周末方便呢？"],
  ["user", priceQuestion],
];
function history(now = Date.now()) {
  return conversation.map(([role, content], index) => ({
    role, content, pricingCreatedAtMs: now - (conversation.length - index) * 6000,
  }));
}
function input(h, now) {
  return { customerText: h.at(-1).content, conversationHistory: h,
    services, serviceAliases, promotions, now };
}
function price(h, now) {
  const args = input(h, now);
  const shadow = resolveShadowPriceException(args);
  const approval = resolveApprovedPricingAssessment({
    ...args, mode: "shadow", shadowException: shadow, resultMedia: [],
  });
  return { shadow, approval };
}

test("pelvic treatment remains verified after a postpartum concern answer and normal Q&A", async () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  const { shadow, approval } = price(h, now);
  assert.equal(shadow?.treatment, "骨盆调理");
  assert.equal(shadow?.source, "customer_established_treatment");
  assert.equal(approval.reason, "approved");
  assert.deepEqual(approval.decision?.prices.map(p => p.price), ["RM388", "RM288"]);
  const quote = ensureVerifiedPriceReply({
    ...input(h, now), pricingDecision: approval.decision,
    treatment: "骨盆调理", priceRequested: true, priceOnlyResponse: true,
    reply: "评估免费，疗程费用到店再告诉您", language: "zh",
  });
  assert.match(quote.reply, /Package A.*RM388/su);
  assert.match(quote.reply, /Package B.*RM288/su);
  const graphics = await resolvePricePromotionForReply({
    ...input(h, now), pricingDecision: approval.decision, aiPricingEnabled: true,
    treatment: "骨盆调理", verifiedServiceFromText: "骨盆调理",
    priceQuery: true, packageQuery: false, language: "zh", contactId: 1,
    textSendSucceeded: true,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
  });
  assert.deepEqual(graphics?.packages.map(p => p.name), ["Package A", "Package B"]);
  const deduped = await resolvePricePromotionForReply({
    ...input(h, now), pricingDecision: approval.decision, aiPricingEnabled: true,
    treatment: "骨盆调理", verifiedServiceFromText: "骨盆调理",
    priceQuery: true, packageQuery: false, language: "zh", contactId: 1,
    textSendSucceeded: true,
    wasPromoRecentlySent: async () => true,
    hasUnconfirmedMediaDelivery: async () => false,
  });
  assert.equal(deduped, null, "do not resend already delivered promotions");
});

test("a real customer request for postpartum treatment is not a pelvic concern answer", () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  h[4] = { ...h[4], content: "我想了解产后调理这个疗程" };
  assert.equal(price(h, now).approval.decision, null);
});

test("a bot recommendation of a separate postpartum package blocks pelvic pricing", () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  h[5] = { ...h[5], content: h[5].content + " 我们另外也推荐产后调理套餐。" };
  assert.equal(price(h, now).approval.decision, null);
});

test("no original customer pelvic selection cannot borrow a price from the bot", () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  h[0] = { ...h[0], content: "你好" };
  assert.equal(price(h, now).approval.decision, null);
});

test("staff intervention and clinical suitability questions still block automated offers", () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  const staffed = h.map(t => ({ ...t }));
  staffed[7] = { ...staffed[7], pricingStaffAuthored: true,
    content: "[Verified STAFF message] " + staffed[7].content };
  assert.equal(price(staffed, now).approval.decision, null);
  const clinical = h.map(t => ({ ...t }));
  clinical[clinical.length - 1] = { ...clinical.at(-1),
    content: "刚生产两周，我可以做骨盆调理吗？价格多少？" };
  assert.equal(price(clinical, now).approval.decision, null);
});

test("expired, untimestamped or interrupted conversations cannot authorize a price", () => {
  const now = new Date("2026-11-12T11:15:00.000Z").getTime();
  const h = history(now);
  assert.equal(price(h.map(t => ({ role: t.role, content: t.content })), now)
    .approval.decision, null);
  assert.equal(price(h.map(t => ({
    ...t, pricingCreatedAtMs: t.pricingCreatedAtMs - 25 * 60 * 60 * 1000,
  })), now).approval.decision, null);
  const interrupted = h.map(t => ({ ...t }));
  interrupted[8] = { ...interrupted[8], content: "改聊3D小颜术，我想问这个。" };
  assert.equal(price(interrupted, now).approval.decision, null);
});
