const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");
const {
  resolvePricePromotionForReply,
} = require("../src/utils/pricePromotionTrigger");

const promotions = [
  {
    name: "3D First Trial",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "https://example.test/3d.jpg",
    caption: "3D promo",
    validFrom: null,
    validUntil: null,
  },
  {
    name: "9D First Trial",
    linkedService: "9D 逆龄抗衰",
    sendOnPriceQuery: true,
    imageUrl: "https://example.test/9d.jpg",
    caption: "9D promo",
    validFrom: null,
    validUntil: null,
  },
];

function structuredPriceReply(treatment) {
  return JSON.stringify({
    reply: "目前有优惠，我简单跟你说一下。",
    outcome: "normal",
    priceQuery: true,
    treatment,
    branch: null,
    appointmentPreference: null,
  });
}

test("3D and 9D price enquiries route to their own linked promotions", async (t) => {
  const originalServices = clinicConfig.services;
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.services = originalServices;
    clinicConfig.serviceAliases = originalAliases;
  });

  clinicConfig.services = [
    { name: "3D 小颜术", description: "", priceRange: "", duration: "" },
    { name: "9D 逆龄抗衰", description: "", priceRange: "", duration: "" },
  ];
  clinicConfig.serviceAliases = [
    { alias: "3D", officialService: "3D 小颜术" },
    { alias: "小脸", officialService: "3D 小颜术" },
    { alias: "9D", officialService: "9D 逆龄抗衰" },
  ];

  const threeD = parseAiReplyResult(structuredPriceReply("3D"));
  assert.equal(threeD.details.treatment, "3D 小颜术");
  const threeDPromo = await resolvePricePromotionForReply({
    priceQuery: threeD.priceQuery,
    treatment: threeD.details.treatment,
    flagged: threeD.flagged,
    bookingReady: threeD.bookingReady,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions,
    contactId: 101,
    wasPromoRecentlySent: async () => false,
  });
  assert.equal(threeDPromo?.name, "3D First Trial");
  assert.equal(threeDPromo?.imageUrl, "https://example.test/3d.jpg");

  const nineD = parseAiReplyResult(structuredPriceReply("9D"));
  assert.equal(nineD.details.treatment, "9D 逆龄抗衰");
  const nineDPromo = await resolvePricePromotionForReply({
    priceQuery: nineD.priceQuery,
    treatment: nineD.details.treatment,
    flagged: nineD.flagged,
    bookingReady: nineD.bookingReady,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions,
    contactId: 102,
    wasPromoRecentlySent: async () => false,
  });
  assert.equal(nineDPromo?.name, "9D First Trial");
  assert.equal(nineDPromo?.imageUrl, "https://example.test/9d.jpg");
});

test("an unknown or ambiguous service never falls back to another service's promotion", async (t) => {
  const originalServices = clinicConfig.services;
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.services = originalServices;
    clinicConfig.serviceAliases = originalAliases;
  });

  clinicConfig.services = [
    { name: "3D 小颜术", description: "", priceRange: "", duration: "" },
    { name: "9D 逆龄抗衰", description: "", priceRange: "", duration: "" },
  ];
  clinicConfig.serviceAliases = [];

  const parsed = parseAiReplyResult(structuredPriceReply("facial"));
  assert.equal(parsed.details.treatment, null);

  const selected = await resolvePricePromotionForReply({
    priceQuery: parsed.priceQuery,
    treatment: parsed.details.treatment,
    flagged: parsed.flagged,
    bookingReady: parsed.bookingReady,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions,
    contactId: 103,
    wasPromoRecentlySent: async () => false,
  });

  assert.equal(selected, null);
});
