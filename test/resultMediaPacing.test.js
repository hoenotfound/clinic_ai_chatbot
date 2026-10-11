const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_AUTOMATIC_IMAGES_PER_REPLY,
  RESULT_MEDIA_SEND_SPACING_MS,
  planResultMediaPacing,
} = require("../src/utils/resultMediaPacing");
const { resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");

const images = [{ imageUrl: "result-1" }, { imageUrl: "result-2" }];
const combinedEnquiry = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊";

test("price-only enquiry prioritizes two pricing graphics over optional proof", () => {
  for (const customerText of ["了价格", "骨盆配套 RM388 多少钱?", "3D多少钱？", "How much is the treatment?"]) {
    const p = planResultMediaPacing({ customerText, promotionCount: 2, items: images });
    assert.deepEqual(p.items, [], customerText);
    assert.equal(p.reason, "promotion_price_priority");
  }
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
  const customerText = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊";
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
  assert.match(server, /for \(const promoPackage of pacedPromotions\.items\)/);
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
    getMostRecentlySentMediaUrl: async () => null,
  }), null);
});
