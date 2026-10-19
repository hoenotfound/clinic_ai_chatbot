"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { guardUnconfirmedMediaPromise } = require("../src/utils/unconfirmedMediaPromiseGuard");
const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { hasCurrentPriceAmountRequest } = require("../src/utils/aiPricingIntentDecision");

const now = Date.now();
const services = [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }];
const aliases = [{ alias: "3D", officialService: "3D 小颜术" }, { alias: "9D", officialService: "9D 逆龄抗衰" }];
const promotions = [{
  name: "3D 小颜术 First Trial",
  linkedService: "3D 小颜术",
  validFrom: "2000-01-01",
  validUntil: "2999-12-31",
  sendOnPriceQuery: true,
  pricing: { currency: "MYR", offer: 488, normal: 888 },
  imageUrl: "https://example.test/promo-images/32",
  caption: "Safe 3D introduction; suitability assessed in person.",
  followUpMessage: "限时优惠！只需要 RM 4️⃣8️⃣8️⃣（原价 RM888）",
}];
const turn = (role, content, age, staff = false) => ({
  role, content, pricingCreatedAtMs: now - age,
  pricingStaffAuthored: staff,
});
const amanda = () => [
  turn("user", "Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～", 12 * 3600_000),
  turn("user", "Price", 12 * 3600_000 - 5000),
  turn("assistant", "3D 小颜术是徒手护理", 12 * 3600_000 - 10_000),
  turn("assistant", "The current 3D 小颜术 package prices are: RM488 😊", 12 * 3600_000 - 15_000),
  turn("assistant", "[Follow-up automation] 问一下脸型的困扰", 4 * 3600_000),
  turn("assistant", "[Follow-up automation] 3D 服务视频", 60_000),
  turn("user", "Rm488 for one time?", 1000),
];
const args = overrides => ({
  customerText: "Rm488 for one time?",
  conversationHistory: amanda(),
  services, serviceAliases: aliases, promotions,
  now, complimentaryAssessmentExperienceEnabled: true,
  ...overrides,
});

test("Amanda #567: recent previously quoted RM488 confirms one 3D session", async () => {
  const decision = resolveShadowPriceException(args());
  assert.equal(decision?.source, "confirmed_prior_quote");
  assert.equal(decision?.treatment, "3D 小颜术");
  assert.deepEqual(decision?.prices.map(x => x.price), ["RM488"]);

  const approval = resolveApprovedPricingAssessment({
    mode: "shadow", shadowException: decision,
    ...args(), resultMedia: [], now,
  });
  assert.equal(approval.reason, "approved");
  const quote = ensureVerifiedPriceReply({
    ...args(), reply: "Which treatment would you like the price for?",
    treatment: approval.decision.treatment,
    pricingDecision: approval.decision,
    language: "en", priceOnlyResponse: true,
  });
  assert.match(quote.reply, /Yes, RM488 is the current price for one 3D 小颜术 session/u);
  assert.doesNotMatch(quote.reply, /Which treatment|send.*image/iu);

  const prior = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = { ...prior, assessmentFirstPricingEnabled: true };
  try {
    const media = await resolvePricePromotionForReply({
      ...args(), aiPricingEnabled: true, pricingDecision: approval.decision,
      treatment: approval.decision.treatment, verifiedServiceFromText: approval.decision.treatment,
      priceQuery: true, flagged: false, bookingReady: false, keywordReason: null,
      needsAttention: false, textSendSucceeded: true,
      contactId: 567, wasPromoRecentlySent: async () => true,
      hasUnconfirmedMediaDelivery: async () => false,
    });
    assert.equal(media, null, "already accepted image must not be resent");
  } finally {
    clinicConfig.automatedFollowUp = prior;
  }
});

test("quoted-price confirmations fail closed on missing proof, staff, stale context or treatment change", () => {
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: [turn("user", "Rm488 for one time?", 1000)],
  })), null, "ad/CRM label is not a quote");
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: amanda().map(item =>
      item.role === "assistant" && String(item.content).includes("RM488")
        ? { ...item, content: "The current 3D 小颜术 package prices are RM888" } : item),
  })), null, "must have quoted the exact current amount");
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: [
      ...amanda().slice(0, -1),
      turn("assistant", "[Verified STAFF message] I answered", 2000, true),
      turn("user", "Rm488 for one time?", 1000),
    ],
  })), null, "staff handoff breaks verified quote context");
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: amanda().map((item, index) =>
      index === 0 ? { ...item, pricingCreatedAtMs: now - 30 * 3600_000 } : item),
  })), null, "price quote cannot cross a stale session");
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: [
      ...amanda().slice(0, -1),
      turn("user", "现在想了解 9D 逆龄抗衰", 1500),
      turn("assistant", "9D 是仪器类护理", 1400),
      turn("user", "Rm488 for one time?", 1000),
    ],
  })), null, "new service must not reuse 3D amount");
  assert.equal(resolveShadowPriceException(args({
    conversationHistory: amanda().map((item, i) =>
      i === 6 ? { ...item, content: "RM999 for one time?" } : item),
  })), null, "amount must match current configured promotion");
});

test("Siew Siew #517: do not promise images that have not been accepted", () => {
  for (const reply of [
    "好的，骨盆调理限时配套内容发给你参考看看哦～",
    "目前骨盆调理有配套优惠哦 😊 详情发给你参考～",
    "I will send you the package details 😊",
    "我们目前的骨盆调理限时优惠配套有这两种：",
  ]) {
    const guarded = guardUnconfirmedMediaPromise(reply, "zh");
    assert.equal(guarded.changed, true, reply);
    assert.doesNotMatch(guarded.reply, /发给你|send you|有这两种：/iu);
    assert.ok(guarded.reply);
  }
  const factual = "骨盆调理套餐 A 为 RM388，套餐 B 为 RM288。";
  assert.deepEqual(guardUnconfirmedMediaPromise(factual, "zh"), {
    reply: factual, changed: false,
  });
});

test("Sharon #537: first-trial amount question is an explicit pricing enquiry", () => {
  const question = "请问首次体验是多少呢";
  assert.equal(hasExplicitPriceRequest(question), true);
  assert.equal(hasCurrentPriceAmountRequest(question), true);
  assert.equal(hasExplicitPriceRequest("请问首次体验需要多久呢"), false);
  assert.equal(hasCurrentPriceAmountRequest("第一次体验要做几次"), false);
  assert.equal(hasExplicitPriceRequest("以后有优惠 WhatsApp 发我"), false);
});

test("Siew Siew #517: 'Package?' after verified 骨盆 enquiry selects both current graphics", async () => {
  const pelvicServices = [{ name:"骨盆调理" },...services];
  const pelvicAliases = [{alias:"骨盆",officialService:"骨盆调理"},...aliases];
  const pelvicPromotion = {
    name:"骨盆调理套餐",linkedService:"骨盆调理",sendOnPriceQuery:true,
    validFrom:"2000-01-01",validUntil:"2999-12-31",
    packages:[
      {name:"Package A",imageUrl:"https://example.test/30",
        caption:"本月限时优惠，原价优惠 RM488，优惠后仅需 RM388"},
      {name:"Package B",imageUrl:"https://example.test/31",
        caption:"本月限时优惠，原价 RM388，现在只需 RM288"},
    ],
  };
  const customer = turn("user",
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊", 90000);
  const history = [customer,
    turn("assistant","骨盆调理是一项徒手护理。",85000),
    turn("assistant","骨盆调理 Before & After",80000),
    turn("user","Package?",1000)];
  const params = {customerText:"Package?",conversationHistory:history,
    services:pelvicServices,serviceAliases:pelvicAliases,
    promotions:[pelvicPromotion],now};
  const decision = resolveShadowPriceException(params);
  assert.equal(decision?.source,"direct_customer_package_request");
  assert.deepEqual(decision?.prices.map(p=>p.price),["RM388","RM288"]);
  const approved = resolveApprovedPricingAssessment({
    mode:"shadow",shadowException:decision,...params,resultMedia:[],
  });
  assert.equal(approved.reason,"approved");
  const quoted = ensureVerifiedPriceReply({
    ...params,treatment:approved.decision.treatment,
    pricingDecision:approved.decision,reply:"I will send the details",
    language:"en",priceOnlyResponse:true,
  });
  assert.match(quoted.reply,/Package A.*RM388/su);
  assert.match(quoted.reply,/Package B.*RM288/su);
  const prior=clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp={...prior,assessmentFirstPricingEnabled:true};
  try {
    const media=await resolvePricePromotionForReply({
      ...params,aiPricingEnabled:true,pricingDecision:approved.decision,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      contactId:517,language:"zh",textSendSucceeded:true,
      flagged:false,bookingReady:false,keywordReason:null,needsAttention:false,
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.deepEqual(media?.packages.map(p=>p.name),["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...params,aiPricingEnabled:true,pricingDecision:approved.decision,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      contactId:517,language:"zh",textSendSucceeded:true,
      wasPromoRecentlySent:async()=>true,
      hasUnconfirmedMediaDelivery:async()=>false,
    }),null,"never resend accepted graphics");
  } finally { clinicConfig.automatedFollowUp=prior; }

  assert.equal(resolveShadowPriceException({
    ...params,conversationHistory:[
      customer,turn("assistant","[Verified STAFF message] 骨盆调理",10000,true),
      turn("user","Package?",1000),
    ],
  }),null,"a staff reply blocks package selection");
  assert.equal(resolveShadowPriceException({
    ...params,conversationHistory:[turn("user","Hi～",90000),
      turn("assistant","你可以了解骨盆调理",85000),
      turn("user","Package?",1000)],
  }),null,"ad and AI text alone cannot select a treatment");
  assert.equal(resolveShadowPriceException({
    ...params,conversationHistory:history.slice(0,-1).concat(
      turn("user","有优惠的话以后再通知",1000)),
    customerText:"有优惠的话以后再通知",
  }),null,"future marketing permission cannot trigger current graphics");
});

test("9D legacy 90% collagen graphic remains blocked even if its price is verified", async () => {
  const prior = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp={...prior,assessmentFirstPricingEnabled:true};
  try {
    const promotion={
      name:"9D First Trial", linkedService:"9D 逆龄抗衰",
      validFrom:"2000-01-01",validUntil:"2999-12-31",
      sendOnPriceQuery:true,imageUrl:"https://example.test/promo-images/21",
      pricing:{offer:488,normal:1288,currency:"MYR"},
      caption:"Stimulate and restore 90% of collagen",
      followUpMessage:"🎊 限时优惠，只需要 RM488，原价 RM1,288",
    };
    let skipReason=null;
    const candidate={
      type:"price",treatment:"9D 逆龄抗衰",prices:[
        {name:"Main offer",price:"RM488"}],
    };
    const media=await resolvePricePromotionForReply({
      customerText:"9D 价格多少",conversationHistory:[
        turn("user","9D 价格多少",1000)],
      aiPricingEnabled:true,pricingDecision:candidate,
      treatment:"9D 逆龄抗衰",verifiedServiceFromText:"9D 逆龄抗衰",
      contactId:537,textSendSucceeded:true,flagged:false,
      bookingReady:false,keywordReason:null,needsAttention:false,
      services,serviceAliases:aliases,promotions:[promotion],resultMedia:[],
      onSkip:reason=>{skipReason=reason},
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(media,null);
    assert.equal(skipReason,"unverified_clinical_promo_copy");
  } finally { clinicConfig.automatedFollowUp=prior; }
});
