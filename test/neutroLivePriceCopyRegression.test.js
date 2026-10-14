"use strict";

// Representative bilingual October captions from Neutro's production pricing
// configuration. Unlike small unit fixtures, this includes the pre-voucher
// amount, separate RM100 voucher, emojis, and optional follow-up text.
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { verifiedPricesForService, ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("../src/utils/initialOfferReplyGuard");

const services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }];
const serviceAliases = [
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "Pelvic", officialService: "骨盆调理" },
  { alias: "Pelvis", officialService: "骨盆调理" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理",
  sendOnPriceQuery: true,
  packages: [
    {
      name: "Package A", title: "尊享护理配套",
      imageUrl: "https://example.test/promo-images/30",
      caption: "本月限时优惠 🔥\nRM100 优惠券限时领取（只限100位）\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
      followUpMessage: "RM100 优惠券限时领取（只限100位）\n先到先得！🔥",
      mediaTranslations: {
        en: { caption: "Limited-time offer this month 🔥\nRM100 voucher available for a limited time\nPromo price RM488\nAfter voucher, only RM3️⃣8️⃣8️⃣" },
        ms: { caption: "Promosi masa terhad bulan ini 🔥\nBaucar RM100 untuk masa terhad\nHarga promosi RM488\nSelepas baucar, hanya RM3️⃣8️⃣8️⃣" },
      },
      followUpTranslations: {
        en: "RM100 voucher available for a limited time",
        ms: "Baucar RM100 untuk masa terhad",
      },
    },
    {
      name: "Package B", title: "女性护理配套",
      imageUrl: "https://example.test/promo-images/31",
      caption: "本月限时优惠 🔥 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣",
      followUpMessage: "本月限时优惠 🔥 RM100 OFF\n先到先得 🤩",
      mediaTranslations: {
        en: { caption: "Limited-time offer this month 🔥 RM100 OFF\nOriginal price RM388\nNow only RM2️⃣8️⃣8️⃣" },
        ms: { caption: "Promosi masa terhad bulan ini 🔥 RM100 OFF\nHarga asal RM388\nSekarang hanya RM2️⃣8️⃣8️⃣" },
      },
    },
  ],
}, {
  name: "3D 小颜术 First Trial", linkedService: "3D 小颜术",
  sendOnPriceQuery: true,
  caption: "【中医小颜术】是一项中医的治疗项目",
  imageUrl: "https://example.test/promo-images/32",
  followUpMessage: "🎊 限时优惠 🥳\n💎只需 RM 4️⃣8️⃣8️⃣\n( 原价 RM888)",
  followUpTranslations: {
    en: "🎊 Limited-time offer 🥳\n💎 RM 4️⃣8️⃣8️⃣\n(Original price RM888)",
    ms: "🎊 Promosi masa terhad 🥳\n💎 RM 4️⃣8️⃣8️⃣\n(Harga asal RM888)",
  },
}, {
  name: "9D 逆龄抗衰 First Trial", linkedService: "9D 逆龄抗衰",
  sendOnPriceQuery: true,
  caption: "先让你了解一下 9D 逆龄抗衰精雕",
  imageUrl: "https://example.test/promo-images/21",
  followUpMessage: "🎊 限时优惠 🥳\n💎只需要 RM 4️⃣8️⃣8️⃣\n( 原价 RM1,288)",
  followUpTranslations: {
    en: "🎊 Limited-time offer 🥳\n💎 RM 4️⃣8️⃣8️⃣\n(Original price RM1,288)",
    ms: "🎊 Promosi masa terhad 🥳\n💎 RM 4️⃣8️⃣8️⃣\n(Harga asal RM1,288)",
  },
}];

async function duringAssessmentFirst(callback) {
  const original = config.automatedFollowUp;
  config.automatedFollowUp = { ...original, assessmentFirstPricingEnabled: true };
  try { return await callback(); }
  finally { config.automatedFollowUp = original; }
}

test("actual style of October multilingual promo copy supports independently verified prices", () => {
  // Use a fixed date for the active-promotion check, but keep the fixture
  // independent of the live October expiry so future CI stays deterministic.
  const date = new Date("2026-10-14T09:00:00Z");
  const { getActivePromotions } = require("../src/utils/activePromotion");
  const offers = getActivePromotions(promotions, date);
  assert.equal(offers.length, 3);
  // Regression: the real configured media includes a discounted amount and
  // an earlier pre-voucher amount. Both must not become conflicting sale prices.
  const { configuredOfferPrice } = require("../src/utils/verifiedPriceReply");
  assert.equal(configuredOfferPrice(promotions[0].packages[0].caption), "RM388");
  assert.equal(configuredOfferPrice(promotions[0].packages[0].mediaTranslations.en.caption), "RM388");
  assert.equal(configuredOfferPrice(promotions[0].packages[0].mediaTranslations.ms.caption), "RM388");
  assert.equal(configuredOfferPrice(promotions[0].packages[1].mediaTranslations.en.caption), "RM288");
  assert.equal(configuredOfferPrice(promotions[0].packages[1].mediaTranslations.ms.caption), "RM288");
  assert.equal(configuredOfferPrice(promotions[1].followUpTranslations.en), "RM488");
  assert.equal(configuredOfferPrice(promotions[2].followUpTranslations.ms), "RM488");
});

test("mixed-language pelvic price question gets both quotes and images with these captions", async () => {
  await duringAssessmentFirst(async () => {
    const question = "Pelvic 价钱?";
    const service = safeServiceFromCustomer(question, services, serviceAliases)?.name;
    assert.equal(service, "骨盆调理");
    assert.equal(hasExplicitPriceRequest(question), true);
    const offer = ensureVerifiedPriceReply({
      customerText: question, reply: "先过来评估～",
      treatment: service, promotions, services, serviceAliases, resultMedia: [],
    });
    assert.equal(offer.restored, true);
    assert.match(offer.reply, /Package A.*RM388/su);
    assert.match(offer.reply, /Package B.*RM288/su);
    const media = await resolvePricePromotionForReply({
      customerText: question, treatment: service, verifiedServiceFromText: service,
      promotions, services, serviceAliases, resultMedia: [],
      textSendSucceeded: true, contactId: 26, language: "zh",
      wasPromoRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
    });
    assert.deepEqual(media?.packages.map((p) => p.name), ["Package A", "Package B"]);
  });
});

test("explicit 3D First Trial price request returns RM488 and only the matching 3D graphic", async () => {
  await duringAssessmentFirst(async () => {
    const current = "3D First Trial 多少钱？";
    const service = safeServiceFromCustomer(current, services, serviceAliases)?.name;
    assert.equal(service, "3D 小颜术");
    assert.equal(hasExplicitPriceRequest(current), true);

    const restored = ensureVerifiedPriceReply({
      customerText: current, reply: "可以先来做免费评估体验 😊",
      treatment: service, promotions, services, serviceAliases,
      resultMedia: [], language: "zh",
    });
    assert.equal(restored.restored, true);
    assert.match(restored.reply, /3D 小颜术.*RM488/su);
    assert.doesNotMatch(restored.reply, /RM288|RM388|RM1,288|9D/u);

    const shared = {
      customerText: current, treatment: service, verifiedServiceFromText: service,
      priceQuery: false, packageQuery: false, flagged: false, bookingReady: false,
      keywordReason: false, needsAttention: false,
      promotions, services, serviceAliases, resultMedia: [],
      textSendSucceeded: true, contactId: 338, language: "zh",
      wasPromoRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
    };
    const media = await resolvePricePromotionForReply(shared);
    assert.equal(media?.packages?.length, 1);
    assert.equal(media.packages[0].imageUrl, "https://example.test/promo-images/32");
    assert.equal(media.packages[0].name, "Main offer");
    assert.equal(media.promotion?.name, "3D 小颜术 First Trial");
    assert.ok(media.packages[0].caption, "the matching media must have a caption");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, textSendSucceeded: false,
    }), null, "provider-rejected text cannot trigger an independent promotion graphic");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, wasPromoRecentlySent: async () => true,
    }), null, "do not resend a duplicate graphic");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, hasUnconfirmedMediaDelivery: async () => true,
    }), null, "unknown delivery blocks duplicate-media retries");

    for (const message of ["想了解3D小颜术", "3D First Trial 是做什么的？", "3D 有什么优惠？"]) {
      const currentService = safeServiceFromCustomer(message, services, serviceAliases)?.name;
      assert.equal(await resolvePricePromotionForReply({
        ...shared, customerText: message, treatment: currentService,
        verifiedServiceFromText: currentService,
      }), null, "no unsolicited price graphics: " + message);
    }
  });
});
