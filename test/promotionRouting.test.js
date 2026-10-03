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

function structuredPriceReply(treatment, promotionOption = null) {
  return JSON.stringify({
    reply: "目前有优惠，我简单跟你说一下。",
    outcome: "normal",
    priceQuery: true,
    promotionOption,
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
  assert.equal(threeDPromo?.promotion?.name, "3D First Trial");
  assert.equal(threeDPromo?.packages[0]?.imageUrl, "https://example.test/3d.jpg");

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
  assert.equal(nineDPromo?.promotion?.name, "9D First Trial");
  assert.equal(nineDPromo?.packages[0]?.imageUrl, "https://example.test/9d.jpg");
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


test("pelvis generic pricing routes all packages while explicit package alias routes only Package B", async (t) => {
  const originalServices = clinicConfig.services;
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.services = originalServices;
    clinicConfig.serviceAliases = originalAliases;
  });

  clinicConfig.services = [
    { name: "Pelvis 骨盆调理", description: "", priceRange: "", duration: "" },
  ];
  clinicConfig.serviceAliases = [
    { alias: "骨盆", officialService: "Pelvis 骨盆调理" },
  ];

  const pelvisPromotion = [{
    name: "骨盆调理套餐",
    linkedService: "Pelvis 骨盆调理",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      {
        name: "Package A",
        title: "全身深层调理 + 骨盆全身体态调整（7合1）",
        aliases: ["A", "7合1"],
        imageUrl: "https://example.test/pelvis-a.jpg",
        caption: "A",
      },
      {
        name: "Package B",
        title: "骨盆 + 全身针对性调整子宫调理套餐",
        aliases: ["B", "子宫套餐", "子宫调理套餐"],
        imageUrl: "https://example.test/pelvis-b.jpg",
        caption: "B",
      },
      {
        name: "Package C",
        title: "骨盆 + 全身针对性整骨",
        aliases: ["C", "整骨套餐"],
        imageUrl: "https://example.test/pelvis-c.jpg",
        caption: "C",
      },
    ],
  }];

  const generic = parseAiReplyResult(structuredPriceReply("骨盆"));
  assert.equal(generic.details.treatment, "Pelvis 骨盆调理");
  assert.equal(generic.promotionOption, null);
  const genericBundle = await resolvePricePromotionForReply({
    priceQuery: generic.priceQuery,
    treatment: generic.details.treatment,
    customerText: "骨盆多少钱？",
    flagged: generic.flagged,
    bookingReady: generic.bookingReady,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: pelvisPromotion,
    contactId: 201,
    wasPromoRecentlySent: async () => false,
  });
  assert.deepEqual(
    genericBundle.packages.map((item) => item.name),
    ["Package A", "Package B", "Package C"]
  );

  const packageB = parseAiReplyResult(
    structuredPriceReply("骨盆", "Package B")
  );
  const packageBBundle = await resolvePricePromotionForReply({
    priceQuery: packageB.priceQuery,
    treatment: packageB.details.treatment,
    customerText: "Package B多少钱？",
    flagged: packageB.flagged,
    bookingReady: packageB.bookingReady,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: pelvisPromotion,
    contactId: 202,
    wasPromoRecentlySent: async () => false,
  });
  assert.deepEqual(
    packageBBundle.packages.map((item) => item.name),
    ["Package B"]
  );

  const aliasBundle = await resolvePricePromotionForReply({
    priceQuery: true,
    treatment: "Pelvis 骨盆调理",
    customerText: "子宫套餐多少钱？",
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: pelvisPromotion,
    contactId: 203,
    wasPromoRecentlySent: async () => false,
  });
  assert.deepEqual(aliasBundle.packages.map((item) => item.name), ["Package B"]);
});
