"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

const services = [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }, { name: "骨盆调理" }];
const aliases = [
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const trial = {
  name: "3D First Trial", linkedService: "3D 小颜术",
  sendOnPriceQuery: true, imageUrl: "https://example.test/promo/32",
  caption: "3D First Trial 限时优惠",
  followUpMessage: "只需 RM 4️⃣8️⃣8️⃣ (原价 RM888)",
  pricing: { currency: "MYR", offer: 488, normal: 888 },
};
const pelvic = {
  name: "骨盆", linkedService: "骨盆调理", sendOnPriceQuery: true,
  imageUrl: "", caption: "",
  packages: [
    { name: "Package A", imageUrl: "https://example.test/a", caption: "现在只需 RM388",
      pricing: { currency: "MYR", offer: 388, normal: 488 } },
    { name: "Package B", imageUrl: "https://example.test/b", caption: "现在只需 RM288",
      pricing: { currency: "MYR", offer: 288, normal: 388 } },
  ],
};
const promotions = [trial, pelvic];
const history = [
  { role: "user", content: "Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～" },
  { role: "assistant", content: "3D小颜术是我们的徒手脸型护理。" },
  { role: "assistant", content: "这是顾客的 Before & After。" },
  { role: "user", content: "请问,做一次多少" },
];
function decide(overrides = {}) {
  return resolveAiPricingDecision({
    priceQuery: true,
    treatment: "3D 小颜术", customerText: "请问,做一次多少",
    conversationHistory: history, services, serviceAliases: aliases,
    promotions, ...overrides,
  });
}
async function inAssessmentFirst(fn) {
  const original = config.automatedFollowUp;
  config.automatedFollowUp = { ...original, assessmentFirstPricingEnabled: true };
  try { return await fn(); }
  finally { config.automatedFollowUp = original; }
}
function mediaArgs(decision, overrides = {}) {
  return {
    aiPricingEnabled: true, pricingDecision: decision,
    customerText: "请问,做一次多少", conversationHistory: history,
    treatment: decision?.treatment || null, verifiedServiceFromText: decision?.treatment || null,
    promotions, services, serviceAliases: aliases, resultMedia: [],
    flagged: false, bookingReady: false, needsAttention: false,
    keywordReason: null, textSendSucceeded: true,
    contactId: 484, language: "zh",
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    ...overrides,
  };
}

test("uses existing model price flags without adding a second AI response contract", () => {
  const parsed = parseAiReplyResult(JSON.stringify({
    reply: "我帮你确认价格 😊", outcome: "normal",
    serviceQuery: true, serviceQuerySource: "conversation",
    priceQuery: true, packageQuery: false, treatment: "3D 小颜术",
  }));
  assert.equal(parsed.priceQuery, true);
  assert.equal(Object.hasOwn(parsed, "pricingIntent"), false);
});

test("Neutro's reported '做一次多少' resolves 3D and its verified RM488 price", () => {
  const d = decide();
  assert.equal(d?.type, "price");
  assert.equal(d?.treatment, "3D 小颜术");
  assert.equal(d?.source, "recent_customer");
  assert.deepEqual(d?.prices?.map(p => p.price), ["RM488"]);
});

test("explicit current treatment and AI-missed price keyword both work", () => {
  const h = [{ role: "user", content: "3D First Trial 多少钱？" }];
  const d = decide({ priceQuery: false, customerText: "3D First Trial 多少钱？",
    conversationHistory: h });
  assert.equal(d?.treatment, "3D 小颜术");
  assert.equal(d?.prices?.[0]?.price, "RM488");
});

test("a short relevant interim customer question can bridge once", () => {
  const h = [
    { role: "user", content: "想了解3D小颜术" },
    { role: "user", content: "这个效果好吗？" },
    { role: "user", content: "做一次多少?" },
  ];
  const d = decide({ customerText: "做一次多少?", conversationHistory: h });
  assert.equal(d?.treatment, "3D 小颜术");
});

test("unrelated topics, staff intervention, stale history, ambiguity and ad-only guesses fail closed", () => {
  const cases = [
    { customerText: "3D和9D都多少钱?", conversationHistory: [{role:"user",content:"3D和9D都多少钱?"}] },
    { conversationHistory: [{role:"user",content:"3D小颜术"},{role:"assistant",content:"[Verified STAFF message] 请先联系我们"},{role:"user",content:"请问,做一次多少"}] },
    { conversationHistory: [{role:"user",content:"3D小颜术"},{role:"user",content:"我想改聊其他事情"},{role:"user",content:"请问,做一次多少"}] },
    { conversationHistory: [{role:"user",content:"3D小颜术"},{role:"user",content:"停车费多少钱?"},{role:"user",content:"请问,做一次多少"}] },
    { conversationHistory: [{role:"user",content:"3D小颜术"},{role:"user",content:"你好"},{role:"user",content:"请问,做一次多少"}] },
    { conversationHistory: [{role:"assistant",content:"看起来你想做3D小颜术"},{role:"user",content:"请问,做一次多少"}] },
  ];
  for (const item of cases) assert.equal(decide(item), null, JSON.stringify(item));
});

test("future promotion consent, refused prices, clinical concerns and free assessment questions fail closed", () => {
  const base = [{ role:"user",content:"想了解3D小颜术" }];
  for (const customerText of [
    "3D小颜术，之后有优惠可以发我",
    "我不要报价",
    "怀孕了做一次多少",
    "这个免费1对1评估是多少钱",
  ]) {
    assert.equal(decide({
      customerText, conversationHistory: [...base,{ role:"user",content:customerText }],
      complimentaryAssessmentExperienceEnabled: true,
    }), null, customerText);
  }
});

test("a package-price clarification inherits only the customer-named Package B", async () => {
  const customerText = "骨盆调理";
  const h = [
    { role:"user",content:"Package B 多少钱？" },
    { role:"assistant",content:"请问你想了解哪个疗程的价格呢？" },
    { role:"user",content:customerText },
  ];
  const d = decide({ priceQuery:false, treatment:"骨盆调理",
    customerText, conversationHistory:h });
  assert.equal(d?.clarifiedPriceService, "骨盆调理");
  assert.deepEqual(d?.prices?.map(p => [p.name, p.price]), [["Package B", "RM288"]]);
  await inAssessmentFirst(async () => {
    const media = await resolvePricePromotionForReply(mediaArgs(d, {
      customerText, conversationHistory:h, contactId:55,
    }));
    assert.deepEqual(media?.packages?.map(p => p.name), ["Package B"]);
  });
});

test("offer/package requests require the separate opt-in", () => {
  const current = "3D小颜术有什么配套?";
  const opts = { priceQuery:false, packageQuery:true,
    treatment:"3D 小颜术", customerText:current,
    conversationHistory:[{role:"user",content:current}] };
  assert.equal(decide(opts), null);
  assert.equal(decide({...opts,allowOfferEnquiries:true})?.type,"package_options");
});

test("ordinary non-price answers remain unchanged in enabled mode", () => {
  const text = "我们可以先帮你做免费1对1评估+体验，了解你想改善的地方 😊";
  const result = ensureVerifiedPriceReply({ customerText:"我想了解3D小颜术",
    reply:text, pricingDecision:null, priceRequested:false, language:"zh" });
  assert.equal(result.reply, text);
  assert.equal(result.restored, false);
});

test("AI cannot promise an image or quote an unsupported price when no decision verifies it", () => {
  const guarded = ensureVerifiedPriceReply({
    customerText:"请问,做一次多少", priceRequested:true, pricingDecision:null,
    reply:"3D First Trial RM999，我发优惠详情给你", language:"zh",
  });
  assert.doesNotMatch(guarded.reply, /RM999|发优惠详情/u);
  assert.match(guarded.reply, /哪项疗程的价格/u);
});

test("configured text-only offer still gives a verified price without an automatic graphic", async () => {
  const textOnly = {...trial,sendOnPriceQuery:false};
  const d = decide({ promotions:[textOnly] });
  assert.equal(d?.prices?.[0]?.price,"RM488");
  const reply = ensureVerifiedPriceReply({
    customerText:"请问,做一次多少",reply:"我帮你查价格",
    pricingDecision:d, treatment:d.treatment, language:"zh",
  });
  assert.match(reply.reply,/RM488/u);
  const media=await resolvePricePromotionForReply(mediaArgs(d,{promotions:[textOnly]}));
  assert.equal(media,null);
});

test("one decision supplies identical approved price and promotion image", async () => {
  await inAssessmentFirst(async () => {
    const d = decide();
    const guarded = guardAssessmentFirstPricingReply({
      customerText:"请问,做一次多少",reply:"3D 小颜术 RM488",
      treatment:d.treatment,verifiedPricingIntent:true,requireVerifiedTreatment:true,
      services,serviceAliases:aliases,conversationHistory:history,resultMedia:[],
    });
    assert.equal(guarded.replaced,false);
    const text = ensureVerifiedPriceReply({
      customerText:"请问,做一次多少",reply:"我们有优惠我发你",
      treatment:d.treatment,pricingDecision:d,priceRequested:true,
      services,serviceAliases:aliases,promotions,conversationHistory:history,
      resultMedia:[],language:"zh",
    });
    assert.match(text.reply,/RM488/u);
    assert.doesNotMatch(text.reply,/我发你/u);
    const media = await resolvePricePromotionForReply(mediaArgs(d));
    assert.equal(media?.packages?.[0]?.imageUrl,trial.imageUrl);
    assert.equal(await resolvePricePromotionForReply(mediaArgs(d,{
      wasPromoRecentlySent:async()=>true,
    })),null,"staff-forwarded duplicate must be skipped");
    assert.equal(await resolvePricePromotionForReply(mediaArgs(d,{
      hasUnconfirmedMediaDelivery:async()=>true,
    })),null,"uncertain provider receipt must fail closed");
    assert.equal(await resolvePricePromotionForReply(mediaArgs(d,{
      textSendSucceeded:false,
    })),null,"failed reply must not create separate image send");
  });
});

test("unverified and contradictory promo prices never result in a graphic", async () => {
  const bad={...trial,followUpMessage:"现在只需 RM588"};
  const d=decide({promotions:[bad]});
  assert.equal(d?.prices,null);
  assert.equal(await resolvePricePromotionForReply(mediaArgs(d,{promotions:[bad]})),null);
});

test("services without active promotions still answer their configured price in text", async () => {
  const clinicServices = [{ name: "3D 小颜术", priceRange: "RM888 per session" }];
  const d = decide({ promotions: [], services: clinicServices });
  assert.equal(d?.prices, null);
  assert.equal(d?.servicePrice, "RM888 per session");
  const reply = ensureVerifiedPriceReply({
    customerText: "请问,做一次多少", reply: "我们有个优惠",
    treatment: d.treatment, pricingDecision: d, priceRequested: true,
    services: clinicServices, promotions: [], language: "zh",
  });
  assert.match(reply.reply, /RM888 per session/);
  assert.equal(await resolvePricePromotionForReply(mediaArgs(d, {
    promotions: [], services: clinicServices,
  })), null);
});

test("an ambiguous active offer cannot fall back to the standing service price", () => {
  const withPrices = services.map(s => s.name === "3D 小颜术"
    ? { ...s, priceRange: "RM888" } : s);
  const bad = { ...trial, followUpMessage: "现在只需 RM588" };
  const d = decide({ services: withPrices, promotions: [bad] });
  assert.equal(d?.prices, null);
  assert.equal(d?.servicePrice, null);
});


test("erroneous AI price flag never converts duration or session count to a promo", () => {
  for (const customerText of [
    "3D 小颜术做一次要多久？",
    "3D 小颜术做一次要多少时间？",
    "3D 小颜术要做几次？",
    "How much time does one 3D session take?",
    "Berapa lama satu sesi 3D?",
  ]) {
    assert.equal(decide({ customerText,
      conversationHistory: [{ role:"user", content:customerText }],
    }), null, customerText);
  }
  const customerText = "3D 小颜术做一次要多久，多少钱？";
  assert.equal(decide({ customerText,
    conversationHistory:[{role:"user",content:customerText}],
  })?.prices?.[0]?.price, "RM488", "a separate explicit price question must still work");
});

test("a service-level fallback never quotes historical promotions or ambiguous ranges", () => {
  for (const priceRange of [
    "Old promo RM488", "Expired trial RM488", "RM488-RM888",
    "RM488 or RM888", "原价 RM888", "RM488 / RM888", "Special offer RM488",
  ]) {
    const clinicServices = [{name:"3D 小颜术",priceRange}];
    const d = decide({promotions:[], services:clinicServices});
    assert.equal(d?.servicePrice, null, priceRange);
  }
  assert.equal(decide({promotions:[], services:[{
    name:"3D 小颜术",priceRange:"Normal price: RM888",
  }]}).servicePrice, "Normal price: RM888");
});

test("normal and original prices must agree across structured data and every language", () => {
  assert.equal(decide().prices?.[0]?.price,"RM488");
  for (const bad of [
    {...trial,followUpMessage:"现在只需 RM488 (原价 RM999)"},
    {...trial,mediaTranslations:{en:{caption:"Trial price RM488 (Original price RM999)"}}},
    {...trial,followUpTranslations:{ms:"Harga promosi RM488 (Harga asal RM999)"}},
  ]) {
    const d=decide({promotions:[bad]});
    assert.equal(d?.prices,null,JSON.stringify(bad));
  }
});

test("compatible text-only offers do not suppress the one eligible promotion graphic", async () => {
  const matching = {
    name:"3D Text Info",linkedService:"3D 小颜术",sendOnPriceQuery:false,
    imageUrl:"",caption:"First Trial 只需 RM488 (原价 RM888)",
    pricing:{currency:"MYR",offer:488,normal:888},
  };
  const d=decide({promotions:[trial,matching]});
  assert.deepEqual(d?.prices?.map(p=>p.price),["RM488"]);
  const media=await resolvePricePromotionForReply(mediaArgs(d,{promotions:[trial,matching]}));
  assert.equal(media?.packages?.[0]?.imageUrl,trial.imageUrl);
  const conflicting={...matching,caption:"First Trial 只需 RM588 (原价 RM888)",
    pricing:{currency:"MYR",offer:588,normal:888}};
  const blocked=decide({promotions:[trial,conflicting]});
  assert.equal(blocked?.prices,null);
  assert.equal(await resolvePricePromotionForReply(mediaArgs(blocked,{
    promotions:[trial,conflicting],
  })),null);
});

test("the verified reply strips image-delivery promises in Chinese, English and Malay", () => {
  const d=decide();
  for (const [language,reply,promise] of [
    ["zh","我等下发图片给你😊",/发图片给你/u],
    ["zh","优惠详情我会发图片给你参考😊",/发图片给你/u],
    ["en","I'll send the promotion image shortly 😊",/send the promotion image/iu],
    ["ms","Saya akan hantar gambar promosi sekarang 😊",/hantar gambar promosi/iu],
  ]) {
    const result=ensureVerifiedPriceReply({
      customerText:"请问,做一次多少",reply,language,
      pricingDecision:d,treatment:d.treatment,
      services,serviceAliases:aliases,promotions,conversationHistory:history,
    });
    assert.match(result.reply,/RM488/);
    assert.doesNotMatch(result.reply,promise,reply);
  }
});

test("Gemini receives a compact verified price reference for natural language pricing", () => {
  const {buildConversationPromptContext}=require("../src/utils/conversationPromptContext");
  const {buildSystemPrompt}=require("../src/utils/systemPrompt");
  const original={
    aiPricingIntentMode:config.aiPricingIntentMode,
    services:config.services,
    promotions:config.promotions,
    serviceAliases:config.serviceAliases,
    automatedFollowUp:config.automatedFollowUp,
  };
  try {
    config.aiPricingIntentMode="enabled";
    config.services=services;
    config.promotions=[trial];
    config.serviceAliases=aliases;
    config.automatedFollowUp={...original.automatedFollowUp,assessmentFirstPricingEnabled:true};
    const context=buildConversationPromptContext([
      {role:"user",content:"想了解 Neutro Sense TCM 3D 小颜术"},
      {role:"assistant",content:"可以先做1对1评估+体验"},
      {role:"user",content:"请问,做一次多少"},
    ],{services,aliases,promotions:[trial]});
    assert.deepEqual(context.relevantServiceNames,["3D 小颜术"]);
    const prompt=buildSystemPrompt({conversationContext:context});
    assert.match(prompt,/VERIFIED PRICE REFERENCE[\s\S]{0,350}RM488/u);
    assert.doesNotMatch(prompt,/只需 RM 4️⃣8️⃣8️⃣/u,
      "natural question must not load full ad caption just to learn a price");
    config.aiPricingIntentMode="off";
    const legacy=buildSystemPrompt({conversationContext:context});
    assert.doesNotMatch(legacy,/VERIFIED PRICE REFERENCE/u);
  } finally {
    Object.assign(config,original);
  }
});


test("model priceQuery false positives cannot resend promotional graphics on price objections", async () => {
  const complaints = [
    "3D 小颜术价格太贵了",
    "3D 小颜术价格太高，超出预算",
    "3D小颜术贵了，我考虑一下",
    "My 3D treatment price is too expensive",
    "My budget is RM500 for 3D",
    "3D 价格不便宜",
    "Harga 3D mahal sangat",
  ];
  const { isPurePriceObjection } = require("../src/utils/aiPricingIntentDecision");
  for (const customerText of complaints) {
    const h = [{ role: "user", content: customerText }];
    assert.equal(isPurePriceObjection(customerText), true, customerText);
    const d = decide({ customerText, conversationHistory: h, priceQuery: true });
    assert.equal(d, null, "bad model flag must not authorize pricing: " + customerText);
    const reply = ensureVerifiedPriceReply({
      customerText, reply: "我明白你会考虑预算，我们可以先了解你的需求 😊",
      treatment: null, pricingDecision: d, priceRequested: false, language: "zh",
    });
    assert.doesNotMatch(reply.reply, /哪项疗程的价格/u,
      "objection should not trigger a which-treatment pricing clarification");
    assert.equal(await resolvePricePromotionForReply(mediaArgs(d, {
      customerText, conversationHistory: h, priceQuery: true,
    })), null, "objection should not send a graphic");
  }
});

test("a separate direct price question after an objection still qualifies", () => {
  const { isPurePriceObjection } = require("../src/utils/aiPricingIntentDecision");
  for (const customerText of [
    "3D 小颜术价格太贵了，现在多少钱？",
    "3D价格太贵，不过做一次多少？",
    "3D price too expensive; what is the current price?",
  ]) {
    assert.equal(isPurePriceObjection(customerText), false, customerText);
    const d = decide({ customerText,
      conversationHistory: [{ role: "user", content: customerText }],
    });
    assert.equal(d?.treatment, "3D 小颜术", customerText);
    assert.deepEqual(d?.prices?.map(p => p.price), ["RM488"], customerText);
  }
});

test("complaints combined with duration questions do not become price requests", () => {
  const { isPurePriceObjection } = require("../src/utils/aiPricingIntentDecision");
  const customerText = "3D 价格太贵了，做一次多少时间？";
  assert.equal(isPurePriceObjection(customerText), true);
  assert.equal(decide({
    customerText, conversationHistory: [{ role: "user", content: customerText }],
    priceQuery: true,
  }), null);
});


test("a wrong model price flag never turns ordinary treatment questions into prices or graphics", async () => {
  const { hasCustomerRequestedPriceReply, hasCurrentPriceAmountRequest } =
    require("../src/utils/aiPricingIntentDecision");
  const { hasExplicitPackageOptionsRequest } =
    require("../src/utils/customerEnquiryEvidence");
  const questions = [
    "3D 小颜术有效果吗？",
    "3D 小颜术可以改善大小脸吗？",
    "3D 是徒手做的吗？",
    "3D 小颜术这个疗程包括什么？",
    "3D 的套餐里面有什么？",
    "3D 的价格合理吗？",
    "Does the 3D facial actually work?",
    "How does the 3D treatment work?",
    "3D rawatan berkesan ke?",
  ];
  for (const customerText of questions) {
    const history = [{ role: "user", content: customerText }];
    assert.equal(hasCurrentPriceAmountRequest(customerText), false, customerText);
    assert.equal(hasExplicitPackageOptionsRequest(customerText), false, customerText);
    const d = decide({
      priceQuery: true, packageQuery: true, allowOfferEnquiries: true,
      customerText, conversationHistory: history,
    });
    assert.equal(d, null, "model misclassification must fail closed: " + customerText);
    assert.equal(hasCustomerRequestedPriceReply({
      customerText, pricingDecision: d,
    }), false, "no spurious price clarification: " + customerText);
    const text = "我们可以先了解你想改善的地方，再做1对1评估+体验 😊";
    const guarded = ensureVerifiedPriceReply({
      customerText, reply: text, pricingDecision: d,
      priceRequested: hasCustomerRequestedPriceReply({customerText, pricingDecision: d}),
      treatment: null, language: "zh",
    });
    assert.equal(guarded.reply, text, "normal service explanation remains unchanged");
    assert.equal(await resolvePricePromotionForReply(mediaArgs(d, {
      customerText, conversationHistory: history, priceQuery: true, packageQuery: true,
    })), null, "no unsolicited image");
  }
});

test("genuine colloquial price questions still work even with cautious model flags", () => {
  const { hasCurrentPriceAmountRequest, hasCustomerRequestedPriceReply } =
    require("../src/utils/aiPricingIntentDecision");
  for (const customerText of [
    "3D 小颜术多少钱？",
    "3D First Trial 多少钱？",
    "3D 做一次多少？",
    "3D 一次几多？",
    "3D how much per session?",
    "3D berapa satu sesi?",
    "3D price?",
    "3D 怎么收费？",
  ]) {
    assert.equal(hasCurrentPriceAmountRequest(customerText), true, customerText);
    const d = decide({customerText,conversationHistory:[{role:"user",content:customerText}]});
    assert.equal(d?.type, "price", customerText);
    assert.deepEqual(d?.prices?.map(p=>p.price), ["RM488"], customerText);
    assert.equal(hasCustomerRequestedPriceReply({customerText,pricingDecision:d}),true);
  }
  assert.equal(decide({
    priceQuery:false, customerText:"3D First Trial 多少钱？",
    conversationHistory:[{role:"user",content:"3D First Trial 多少钱？"}],
  })?.prices?.[0]?.price,"RM488","explicit question recovers if Gemini misses the price flag");
});

test("current named treatment switches permit new pricing, not old CRM or conversation prices", async () => {
  const nine = {
    ...trial,
    name:"9D First Trial",
    linkedService:"9D 逆龄抗衰",
    imageUrl:"https://example.test/9d",
    caption:"9D First Trial 限时优惠",
    followUpMessage:"只需 RM488 (原价 RM1288)",
    pricing:{currency:"MYR", offer:488,normal:1288},
  };
  const promos = [...promotions,nine];
  for(const customerText of [
    "换个疗程，我想了解9D多少钱？",
    "改聊9D，做一次多少？",
    "I want to switch to 9D. How much per session?",
    "Instead, what's the price of 9D?",
  ]) {
    const h=[
      {role:"user",content:"我想了解3D小颜术"},
      {role:"assistant",content:"3D小颜术可以先评估"},
      {role:"user",content:customerText},
    ];
    const d=decide({
      treatment:"9D 逆龄抗衰",promotions:promos,
      customerText,conversationHistory:h,
    });
    assert.equal(d?.treatment,"9D 逆龄抗衰",customerText);
    assert.equal(d?.source,"current_customer");
    assert.deepEqual(d?.prices?.map(p=>p.price),["RM488"],customerText);
    const media=await resolvePricePromotionForReply(mediaArgs(d,{
      treatment:d.treatment,verifiedServiceFromText:d.treatment,
      customerText,conversationHistory:h,promotions:promos,
    }));
    assert.equal(media?.packages?.[0]?.imageUrl,nine.imageUrl,customerText);
  }
});

test("topic reset still never resurrects an old treatment, a refusal, or an ad-only service", () => {
  const nine={
    ...trial,name:"9D First Trial",linkedService:"9D 逆龄抗衰",
    followUpMessage:"只需 RM488 (原价 RM1288)",
    pricing:{currency:"MYR",offer:488,normal:1288},
  };
  const promos=[...promotions,nine];
  for (const customerText of [
    "换个疗程，多少钱？",
    "改聊其他东西，价格呢？",
    "switch treatments, how much?",
    "Stop promotions; switch to 9D. How much?",
    "不要9D，我想换个疗程，多少钱？",
  ]) {
    const h=[
      {role:"user",content:"之前是3D小颜术"},
      {role:"assistant",content:"好的"},
      {role:"user",content:customerText},
    ];
    assert.equal(decide({
      customerText,conversationHistory:h,
      treatment:"9D 逆龄抗衰",promotions:promos,
    }),null,customerText);
  }
  const both="不要3D，换个9D多少钱？";
  assert.equal(decide({
    customerText:both, treatment:"9D 逆龄抗衰",
    conversationHistory:[{role:"user",content:both}],
    promotions:promos,
  }),null,"two named service mentions fail closed unless their context is independently resolved");
});

test("opted-in package questions work but package details alone never trigger graphics", () => {
  const { hasExplicitPackageOptionsRequest } =
    require("../src/utils/customerEnquiryEvidence");
  for(const customerText of [
    "3D 有什么配套？",
    "3D 有什么优惠？",
    "What packages do you have for 3D?",
  ]) {
    assert.equal(hasExplicitPackageOptionsRequest(customerText),true,customerText);
    const h=[{role:"user",content:customerText}];
    const opts={priceQuery:false,packageQuery:true,treatment:"3D 小颜术",
      customerText,conversationHistory:h};
    assert.equal(decide({...opts,allowOfferEnquiries:false}),null);
    assert.equal(decide({...opts,allowOfferEnquiries:true})?.type,"package_options");
  }
  const details="3D 套餐里面有什么？";
  assert.equal(hasExplicitPackageOptionsRequest(details),false);
  assert.equal(decide({priceQuery:false,packageQuery:true,allowOfferEnquiries:true,
    customerText:details,conversationHistory:[{role:"user",content:details}]}),null);
});

test("customer treatment survives one short address question, but not a second unrelated interruption", () => {
  const priceText = "请问,做一次多少";
  const admin = [
    {role:"user",content:"Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～"},
    {role:"assistant",content:"我们有3D的资料可供参考"},
    {role:"user",content:"地址？"},
    {role:"assistant",content:"我们在 Petaling Jaya。"},
    {role:"user",content:priceText},
  ];
  const d=decide({treatment:null,customerText:priceText,conversationHistory:admin});
  assert.equal(d?.treatment,"3D 小颜术");
  assert.equal(d?.source,"recent_customer");
  assert.deepEqual(d?.prices?.map(p=>p.price),["RM488"]);
  const modelMistake=decide({treatment:"9D 逆龄抗衰",customerText:priceText,conversationHistory:admin});
  assert.equal(modelMistake?.treatment,"3D 小颜术","customer evidence beats unsupported AI treatment");

  for (const middle of ["取消预约", "退款", "停车费多少钱?", "我想改聊其他事情", "我不想做3D", "你好"]) {
    const turns=[admin[0],{role:"user",content:middle},{role:"user",content:priceText}];
    assert.equal(decide({treatment:null,customerText:priceText,conversationHistory:turns}),null,middle);
  }
  assert.equal(decide({customerText:priceText,conversationHistory:[
    admin[0],{role:"user",content:"地址?"},{role:"user",content:"营业时间?"},{role:"user",content:priceText}
  ]}),null,"only one brief admin interruption is allowed");
});
