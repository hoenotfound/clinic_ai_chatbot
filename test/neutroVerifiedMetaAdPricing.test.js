"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedMetaAdPriceAnchor, resolveAiPricingDecision } =
  require("../src/utils/aiPricingIntentDecision");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const now = Date.now();
const services = [
  { name: "骨盆调理", priceRange: "" },
  { name: "徒手体态调理", priceRange: "" },
  { name: "9D 逆龄抗衰", priceRange: "" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆矫正", officialService: "骨盆调理" },
  { alias: "盆骨", officialService: "骨盆调理" },
  { alias: "整骨", officialService: "徒手体态调理" },
  { alias: "徒手整骨", officialService: "徒手体态调理" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理",
  sendOnPriceQuery: true, validFrom: "2000-01-01",
  validUntil: "2999-12-31",
  packages: [
    { name: "Package A", imageUrl: "https://example.test/pelvic-a.jpg",
      caption: "原价 RM488 优惠后仅需 RM388",
      pricing: { currency: "MYR", offer: 388, normal: 488 } },
    { name: "Package B", imageUrl: "https://example.test/pelvic-b.jpg",
      caption: "原价 RM388 现在只需 RM268",
      pricing: { currency: "MYR", offer: 268, normal: 388 } },
  ],
}, {
  name: "9D First Trial", linkedService: "9D 逆龄抗衰",
  sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
  imageUrl: "https://example.test/9d.jpg",
  caption: "9D First Trial 现在只需 RM488（原价 RM1288）",
  pricing: { currency: "MYR", offer: 488, normal: 1288 },
}];
const resultMedia = [{
  service: "骨盆调理", relatedServices: ["徒手体态调理"], enabled: true,
}];
const ad = {
  serviceHint: "骨盆调理",
  serviceHintSource: "ad_name",
  attributedAt: new Date(now - 12 * 60 * 1000).toISOString(),
  headline: "徒手整骨｜从头到脚🦶",
  body: "今天来了一位小姐姐做骨盆矫正评估，骨盆前倾，腰酸背痛，欢迎预约评估！",
};
const turn = (role, content, before) => ({
  role, content, pricingCreatedAtMs: now - before,
});
const jinfei = [
  turn("user", "halo请问整骨价钱是怎么算呢", 11 * 60 * 1000),
  turn("assistant", "我们先做免费的体态评估+体验，具体调理需先了解体态", 10 * 60 * 1000),
  turn("user", "我比较困扰腰酸 还有驼背 感觉背后很重", 7 * 60 * 1000),
  turn("assistant", "中医师可以先了解你的姿势和背部情况", 6 * 60 * 1000),
  turn("user", "在pj哪里呀", 60 * 1000),
  turn("assistant", "我们在 Dataran 3 Two Business Centre, Petaling Jaya", 40 * 1000),
  turn("user", "通常一个疗程多少钱呢", 1000),
];
const input = (text, history, extra = {}) => ({
  customerText: text, conversationHistory: history, services, serviceAliases,
  promotions, metaAdContext: ad, now, ...extra,
});
const shadow = (text, history, extra = {}) => resolveShadowPriceException(
  input(text, history, { allowVerifiedAdPricing: true,
    allowOfferEnquiries: true, ...extra })
);
const approve = (text, history, decision, extra = {}) =>
  resolveApprovedPricingAssessment(input(text, history, {
    mode: "shadow", shadowException: decision, allowVerifiedAdPricing: true,
    resultMedia, ...extra,
  }));

test("contact #9185: generic session fee follows verified pelvic ad, both current prices", async () => {
  const text = "通常一个疗程多少钱呢";
  const anchor = verifiedMetaAdPriceAnchor(input(text, jinfei, {
    allowCreativeEcho: true,
  }));
  assert.equal(anchor?.treatment, "骨盆调理");
  assert.ok(anchor.creativeEchoServices.includes("徒手体态调理"));
  const decision = shadow(text, jinfei);
  assert.equal(decision?.source, "meta_ad");
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices.map(p => p.price), ["RM388", "RM268"]);
  const approved = approve(text, jinfei, decision);
  assert.equal(approved.reason, "approved");
  const images = await resolvePricePromotionForReply({
    priceQuery: true, packageQuery: false,
    pricingDecision: approved.decision, aiPricingEnabled: true,
    treatment: "骨盆调理",
    verifiedServiceFromText: "骨盆调理",
    verifiedShadowPriceService: "骨盆调理",
    customerText: text, conversationHistory: jinfei,
    services, serviceAliases, promotions, resultMedia,
    language: "zh", contactId: 9185, textSendSucceeded: true,
    flagged: false, bookingReady: false, needsAttention: false,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
  });
  assert.deepEqual(images?.packages.map(p => p.imageUrl),
    ["https://example.test/pelvic-a.jpg", "https://example.test/pelvic-b.jpg"]);
});

test("initial ad enquiry can reference the actual headline 徒手整骨", () => {
  const text = "halo请问整骨价钱是怎么算呢";
  const history = [turn("user", text, 1000)];
  const selected = shadow(text, history);
  assert.equal(selected?.treatment, "骨盆调理");
  assert.deepEqual(selected?.prices.map(p => p.price), ["RM388", "RM268"]);
  assert.equal(approve(text, history, selected).reason, "approved");
});

test("a specifically customer-selected new paid service overrides old ad", () => {
  const text = "9D多少钱？";
  const history = [
    turn("user", "想了解整骨", 100000),
    turn("assistant", "可以先评估", 95000),
    turn("user", text, 1000),
  ];
  assert.equal(verifiedMetaAdPriceAnchor(input(text, history, {
    allowCreativeEcho: true,
  })), null);
  const decision = shadow(text, history);
  assert.notEqual(decision?.treatment, "骨盆调理");
  const enabled = resolveAiPricingDecision(input(text, history, {
    priceQuery: true, allowVerifiedAdPricing: true,
  }));
  assert.notEqual(enabled?.treatment, "骨盆调理");
});

test("Meta ad must be recent, priced, uniquely identifiable and creative-matched", () => {
  const text = "通常一个疗程多少钱呢", hist = jinfei;
  const variants = [
    { ...ad, attributedAt: null },
    { ...ad, attributedAt: new Date(now - 8*24*3600*1000).toISOString() },
    { ...ad, serviceHintSource: "crm" },
    { ...ad, serviceHint: "Unknown" },
    { ...ad, body: "只有徒手整骨，没有具体治疗项目" },
    { ...ad, body: ad.body + " 9D逆龄抗衰也有优惠" },
    null,
  ];
  for(const metaAdContext of variants) {
    const found = verifiedMetaAdPriceAnchor(input(text, hist, {
      metaAdContext, allowCreativeEcho: true,
    }));
    assert.equal(found, null, String(metaAdContext?.body));
  }
});

test("a different unpriced specific body treatment is not priced as pelvis", () => {
  const text = "通常一个疗程多少钱呢";
  const history = [
    turn("user", "我想了解筋膜放松，肩颈", 60000),
    turn("assistant", "需要先了解你的身体情况", 58000),
    turn("user", text, 1000),
  ];
  assert.equal(shadow(text, history)?.treatment, undefined);
});

test("booking, staff, clinical, consent, review and delivery gates remain closed", async () => {
  const price = "通常一个疗程多少钱呢";
  for(const current of [
    "通常一个疗程需要做多久", "我怀孕了，骨盆多少钱？",
    "有优惠以后发我看看", "别发促销了", "你们停车收费吗",
    "现在有肩颈筋膜放松多少钱",
  ]) {
    const history = [...jinfei.slice(0,-1),turn("user",current,1000)];
    assert.equal(verifiedMetaAdPriceAnchor(input(current, history, {
      allowCreativeEcho: true,
    })),null,current);
  }
  const staff = [
    turn("user", "想了解整骨", 60000),
    { ...turn("assistant", "员工已经跟进", 10000), pricingStaffAuthored: true },
    turn("user", price, 1000),
  ];
  assert.equal(shadow(price,staff),null);
  const selected=shadow(price,jinfei);
  assert.equal(approve(price,jinfei,selected,{flagged:true}).reason,"review_or_booking");
  assert.equal(approve(price,jinfei,selected,{bookingReady:true}).reason,"review_or_booking");
  assert.equal(approve(price,jinfei,selected,{marketingStopQuestion:true}).reason,"marketing_opt_out");
  assert.equal(approve(price,jinfei,{ ...selected,treatment:"9D 逆龄抗衰" }).reason,"meta_ad_price_context_unverified");
  for(const receipt of [true]) {
    const images=await resolvePricePromotionForReply({
      priceQuery:true,pricingDecision:selected,aiPricingEnabled:true,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      customerText:price,conversationHistory:jinfei,services,serviceAliases,
      promotions,resultMedia,contactId:9185,language:"zh",
      flagged:false,bookingReady:false,needsAttention:false,
      textSendSucceeded:true,wasPromoRecentlySent:async()=>receipt,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(images,null);
  }
});

test("generic ad headline exception is disabled by default for other clinics", () => {
  const price="通常一个疗程多少钱呢";
  assert.equal(verifiedMetaAdPriceAnchor(input(price,jinfei)),null);
  assert.equal(shadow(price,jinfei,{allowVerifiedAdPricing:false}),null);
});
