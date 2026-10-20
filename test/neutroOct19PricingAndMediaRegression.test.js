"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { resolveShadowPriceException, resolvePreviouslyQuotedSessionPrice } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply, verifiedPricesForService } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { guardUnconfirmedMediaPromise, claimsMediaWasOrWillBeSent } = require("../src/utils/unconfirmedMediaPromiseGuard");
const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { hasCurrentPriceAmountRequest } = require("../src/utils/aiPricingIntentDecision");
const { promotionHasUnsafeClinicalCopy } = require("../src/utils/promotionClinicalCopyPolicy");

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
  assert.match(quote.reply, /current 3D 小颜术 package offer is RM488/u);
  assert.match(quote.reply, /centre can confirm how many sessions are included/u);
  assert.doesNotMatch(quote.reply, /covers one session|price for one .* session/iu);
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
    promotions:[pelvicPromotion],allowOfferEnquiries:true,now};
  const decision = resolveShadowPriceException(params);
  assert.equal(decision?.source,"direct_customer_package_request");
  assert.equal(decision?.type,"package_options");
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


test("Package-only pricing respects the opt-in and supports bounded multi-turn discussions", () => {
  const pelvicServices=[{name:"骨盆调理"},{name:"3D 小颜术"}];
  const aliases=[{alias:"骨盆",officialService:"骨盆调理"}, {alias:"3D",officialService:"3D 小颜术"}];
  const promotion={
    name:"骨盆 A/B",linkedService:"骨盆调理",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    packages:[
      {name:"Package A",caption:"优惠后仅需 RM388",imageUrl:"https://example.test/a"},
      {name:"Package B",caption:"现在只需 RM288",imageUrl:"https://example.test/b"},
    ],
  };
  const opening=turn("user","我想了解骨盆调理",80000);
  const reply=turn("assistant","骨盆调理是徒手体态护理。",75000);
  const bridge=turn("user","有什么效果？",35000);
  const followup=turn("assistant","会先让中医师了解情况，评估适合的护理。",30000);
  const ask=turn("user","Package?",1000);
  const args={customerText:"Package?",conversationHistory:[opening,reply,bridge,followup,ask],
    services:pelvicServices,serviceAliases:aliases,promotions:[promotion],now};
  assert.equal(resolveShadowPriceException({...args,allowOfferEnquiries:false}),null,
    "disabled package-only setting cannot be bypassed");
  const allowed=resolveShadowPriceException({...args,allowOfferEnquiries:true});
  assert.equal(allowed?.source,"direct_customer_package_request");
  assert.deepEqual(allowed.prices.map(item=>item.price),["RM388","RM288"]);
  assert.equal(resolveApprovedPricingAssessment({
    mode:"shadow",shadowException:allowed,...args,
    allowOfferEnquiries:false,
  }).decision,null,"approval must independently check opt-in");
  assert.equal(resolveApprovedPricingAssessment({
    mode:"shadow",shadowException:allowed,...args,
    allowOfferEnquiries:true,
  }).reason,"approved");

  const changed={...args,allowOfferEnquiries:true};
  const end=turn("user","Package?",1000);
  assert.equal(resolveShadowPriceException({
    ...changed,conversationHistory:[opening,reply,
      turn("user","另外想了解3D",35000),
      turn("assistant","3D 是脸部护理",30000),end],
  }),null,"service switch cannot reuse pelvic pricing");
  assert.equal(resolveShadowPriceException({
    ...changed,conversationHistory:[opening,reply,
      turn("user","先不聊这个",35000),
      turn("assistant","好的",30000),end],
  }),null,"topic reset cannot reuse earlier selection");
  assert.equal(resolveShadowPriceException({
    ...changed,conversationHistory:[opening,reply,
      turn("assistant","[Verified STAFF message] 请问需要帮助吗？",36000,true),
      bridge,followup,end],
  }),null,"staff interruption cannot be crossed");
  assert.equal(resolveShadowPriceException({
    ...changed,conversationHistory:[opening,reply,
      turn("user","地址",35000),
      turn("assistant","我们在PJ",30000),end],
  }),null,"unrelated topic cannot carry the old offer");
  assert.equal(resolveShadowPriceException({
    ...changed,conversationHistory:[opening,reply,
      ...Array.from({length:5},(_,i)=>[
        turn("user","有什么效果？",25000-4000*i),
        turn("assistant","请让中医师评估",24000-4000*i),
      ]).flat(),end],
  }),null,"max four previous customer turns");
});

test("A bare amount is not a confirmation; exact multi-package price resolves just one item", () => {
  const history=amanda();
  const bare=[...history.slice(0,-1),turn("user","RM488",1000)];
  assert.equal(resolveShadowPriceException(args({
    customerText:"RM488",conversationHistory:bare,
  })),null);
  const pelvicServices=[{name:"骨盆调理"}];
  const pelvicAliases=[{alias:"骨盆",officialService:"骨盆调理"}];
  const pelvicPromotion={
    name:"骨盆调理套餐",linkedService:"骨盆调理",sendOnPriceQuery:true,
    validFrom:"2000-01-01",validUntil:"2999-12-31",
    packages:[
      {name:"Package A",caption:"优惠后仅需 RM388",imageUrl:"https://example.test/a"},
      {name:"Package B",caption:"现在只需 RM288",imageUrl:"https://example.test/b"},
    ],
  };
  const argsPelvis={
    customerText:"RM388 for one time?",
    conversationHistory:[
      turn("user","想了解骨盆调理",18000),
      turn("assistant","骨盆调理的配套价格：Package A RM388，Package B RM288",17000),
      turn("user","RM388 for one time?",1000)],
    services:pelvicServices,serviceAliases:pelvicAliases,
    promotions:[pelvicPromotion],now,
  };
  const decision=resolveShadowPriceException(argsPelvis);
  assert.equal(decision?.source,"confirmed_prior_quote");
  assert.deepEqual(decision?.prices.map(item=>[item.name,item.price]),
    [["Package A","RM388"]]);
  const quote=ensureVerifiedPriceReply({
    ...argsPelvis,treatment:"骨盆调理",pricingDecision:decision,
    reply:"Our packages are available",language:"en",
  });
  assert.match(quote.reply,/Package A.*session/u);
  assert.doesNotMatch(quote.reply,/RM288|Package B/u);
  const ambiguous={...pelvicPromotion,packages:[
    ...pelvicPromotion.packages,
    {name:"Package C",caption:"优惠后仅需 RM388",imageUrl:"https://example.test/c"},
  ]};
  assert.equal(resolveShadowPriceException({
    ...argsPelvis,promotions:[ambiguous],
  }),null,"shared amount across packages must not be guessed");
});

test("Price confirmations do not authorize another promotional graphic", async () => {
  const decision=resolveShadowPriceException(args());
  assert.ok(decision);
  let skipped=null;
  const media=await resolvePricePromotionForReply({
    ...args(),aiPricingEnabled:true,pricingDecision:decision,
    treatment:decision.treatment,verifiedServiceFromText:decision.treatment,
    priceQuery:true,contactId:567,textSendSucceeded:true,
    onSkip:reason=>{skipped=reason;},
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
  });
  assert.equal(media,null);
  assert.equal(skipped,"price_confirmation_no_new_graphic");
});

test("Multilingual media guard removes false past/present claims and preserves independent facts",()=>{
  const cases=[
    ["骨盆套餐 A 是 RM388，我已经把优惠图发过去了","RM388"],
    ["我们今天有优惠。图片我已经发给你了","我们今天有优惠"],
    ["骨盆套餐 B 是 RM288，配套内容发给你看看","RM288"],
    ["3D trial is RM488. I'll send you the package details now","RM488"],
    ["Harga RM388. Saya akan hantar gambar promosi","RM388"],
    ["我已经把优惠图发过去了",null],
  ];
  for(const [reply,fact] of cases){
    const outcome=guardUnconfirmedMediaPromise(reply,"zh");
    assert.equal(outcome.changed,true,reply);
    assert.doesNotMatch(outcome.reply,/发过去了|发给你|send you|hantar gambar/iu);
    if(fact)assert.match(outcome.reply,new RegExp(fact));
  }
});

test("Unsafe copy is blocked across translated promotions and promotional follow-up variants",()=>{
  assert.equal(promotionHasUnsafeClinicalCopy({
    caption:"Normal treatment copy",followUpMessage:"Normal price copy",
    mediaTranslations:{en:{caption:"restore 90% of collagen"}},
  }),true);
  assert.equal(promotionHasUnsafeClinicalCopy({
    caption:"Normal copy",followUpTranslations:{ms:"no side effects"},
  }),true);
  assert.equal(promotionHasUnsafeClinicalCopy({
    caption:"We cannot guarantee results. Ask the practitioner.",
  }),false);
});


test("Money with thousands separators survives media-claim cleanup", () => {
  for (const source of [
    "9D original price RM1,288. I'll send the graphic.",
    "原价 RM1,288，优惠后 RM488，我把优惠图发给你。",
    "原价 RM1,288, I'll share the picture.",
    "The current offer is RM1,288, I'll send the picture.",
  ]) {
    const result = guardUnconfirmedMediaPromise(source, "en");
    assert.equal(result.changed, true, source);
    assert.ok(result.reply.includes("RM1,288"), result.reply);
    assert.doesNotMatch(result.reply, /RM1,\n288/u);
    assert.doesNotMatch(result.reply, /send the (?:picture|graphic)|发给你/iu);
  }
  const untouched = "Normal RM1,288, trial RM488.";
  assert.deepEqual(guardUnconfirmedMediaPromise(untouched, "en"), {
    reply: untouched, changed: false,
  });
});

test("RM488? confirms only the verified amount, not an invented session count", () => {
  const history = [
    ...amanda().slice(0, -1), turn("user", "RM488?", 1000),
  ];
  const decision = resolveShadowPriceException(args({
    customerText: "RM488?", conversationHistory: history,
  }));
  assert.equal(decision?.source, "confirmed_prior_quote");
  const reply = ensureVerifiedPriceReply({
    customerText: "RM488?", reply: "Is the price still correct?",
    treatment: "3D 小颜术", pricingDecision: decision,
    services, serviceAliases: aliases, promotions, conversationHistory: history,
    language: "en",
  });
  assert.match(reply.reply, /current .* package offer is RM488/iu);
  assert.doesNotMatch(reply.reply, /one session|how many sessions|per session/iu);
});

test("Exactly one-session wording requires structured promotion evidence", () => {
  const explicit = promotions.map(item => ({
    ...item, pricing: {...item.pricing, sessionsIncluded: 1},
  }));
  const one = resolveShadowPriceException(args({promotions: explicit}));
  assert.equal(one.prices[0].sessionsIncluded, 1);
  const quoted = ensureVerifiedPriceReply({
    ...args({promotions: explicit}), treatment: one.treatment,
    pricingDecision: one, reply: "Which treatment?", language: "en",
  });
  assert.match(quoted.reply, /package covers one session/u);

  const two = resolveShadowPriceException(args({
    promotions: promotions.map(item => ({
      ...item, pricing: {...item.pricing, sessionsIncluded: 2},
    })),
  }));
  const multi = ensureVerifiedPriceReply({
    ...args(), treatment: two.treatment, pricingDecision: two,
    reply: "Which treatment?", language: "en",
  });
  assert.match(multi.reply, /package covers 2 sessions/u);
  assert.doesNotMatch(multi.reply, /one session/u);
});

test("Risk disclaimers remain allowed while positive guarantees are blocked", () => {
  const { hasUnsafeClinicalPromotionCopy } =
    require("../src/utils/promotionClinicalCopyPolicy");
  for (const safe of [
    "We cannot guarantee no side effects.",
    "We do not guarantee no side effects.",
    "We cannot guarantee 90% collagen recovery.",
    "不能保证完全无痛或没有风险。",
    "我们无法保证无副作用，需由中医师评估。",
    "We cannot guarantee results. Each customer is different.",
  ]) {
    assert.equal(hasUnsafeClinicalPromotionCopy(safe), false, safe);
    assert.equal(promotionHasUnsafeClinicalCopy({caption: safe}), false, safe);
  }
  for (const unsafe of [
    "There are no side effects.",
    "We guarantee no side effects.",
    "Guaranteed results for every customer.",
    "Fully restore 90% collagen.",
    "我们的疗程完全无痛。",
    "这个护理无副作用。",
    "不能保证无副作用。但是这项护理无副作用。",
    "We cannot guarantee no side effects. Our treatment has no side effects.",
    "We cannot guarantee 90% collagen, but we will restore 90% collagen.",
  ]) {
    assert.equal(hasUnsafeClinicalPromotionCopy(unsafe), true, unsafe);
  }
  assert.equal(promotionHasUnsafeClinicalCopy({
    mediaTranslations: {
      en: {caption: "We cannot guarantee no side effects."},
    },
    followUpMessage: "护理完全无痛。",
  }), true, "a harmless disclaimer must not excuse another unsafe claim");
});


test("Chinese photo and skin descriptions are not mistaken for image-send promises", () => {
  const descriptions = [
    "这张图片可以看到脸部稍微发红了。",
    "图片里脸部有点发红了，实际状况要评估。",
    "这张图片发红了，给你参考。",
    "这张图片发炎了。",
    "我发现图片的颜色偏红。",
    "我们把发红的图片拍下来供中医师评估。",
    "有个客户分享说发炎了，看图片可见。",
    "照片已经发黄了，需要检查。",
    "我们看到发红的皮肤图片。",
    "这张照片是发炎时拍的，不代表治疗效果。",
    "图片可以看到皮肤发红了，是否适合护理需要评估。",
    "皮肤发炎了，建议先咨询合资格医疗专业人员。",
    "这个配套内容会免费送给你1小时经络按摩。",
    "我们的套餐内容包括免费送给你全身通淋巴按摩。",
  ];
  for (const reply of descriptions) {
    assert.deepEqual(guardUnconfirmedMediaPromise(reply, "zh"), {
      reply, changed: false,
    }, reply);
  }
  assert.equal(claimsMediaWasOrWillBeSent(
    "这张图片可以看到脸部稍微发红了。"
  ), false);
});

test("Chinese genuine image-send promises are still removed before optional media", () => {
  const claims = [
    "好的，骨盆调理限时配套内容发给你参考看看哦～",
    "我们把优惠图发给你参考。",
    "图片我已经发给你了。",
    "我已经把优惠图发过去了。",
    "我会发优惠图。",
    "我给你发图片。",
    "配套详情我发给你。",
    "图片已经发了。",
    "我已经把图片发出去。",
    "现在我会分享配套资料。",
    "资料我刚才转发了。",
  ];
  for (const text of claims) {
    assert.equal(claimsMediaWasOrWillBeSent(text), true, text);
    const guarded = guardUnconfirmedMediaPromise(text, "zh");
    assert.equal(guarded.changed, true, text);
    assert.ok(guarded.reply);
    assert.notEqual(guarded.reply, text);
  }

  const mixed = "骨盆调理套餐 A 目前 RM388，图片我已经发给你了。";
  const cleaned = guardUnconfirmedMediaPromise(mixed, "zh");
  assert.equal(cleaned.changed, true);
  assert.match(cleaned.reply, /骨盆调理套餐 A 目前 RM388/u);
  assert.doesNotMatch(cleaned.reply, /已经发给你/u);
  const withNormalPrice = "9D 的原价是 RM1,288，皮肤发红了请先让中医师评估。";
  assert.deepEqual(guardUnconfirmedMediaPromise(withNormalPrice, "zh"), {
    reply: withNormalPrice, changed: false,
  });
});


test("Complimentary treatment gifts are not attachment-send claims", () => {
  const cases = [
    "这个配套内容会免费送给你1小时经络按摩。",
    "我们的套餐内容包括免费送给你全身通淋巴按摩。",
    "优惠配套内含赠送经络按摩，护理详情可由中医师评估。",
  ];
  for (const reply of cases) {
    assert.equal(claimsMediaWasOrWillBeSent(reply), false, reply);
    assert.deepEqual(guardUnconfirmedMediaPromise(reply, "zh"), {
      reply, changed: false,
    });
  }
  const imagePromise = "我现在发送配套图片给你参考。";
  assert.equal(claimsMediaWasOrWillBeSent(imagePromise), true);
  assert.equal(guardUnconfirmedMediaPromise(imagePromise, "zh").changed, true);
});


test("Chinese development or publication news is not an attachment-send claim", () => {
  const descriptions = [
    "我们正在开发新的配套内容。",
    "我们下个月会发布最新配套资料。",
    "我们计划研发配套内容，等确认再公布。",
    "我们将会发布新的套餐详情。",
    "我们已经发布配套照片到主页了。",
    "我们会继续研发新套餐，后续以门店公告为准。",
  ];
  for (const reply of descriptions) {
    assert.equal(claimsMediaWasOrWillBeSent(reply), false, reply);
    assert.deepEqual(guardUnconfirmedMediaPromise(reply, "zh"), {
      reply, changed: false,
    }, reply);
  }

  const sendPromises = [
    "我们会发新的配套优惠图给你参考。",
    "现在我会发送配套图给你。",
    "我们会分享新的配套资料。",
    "配套图片已经发给你了。",
  ];
  for (const source of sendPromises) {
    assert.equal(claimsMediaWasOrWillBeSent(source), true, source);
    const guarded = guardUnconfirmedMediaPromise(source, "zh");
    assert.equal(guarded.changed, true, source);
    assert.notEqual(guarded.reply, source);
  }
  const mixed = "我们正在开发新的配套内容。图片我已经发给你了。";
  const fixed = guardUnconfirmedMediaPromise(mixed, "zh");
  assert.equal(fixed.changed, true);
  assert.match(fixed.reply, /我们正在开发新的配套内容/u);
  assert.doesNotMatch(fixed.reply, /已经发给你/u);
});



test("Chinese image references, publication and negation never become delivery promises", () => {
  const factual = [
    "我们分享的图片只是教学参考。",
    "我们发表有关配套内容的声明。",
    "我们不发图，只想介绍配套资料。",
    "我们不发优惠图给你。",
    "我们不会发送图片给你。",
    "我们还没发优惠图给你。",
    "我们没有把图片发过去。",
    "我们不是发图片给你，而是在解释护理内容。",
    "我们已经分享的图片只是教学参考。",
    "我们只是分享了临床案例图片，不是发给你。",
    "我们下个月会发布最新配套资料。",
    "我们正在开发新的配套内容。",
    "我们分享图片作为护理示例。",
    "图片里的皮肤发红了，需要先评估。",
    "配套 RM388，图片仅供介绍，不代表实际效果。",
  ];
  for (const reply of factual) {
    assert.equal(claimsMediaWasOrWillBeSent(reply), false, reply);
    assert.deepEqual(guardUnconfirmedMediaPromise(reply, "zh"), {
      reply, changed: false,
    }, reply);
  }
});

test("Chinese send promises require affirmative delivery and preserve other clauses", () => {
  const promised = [
    "优惠图片我已经发给你了。",
    "图片已经发了。",
    "资料我刚才转发了。",
    "我已经把图片发出去。",
    "我现在发送配套图片给你参考。",
    "我们会分享配套资料。",
    "我会发优惠图。",
    "我们把图片分享给你参考。",
    "现在我会分享配套资料。",
  ];
  for (const reply of promised) {
    assert.equal(claimsMediaWasOrWillBeSent(reply), true, reply);
    const guarded = guardUnconfirmedMediaPromise(reply, "zh");
    assert.equal(guarded.changed, true, reply);
    assert.notEqual(guarded.reply, reply);
  }

  const mixed = "骨盆调理套餐 A RM388。我们分享的图片只是教学参考。优惠图片我已经发给你了。";
  const guarded = guardUnconfirmedMediaPromise(mixed, "zh");
  assert.equal(guarded.changed, true);
  assert.match(guarded.reply, /骨盆调理套餐 A RM388/u);
  assert.match(guarded.reply, /我们分享的图片只是教学参考/u);
  assert.doesNotMatch(guarded.reply, /已经发给你/u);

  const contrast = "我们不发旧图，但我现在会发送另一张优惠图给你。";
  assert.equal(claimsMediaWasOrWillBeSent(contrast), true,
    "an earlier refusal cannot hide a later explicit send promise");
});


test("Compound 3D price and recovery-period enquiry answers both parts without guaranteed downtime", () => {
  const decision = {
    type: "price", treatment: "3D 小颜术",
    source: "recent_customer", prices: [{name: "Main offer", price: "RM488"}],
  };
  for (const [language, text, recoveryPattern] of [
    ["zh", "价格？需修复期？", /修复期|恢复时间/u],
    ["zh", "3D多少钱，恢复期多久？", /修复期|恢复时间/u],
    ["en", "How much and is there downtime?", /downtime or recovery/iu],
    ["ms", "Berapa harga dan tempoh pemulihan?", /tempoh pemulihan/iu],
  ]) {
    const result = ensureVerifiedPriceReply({
      customerText: text, reply: "Would you like to book?",
      treatment: decision.treatment,
      pricingDecision: decision,
      priceOnlyResponse: true,
      services, serviceAliases: aliases, promotions,
      language,
    });
    assert.equal(result.restored, true, text);
    assert.match(result.reply, /RM488/u);
    assert.match(result.reply, recoveryPattern);
    assert.doesNotMatch(result.reply, /(?:guaranteed|promises?)\\s+(?:zero|no)\\s+downtime|绝对无恢复期|保证无痛/iu);
  }
});

test("Structured 9D pricing is available in text while unapproved artwork remains held", async () => {
  const promo = [{
    name: "9D 逆龄抗衰 First Trial", linkedService: "9D 逆龄抗衰",
    validFrom: "2000-01-01", validUntil: "2999-12-31",
    sendOnPriceQuery: true, automaticMediaHold: true,
    pricing: {currency: "MYR", offer: 488, normal: 1288},
    imageUrl: "https://example.test/9d-legacy-creative.jpg",
    caption: "9D 仪器类紧致提拉护理，适合与否由中医师评估，效果因人而异。",
    followUpMessage: "限时优惠！只需要 RM488（原价 RM1,288）。赠送1小时十二经络按摩。",
    mediaTranslations: {en: {caption: "9D facial contour treatment; suitability assessed individually."}},
  }];
  const price = verifiedPricesForService("9D 逆龄抗衰",promo,"9D 价格多少？");
  assert.deepEqual(price?.map(x=>x.price),["RM488"]);
  assert.equal(promotionHasUnsafeClinicalCopy(promo[0]),true,
    "a clean caption cannot override an unapproved image hold");
  const decision = { type:"price", treatment:"9D 逆龄抗衰", source:"current_customer", prices:price };
  const reply = ensureVerifiedPriceReply({
    customerText:"9D 价格多少？", reply:"请咨询门店", treatment:"9D 逆龄抗衰",
    pricingDecision:decision, services,serviceAliases:aliases,promotions:promo,language:"zh",
  });
  assert.match(reply.reply,/RM488/u);
  const old = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {...old,assessmentFirstPricingEnabled:true};
  try {
    let reason = "";
    const media = await resolvePricePromotionForReply({
      priceQuery:true,packageQuery:false,pricingDecision:decision,aiPricingEnabled:true,
      treatment:decision.treatment,verifiedServiceFromText:decision.treatment,
      customerText:"9D 价格多少？",promotions:promo,services,serviceAliases:aliases,
      textSendSucceeded:true, flagged:false,bookingReady:false,keywordReason:null,
      needsAttention:false,contactId:12345,onSkip:value=>{reason=value;},
      wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(media,null);
    assert.equal(reason,"unverified_clinical_promo_copy");
  } finally {
    clinicConfig.automatedFollowUp=old;
  }
});

test("Structured pelvic A and B prices retain package identity and voucher condition", () => {
  const pelvic = [{
    name:"骨盆调理套餐",linkedService:"骨盆调理",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    imageUrl:"",caption:"",
    packages:[
      {name:"Package A",imageUrl:"https://example.test/a.jpg",
       pricing:{currency:"MYR",offer:388,normal:488},
       caption:"RM100 优惠券限时领取。原价 RM488，优惠后仅需 RM388。",
       mediaTranslations:{
         en:{caption:"RM100 voucher. Original price RM488. After voucher, only RM388."},
         ms:{caption:"Baucar RM100. Harga asal RM488. Selepas baucar RM388."}}},
      {name:"Package B",imageUrl:"https://example.test/b.jpg",
       pricing:{currency:"MYR",offer:288,normal:388},
       caption:"本月限时优惠 RM100 OFF，原价 RM388，现在只需 RM288。",
       mediaTranslations:{en:{caption:"Original price RM388. Now only RM288."}}},
    ],
  }];
  const options=verifiedPricesForService("骨盆调理",pelvic,"骨盆调理配套多少钱？");
  assert.deepEqual(options?.map(x=>[x.name,x.price]),[
    ["Package A","RM388"],["Package B","RM288"]
  ]);
  assert.equal(options[0].afterVoucher,true);
  const response=ensureVerifiedPriceReply({
    customerText:"骨盆调理配套多少钱？",reply:"欢迎了解",
    treatment:"骨盆调理",pricingDecision:{
      type:"package_options",treatment:"骨盆调理",source:"current_customer",prices:options,
    },services:[{name:"骨盆调理"}],serviceAliases:[],promotions:pelvic,language:"zh",
  });
  assert.match(response.reply,/Package A[\s\S]*RM388/u);
  assert.match(response.reply,/Package B[\s\S]*RM288/u);
  assert.match(response.reply,/优惠券/u);
});


test("Amanda confirmed RM488 price plus recovery question receives both verified price and cautious recovery guidance", () => {
  const cases = [
    ["en", "Rm488 for one time? Is there downtime?", /Regarding downtime or recovery/iu],
    ["zh", "RM488 for one time? 需要修复期吗？", /至于修复期／恢复时间/u],
    ["zh", "RM488? 恢复期多久？", /至于修复期／恢复时间/u],
    ["en", "RM488? Does it have downtime?", /Regarding downtime or recovery/iu],
    ["en", "RM488? Does it need recovery time?", /Regarding downtime or recovery/iu],
    ["en", "RM488? How long does recovery take?", /Regarding downtime or recovery/iu],
    ["en", "RM488? How many days of recovery?", /Regarding downtime or recovery/iu],
    ["en", "RM488? Will I need time to recover?", /Regarding downtime or recovery/iu],
    ["zh", "RM488? 需要休息多久？", /至于修复期／恢复时间/u],
    ["zh", "RM488? 要休息几天？", /至于修复期／恢复时间/u],
    ["ms", "RM488? Perlu recovery time?", /Tentang tempoh pemulihan/iu],
    ["ms", "RM488 for one time? Ada tempoh pemulihan?", /Tentang tempoh pemulihan/iu],
  ];
  for (const [language, text, recoveryPattern] of cases) {
    const history = [...amanda().slice(0, -1), turn("user", text, 1000)];
    const decision = resolveShadowPriceException(args({
      customerText: text, conversationHistory: history,
    }));
    assert.equal(decision?.source, "confirmed_prior_quote", text);
    assert.equal(decision.prices?.[0]?.price, "RM488");
    const confirmed = ensureVerifiedPriceReply({
      customerText: text, reply: "Would you like to book?",
      treatment: decision.treatment, pricingDecision: decision,
      services, serviceAliases: aliases, promotions, language,
      conversationHistory: history, priceOnlyResponse: true,
    });
    assert.equal(confirmed.restored, true);
    assert.match(confirmed.reply, /RM488/u);
    assert.match(confirmed.reply, recoveryPattern);
    assert.doesNotMatch(confirmed.reply, /(?:guaranteed (?:zero|no) downtime|(?:zero|no) downtime guaranteed|绝对无恢复期|保证无痛)/iu);
    assert.doesNotMatch(confirmed.reply, /send (?:a|the) (?:image|graphic)|已经发图/u);
  }

  for (const text of [
    "RM488 for one time? What about RM288?",
    "RM488? Is the 9D price different?",
    "RM488? 需要骨盆调理吗？",
    "RM488? Does the 9D treatment need recovery time?",
    "RM488? How long does the other package recovery take?",
    "RM488? Is there downtime and can you send me the graphic?",
    "RM488? 9D需要休息多久？",
    "RM488? Send me a discount picture.",
  ]) {
    const history = [...amanda().slice(0, -1), turn("user", text, 1000)];
    assert.equal(resolvePreviouslyQuotedSessionPrice(args({
      customerText: text, conversationHistory: history,
    })), null, text);
  }
});

test("Verified text-only service prices preserve a simultaneous downtime question", () => {
  const decision = {
    type: "price", source: "service_price", treatment: "3D 小颜术",
    prices: [], servicePrice: "RM488",
  };
  const text = "What is the price and recovery time?";
  const result = ensureVerifiedPriceReply({
    customerText: text, reply: "Please come for an assessment.",
    pricingDecision: decision, treatment: decision.treatment,
    services, serviceAliases: aliases, promotions: [],
    language: "en", priceOnlyResponse: true,
  });
  assert.equal(result.restored, true);
  assert.match(result.reply, /RM488/u);
  assert.match(result.reply, /downtime or recovery/iu);
});
