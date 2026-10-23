const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_AUTOMATIC_IMAGES_PER_REPLY,
  RESULT_MEDIA_SEND_SPACING_MS,
  planResultMediaPacing,
} = require("../src/utils/resultMediaPacing");
const { resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");

const images = [{ imageUrl: "result-1" }, { imageUrl: "result-2" }];
const consentPrefill = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊";
const combinedEnquiry = "我想了解骨盆调理疗程，也想看看优惠";

test("price-only enquiry prioritizes two pricing graphics over optional proof", () => {
  for (const customerText of ["了价格", "骨盆配套 RM388 多少钱?", "3D多少钱？", "How much is the treatment?"]) {
    const p = planResultMediaPacing({ customerText, promotionCount: 2, items: images });
    assert.deepEqual(p.items, [], customerText);
    assert.equal(p.reason, "promotion_price_priority");
  }
});

test("a verified service-only answer to our price clarification does not add result photos", () => {
  assert.deepEqual(planResultMediaPacing({
    customerText: "骨盆", completedPriceClarification: true,
    promotionCount: 2, items: images,
  }), { items: [], reason: "promotion_price_priority" });
  assert.deepEqual(planResultMediaPacing({
    customerText: "Pelvic", completedPriceClarification: true,
    promotionCount: 2, items: images,
  }), { items: [], reason: "promotion_price_priority" });
  assert.deepEqual(planResultMediaPacing({
    customerText: "骨盆", completedPriceClarification: true,
    promotionCount: 0, allowRelatedPriceProof: true, items: images,
  }), { items: [], reason: "promotion_price_priority" });

  // Without verified prior price context, treatment enquiry images are
  // independently eligible as before.
  assert.deepEqual(planResultMediaPacing({
    customerText: "骨盆", completedPriceClarification: false,
    promotionCount: 0, items: images,
  }).items, images);
  // An actual new results request remains independently eligible.
  assert.deepEqual(planResultMediaPacing({
    customerText: "骨盆，我还想看效果图", completedPriceClarification: true,
    promotionCount: 2, items: images,
  }).items, images.slice(0, 1));
});

test("independent treatment interest permits one proof after two promotions", () => {
  for (const customerText of [combinedEnquiry, "我想了解骨盆调理疗程，也想看看优惠", "I'm interested in the pelvic treatment and want to know the price"]) {
    const p = planResultMediaPacing({ customerText, promotionCount: 2, items: images });
    assert.deepEqual(p.items, images.slice(0, 1), customerText);
    assert.equal(p.reason, "result_media_paced_after_promotions");
  }
});

test("send count is bounded while preserving configured two-result limit without promotions", () => {
  assert.deepEqual(planResultMediaPacing({ customerText: "我想了解骨盆调理疗程", promotionCount: 0, items: images }).items, images);
  assert.deepEqual(planResultMediaPacing({ customerText: combinedEnquiry, promotionCount: 1, items: images }).items, images);
  assert.deepEqual(planResultMediaPacing({ customerText: combinedEnquiry, promotionCount: 3, items: images }), { items: [], reason: "promotion_image_budget" });
  assert.equal(MAX_AUTOMATIC_IMAGES_PER_REPLY, 3);
  assert.ok(RESULT_MEDIA_SEND_SPACING_MS >= 1000);
});

test("skips are reported for ordinary enquiries and pending clinical review, not only contextual ad copy", async () => {
  const skips = [];
  const base = {
    serviceQuery: true,
    serviceQuerySource: "customer_message",
    customerText: "我想了解骨盆调理",
    treatment: "骨盆调理",
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    priceQuery: false,
    resultMedia: [{
      service: "骨盆调理",
      enabled: true,
      triggerMode: "service_enquiry",
      items: [{ imageUrl: "https://example.test/promo-images/11", caption: "Before & After" }],
    }],
    contactId: 42,
    onSkip: (reason) => skips.push(reason),
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  };
  assert.equal(await resolveResultMediaForReply({ ...base, needsAttention: true }), null);
  assert.equal(skips.at(-1), "staff_review_pending");
  assert.equal(await resolveResultMediaForReply({ ...base, treatment: null, customerText: "想了解脸型" }), null);
  assert.equal(skips.at(-1), "no_verified_treatment");
  assert.equal(await resolveResultMediaForReply({ ...base, wasMediaRecentlySent: async () => true }), null);
  assert.equal(skips.at(-1), "result_media_recently_sent");
  assert.equal((await resolveResultMediaForReply(base))?.items?.length, 1);
});

test("voice transcription failure is an informational review, with clinical review still blocking proof", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  const server = source("src/server.js");
  const contacts = source("src/db/contactsRepo.js");
  assert.match(server, /voice message could not be transcribed[\s\S]{0,220}"information"/);
  assert.match(contacts, /r\.category <> 'information'/);
  assert.match(contacts, /c\.mode = 'ai'/);
  assert.match(server, /contactsRepo\.canSendAutomaticReviewMedia\(contact\.id\)/);
});

test("direct customer-named treatment works without AI model intent flags", async () => {
  const { explicitServiceNamedByCustomer } = require("../src/utils/resultMediaTrigger");
  const media = [{
    service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
    autoSendCount: 2,
    items: [
      { imageUrl: "/api/config/result-media/image/11", caption: "Result one" },
      { imageUrl: "/api/config/result-media/image/12", caption: "Result two" },
    ],
  }];
  const customerText = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，想了解一下护理方式和效果 😊";
  assert.equal(explicitServiceNamedByCustomer(media, customerText), "骨盆调理");
  assert.equal(explicitServiceNamedByCustomer(media, "我想了解骨盆调理的地址"), null);
  assert.equal(explicitServiceNamedByCustomer(media, "骨盆调理多少钱？"), null);

  const decision = await resolveResultMediaForReply({
    customerText,
    treatment: null,
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    resultMedia: media,
    contactId: 363,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  });
  assert.equal(decision.service, "骨盆调理");
  assert.equal(decision.serviceQuerySource, "customer_message");
  assert.equal(decision.items.length, 2);

  const duplicate = await resolveResultMediaForReply({
    customerText,
    treatment: null,
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    resultMedia: media,
    contactId: 363,
    wasMediaRecentlySent: async () => true,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  });
  assert.equal(duplicate, null, "manual and AI sends must still suppress repeats for seven days");
});

test("clinical suitability and medical history suppress both result and promotion images even without AI flags", async () => {
  const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
  const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
  const resultMedia = [{
    service: "骨盆调理",
    enabled: true,
    triggerMode: "service_enquiry",
    autoSendCount: 2,
    items: [{ imageUrl: "https://example.test/promo-images/11", caption: "Before" }],
  }];
  const promotions = [{
    name: "Pelvic Trial",
    linkedService: "骨盆调理",
    sendOnPriceQuery: true,
    packages: [{ name: "Trial", imageUrl: "https://example.test/promo-images/21", caption: "RM288" }],
  }];
  for (const customerText of [
    "我怀孕3个月了，想了解骨盆调理，可以做吗？",
    "我昨天刚做了手术，想了解骨盆调理，安全吗？",
    "我对骨盆调理有兴趣，不过我刚剖腹生产，可以做吗？",
    "I am pregnant, can I try pelvic treatment?",
    "Saya hamil, rawatan pelvis ini selamat tak?",
    "我有糖尿病，骨盆调理的配套多少钱？",
    "我想了解骨盆调理，不知道可以用吗？",
    "骨盆调理可不可以做？",
    "Can I have pelvic treatment?",
    "Boleh buat rawatan pelvis ke?",
  ]) {
    assert.equal(hasClinicalMediaRisk(customerText), true, customerText);
    const reasons = [];
    assert.equal(await resolveResultMediaForReply({
      customerText,
      resultMedia,
      serviceQuery: true,
      serviceQuerySource: "customer_message",
      treatment: "骨盆调理",
      priceQuery: true,
      flagged: false,
      bookingReady: false,
      keywordReason: null,
      needsAttention: false,
      textSendSucceeded: true,
      contactId: 42,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
      onSkip: (reason) => reasons.push(reason),
    }), null);
    assert.equal(reasons.at(-1), "clinical_media_safety");
    assert.equal(await resolvePricePromotionForReply({
      customerText,
      priceQuery: true,
      treatment: "骨盆调理",
      promotions,
      flagged: false,
      bookingReady: false,
      keywordReason: null,
      needsAttention: false,
      textSendSucceeded: true,
      contactId: 42,
      wasPromoRecentlySent: async () => false,
    }), null);
  }
});

test("price-only is not allowed extra proof even when no new pricing graphics were sent", () => {
  for (const text of ["3D多少钱？", "骨盆RM288吗？", "How much for treatment?", "Harga berapa?"]) {
    assert.deepEqual(planResultMediaPacing({
      customerText: text,
      promotionCount: 0,
      items: images,
    }), { items: [], reason: "promotion_price_priority" }, text);
  }
  assert.deepEqual(planResultMediaPacing({
    customerText: "3D多少钱？可以看看效果图吗？",
    promotionCount: 0,
    items: images,
  }).items, images);
});

test("shared budget is enforced on the promotional batch before sending results", () => {
  const { planPromotionMediaPacing } = require("../src/utils/resultMediaPacing");
  const packages = Array.from({ length: 5 }, (_, i) => ({ name: "P" + i }));
  const limited = planPromotionMediaPacing(packages);
  assert.deepEqual(limited.items, packages.slice(0, 3));
  assert.equal(limited.reason, "promotion_image_budget");
  assert.deepEqual(planResultMediaPacing({
    customerText: "我想了解骨盆调理疗程",
    promotionCount: limited.items.length,
    items: images,
  }).items, []);
  assert.deepEqual(planPromotionMediaPacing(packages.slice(0, 2)).items, packages.slice(0, 2));
  const server = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/server.js"), "utf8"
  );
  assert.match(server, /planPromotionMediaPacing\(promoBundle\.packages\)/);
  assert.match(server, /for \(const promoPackage of \(queuedPromotions \|\| secondaryAiConversation \? \[\] : pacedPromotions\.items\)\)/);
  assert.match(server, /kind:"promotion"/);
  assert.match(server, /automaticPromoMediaSent \+= queuedPromotionCount/);
  assert.match(server, /serviceAliases: clinicConfig\.serviceAliases/);
});

test("multiple services or aliases remain ambiguous even when the AI picks one service", async () => {
  const media = [
    { service: "骨盆调理", enabled: true, triggerMode: "service_enquiry", items: [{imageUrl: "pelvis", caption: "Pelvic"}] },
    { service: "3D 小颜术", enabled: true, triggerMode: "service_enquiry", items: [{imageUrl: "face", caption: "3D"}] },
  ];
  const aliases = [
    { alias: "骨盆矫正 / pelvic correction", officialService: "骨盆调理" },
    { alias: "小颜术 / 3D face correction", officialService: "3D 小颜术" },
  ];
  const { customerNamedServices, explicitServiceNamedByCustomer } = require("../src/utils/resultMediaTrigger");
  const cases = [
    "我想了解骨盆调理和3D小颜术，两种有什么分别？",
    "我想了解pelvic correction和3D face correction哪个好？",
    "骨盆调理和3D小颜术，两种有什么分别？",
    "Which is better, pelvic correction or 3D face correction?",
  ];
  for (const customerText of cases) {
    assert.equal(customerNamedServices(media, customerText, aliases).length, 2, customerText);
    assert.equal(explicitServiceNamedByCustomer(media, customerText, aliases), null);
    const skipped = [];
    assert.equal(await resolveResultMediaForReply({
      customerText,
      resultMedia: media,
      serviceAliases: aliases,
      serviceQuery: true,
      serviceQuerySource: "customer_message",
      treatment: "骨盆调理",
      flagged: false,
      bookingReady: false,
      keywordReason: null,
      needsAttention: false,
      textSendSucceeded: true,
      contactId: 42,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
      onSkip: (reason) => skipped.push(reason),
    }), null);
    assert.equal(skipped.at(-1), "multiple_treatments_ambiguous");
  }
});

test("unique configured aliases recover missing AI intent without ad-name guesses", async () => {
  const serviceAliases = [{alias: "骨盆矫正 / pelvic correction", officialService: "骨盆调理"}];
  const resultMedia = [{service:"骨盆调理",enabled:true,triggerMode:"service_enquiry",items:[{imageUrl:"one",caption:"Proof"}]}];
  for (const customerText of ["我想了解骨盆矫正", "I'm interested in pelvic correction"]) {
    const result = await resolveResultMediaForReply({
      customerText,
      resultMedia,
      serviceAliases,
      serviceQuery: false,
      serviceQuerySource: null,
      treatment: null,
      flagged: false,
      bookingReady: false,
      keywordReason: null,
      needsAttention: false,
      textSendSucceeded: true,
      contactId: 42,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
    });
    assert.equal(result?.service, "骨盆调理", customerText);
  }
  assert.equal(await resolveResultMediaForReply({
    customerText: "骨盆矫正的地址在哪里？",
    resultMedia,
    serviceAliases,
    serviceQuery: false,
    serviceQuerySource: null,
    treatment: null,
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    contactId: 42,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  }), null);
});


test("postpartum pelvic sales interest is one service, but recent birth and comparisons stay safe", async () => {
  const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
  const { qualifiedTreatmentMentions } = require("../src/utils/resultMediaTrigger");
  const media = [{ service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
    items: [{ imageUrl: "https://example.test/result.jpg", caption: "Pelvic proof" }] }];
  const services = [{ name: "骨盆调理" }, { name: "产后调理" }];
  const serviceAliases = [
    { alias: "骨盆 / pelvic adjustment", officialService: "骨盆调理" },
    { alias: "产后 / postpartum recovery", officialService: "产后调理" },
  ];
  for (const customerText of [
    "我想了解产后骨盆调理，有优惠吗？",
    "I'm interested in postpartum pelvic adjustment and its price",
  ]) {
    assert.equal(hasClinicalMediaRisk(customerText), false, customerText);
    const chosen = await resolveResultMediaForReply({
      customerText, resultMedia: media, services, serviceAliases,
      serviceQuery: false, serviceQuerySource: null, treatment: null,
      priceQuery: false, flagged: false, bookingReady: false, keywordReason: null,
      needsAttention: false, textSendSucceeded: true, contactId: 5,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
    });
    assert.equal(chosen?.service, "骨盆调理", customerText);
  }
  assert.equal(hasClinicalMediaRisk("产后骨盆调理现在RM288吗？"), false,
    "price-only postpartum pricing must remain eligible for promotion, not unsolicited proof");
  for (const customerText of [
    "我刚刚生产，想了解产后骨盆调理优惠",
    "产后两周想了解骨盆调理价格",
    "I recently gave birth and want postpartum pelvic treatment",
    "Saya baru lepas bersalin, nak rawatan pelvis",
  ]) {
    assert.equal(hasClinicalMediaRisk(customerText), true, customerText);
  }
  const twoDistinct = ["产后调理", "骨盆调理"];
  assert.deepEqual(
    qualifiedTreatmentMentions(twoDistinct, "我想了解产后调理和骨盆调理，两个有什么分别？"),
    twoDistinct
  );
  assert.deepEqual(
    qualifiedTreatmentMentions(twoDistinct, "产后骨盆调理有优惠吗？"),
    ["骨盆调理"]
  );
  const rejected = [];
  assert.equal(await resolveResultMediaForReply({
    customerText: "我想了解产后调理和骨盆调理，两个有什么分别？",
    resultMedia: media, services, serviceAliases,
    serviceQuery: true, serviceQuerySource: "customer_message",
    treatment: "骨盆调理", priceQuery: false,
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true, contactId: 5,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
    onSkip: reason => rejected.push(reason),
  }), null);
  assert.equal(rejected.at(-1), "multiple_treatments_ambiguous");
});

test("unknown/unsent result media holds suppress all automatic retries regardless of cooldown", async () => {
  const urls = ["https://example.test/result1.jpg", "https://example.test/result2.jpg"];
  const media = [{service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
    items: urls.map((imageUrl) => ({imageUrl, caption: "Before & After"}))}];
  let recentlyAcceptedLookups = 0;
  let heldReason = null;
  const chosen = await resolveResultMediaForReply({
    customerText: "我想了解骨盆调理", resultMedia: media,
    serviceQuery: true, serviceQuerySource: "customer_message", treatment: "骨盆调理",
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true, contactId: 12,
    wasMediaRecentlySent: async () => { recentlyAcceptedLookups++; return false; },
    hasUnconfirmedMediaDelivery: async (_contactId, url) => url === urls[0],
    getMostRecentlySentMediaUrl: async () => null,
    onSkip: reason => { heldReason = reason; },
  });
  assert.equal(chosen, null);
  assert.equal(heldReason, "result_media_delivery_unconfirmed");
  assert.equal(recentlyAcceptedLookups, 0);
  assert.equal(await resolveResultMediaForReply({
    customerText: "我想了解骨盆调理", resultMedia: media,
    serviceQuery: true, serviceQuerySource: "customer_message", treatment: "骨盆调理",
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true, contactId: 12,
    wasMediaRecentlySent: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  }), null, "missing unresolved-send verifier must fail closed");
});


test("postpartum interval safety detects Chinese day/week/month expressions and preserves normal package questions", async () => {
  const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
  const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
  const risky = [
    "产后7天想了解骨盆调理优惠",
    "产后第7天想了解骨盆调理价格",
    "产后十四天想了解骨盆调理",
    "产后七周问骨盆套餐",
    "产后一个月想了解骨盆调理优惠",
    "产后2个月想知道价格",
    "产后三个月想了解骨盆调理",
    "I am 1 month postpartum, pelvic treatment pricing",
    "2 weeks after delivery, how much for pelvic treatment?",
    "Saya 2 minggu selepas bersalin, nak harga rawatan pelvis",
  ];
  const okay = [
    "产后骨盆调理有什么优惠",
    "我想了解产后骨盆调理套餐",
    "产后4个月想了解骨盆调理优惠",
    "产后骨盆3个月疗程多少钱？",
    "What's the price for postpartum pelvic adjustment?",
  ];
  const promotions = [{
    name: "Pelvis Trial", linkedService: "骨盆调理", sendOnPriceQuery: true,
    imageUrl: "https://example.test/pelvis.jpg", caption: "October RM288",
  }];
  for (const customerText of risky) {
    assert.equal(hasClinicalMediaRisk(customerText), true, customerText);
    const result = await resolvePricePromotionForReply({
      priceQuery: true, treatment: "骨盆调理", customerText,
      flagged: false, bookingReady: false, keywordReason: null,
      needsAttention: false, textSendSucceeded: true, promotions, contactId: 7,
      wasPromoRecentlySent: async () => { throw new Error("unsafe media history lookup"); },
      hasUnconfirmedMediaDelivery: async () => { throw new Error("unsafe unconfirmed lookup"); },
    });
    assert.equal(result, null, customerText);
  }
  for (const customerText of okay) {
    assert.equal(hasClinicalMediaRisk(customerText), false, customerText);
  }
});

test("CTWA introduction with genuine pelvic interest sends results but not pricing", async () => {
  const { hasCustomerPriceEnquiry } = require("../src/utils/customerEnquiryEvidence");
  const { explicitServiceNamedByCustomer } = require("../src/utils/resultMediaTrigger");
  const media = [{
    service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
    autoSendCount: 2,
    items: [
      { imageUrl: "/api/config/result-media/image/11", caption: "Pelvic result 1" },
      { imageUrl: "/api/config/result-media/image/12", caption: "Pelvic result 2" },
    ],
  }];
  const introductions = [
    consentPrefill,
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi～我现在想了解骨盆调理，可以跟进我，有优惠也发我看看",
  ];
  for (const customerText of introductions) {
    assert.equal(hasCustomerPriceEnquiry(customerText), false, customerText);
    assert.equal(explicitServiceNamedByCustomer(media, customerText), "骨盆调理", customerText);
    assert.deepEqual(planResultMediaPacing({
      customerText, promotionCount: 0, items: images,
    }).items, images, customerText);
    const result = await resolveResultMediaForReply({
      customerText, treatment: null, serviceQuery: false, serviceQuerySource: null,
      priceQuery: true, packageQuery: true, // an incorrect model flag must not block genuine treatment interest
      flagged: false, bookingReady: false, keywordReason: null,
      needsAttention: false, textSendSucceeded: true,
      resultMedia: media, contactId: 383,
      wasMediaRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
    });
    assert.equal(result?.service, "骨盆调理");
    assert.equal(result?.items?.length, 2, customerText);
    assert.deepEqual(result.items.map((item) => item.imageUrl), [
      "/api/config/result-media/image/11",
      "/api/config/result-media/image/12",
    ]);
  }
  // Permission without independently expressed treatment interest is not
  // enough to unlock any service's before/after collection.
  const skipped = [];
  assert.equal(await resolveResultMediaForReply({
    customerText: "可以跟进我，有优惠也发我看看",
    treatment: "骨盆调理", serviceQuery: true, serviceQuerySource: "customer_message",
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true,
    resultMedia: media, contactId: 383,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
    onSkip: (reason) => skipped.push(reason),
  }), null);
  assert.equal(skipped.at(-1), "no_customer_service_enquiry");
  // The first two manually sent or automatically sent photos are still
  // protected from duplicates within seven days.
  const reasons = [];
  assert.equal(await resolveResultMediaForReply({
    customerText: introductions[1], treatment: "骨盆调理",
    serviceQuery: true, serviceQuerySource: "customer_message",
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true,
    resultMedia: media, contactId: 383,
    wasMediaRecentlySent: async () => true,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
    onSkip: (reason) => reasons.push(reason),
  }), null);
  assert.equal(reasons.at(-1), "result_media_recently_sent");
  // Two valid pricing graphics still leave room for at most one result.
  assert.equal(planResultMediaPacing({
    customerText: introductions[1], promotionCount: 2, items: images,
  }).items.length, 1);
});

test("future-offer permission does not override clinical and staff media blocks", async () => {
  const text = "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊";
  const baseline = {
    customerText: text, treatment: "骨盆调理",
    serviceQuery: true, serviceQuerySource: "customer_message",
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true,
    resultMedia: [{
      service: "骨盆调理", enabled: true, triggerMode: "service_enquiry",
      items: [{imageUrl:"photo1",caption:"result"}],
    }],
    contactId: 383,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  };
  assert.equal(await resolveResultMediaForReply({...baseline, needsAttention:true}),null);
  assert.equal(await resolveResultMediaForReply({...baseline, flagged:true}),null);
  assert.equal(await resolveResultMediaForReply({...baseline, textSendSucceeded:false}),null);
  assert.equal(await resolveResultMediaForReply({...baseline,
    customerText:"我刚生产两周，想了解骨盆调理，之后可以WhatsApp跟进我，有优惠也发我看看",
  }),null);
});
