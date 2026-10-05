const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePricePromotionForReply,
} = require("../src/utils/pricePromotionTrigger");
const {
  resolveResultMediaForReply,
} = require("../src/utils/resultMediaTrigger");

const treatment = "3D 小颜术";

const promotions = [{
  name: "3D First Trial",
  linkedService: treatment,
  sendOnPriceQuery: true,
  imageUrl: "",
  caption: "",
  packages: [{
    name: "First Trial",
    aliases: ["trial"],
    imageUrl: "https://example.test/promo-images/201",
    caption: "3D First Trial RM488",
  }],
  validFrom: null,
  validUntil: null,
}];

const resultMedia = [{
  service: treatment,
  enabled: true,
  sendAfterPrice: true,
  autoSendCount: 1,
  items: [{
    imageUrl: "https://example.test/promo-images/301",
    caption: "3D Before & After example",
  }],
}];

async function runSuccessfulPriceTurn() {
  const events = ["text"];
  const promoBundle = await resolvePricePromotionForReply({
    priceQuery: true,
    packageQuery: false,
    treatment,
    customerText: "3D多少钱？",
    conversationHistory: [{ role: "user", content: "3D多少钱？" }],
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions,
    contactId: 42,
    wasPromoRecentlySent: async () => false,
  });

  for (const item of promoBundle?.packages || []) {
    events.push(`promo:${item.imageUrl}`);
  }

  if ((promoBundle?.packages?.length || 0) <= 1) {
    const resultBundle = await resolveResultMediaForReply({
      priceQuery: true,
      packageQuery: false,
      treatment,
      flagged: false,
      bookingReady: false,
      keywordReason: null,
      needsAttention: false,
      textSendSucceeded: true,
      resultMedia,
      contactId: 42,
      wasMediaRecentlySent: async () => false,
      getMostRecentlySentMediaUrl: async () => null,
    });
    for (const item of resultBundle?.items || []) {
      events.push(`result:${item.imageUrl}`);
    }
  }

  return events;
}

test("successful price flow resolves text then promo then result media", async () => {
  assert.deepEqual(await runSuccessfulPriceTurn(), [
    "text",
    "promo:https://example.test/promo-images/201",
    "result:https://example.test/promo-images/301",
  ]);
});

test("multi-package promo burst suppresses result media in the combined flow", async () => {
  const multiPromotions = [{
    ...promotions[0],
    packages: [
      promotions[0].packages[0],
      {
        name: "Package B",
        aliases: ["b"],
        imageUrl: "https://example.test/promo-images/202",
        caption: "Package B RM688",
      },
    ],
  }];

  const events = ["text"];
  const promoBundle = await resolvePricePromotionForReply({
    priceQuery: true,
    packageQuery: false,
    treatment,
    customerText: "3D多少钱？",
    conversationHistory: [{ role: "user", content: "3D多少钱？" }],
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: multiPromotions,
    contactId: 42,
    wasPromoRecentlySent: async () => false,
  });

  for (const item of promoBundle?.packages || []) {
    events.push(`promo:${item.imageUrl}`);
  }
  if ((promoBundle?.packages?.length || 0) <= 1) {
    events.push("result");
  }

  assert.deepEqual(events, [
    "text",
    "promo:https://example.test/promo-images/201",
    "promo:https://example.test/promo-images/202",
  ]);
});


test("clear service enquiry can send result media immediately after the AI reply", async () => {
  const events = ["text"];
  const serviceResultMedia = [{
    ...resultMedia[0],
    triggerMode: "service_enquiry",
    sendAfterPrice: undefined,
  }];

  const resultBundle = await resolveResultMediaForReply({
    serviceQuery: true,
    serviceQuerySource: "meta_ad",
    priceQuery: false,
    packageQuery: false,
    treatment,
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    resultMedia: serviceResultMedia,
    contactId: 42,
    wasMediaRecentlySent: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  });

  for (const item of resultBundle?.items || []) {
    events.push(`result:${item.imageUrl}`);
  }

  assert.deepEqual(events, [
    "text",
    "result:https://example.test/promo-images/301",
  ]);
});

test("a non-service admin turn does not send result media even when treatment context exists", async () => {
  const resultBundle = await resolveResultMediaForReply({
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    packageQuery: false,
    treatment,
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    resultMedia: [{
      ...resultMedia[0],
      triggerMode: "service_enquiry",
      sendAfterPrice: undefined,
    }],
    contactId: 42,
    wasMediaRecentlySent: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
  });

  assert.equal(resultBundle, null);
});
