const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePricePromotionForReply,
} = require("../src/utils/pricePromotionTrigger");

const nowActivePromo = {
  name: "3D First Trial",
  linkedService: "3D 小颜术",
  sendOnPriceQuery: true,
  imageUrl: "https://example.test/3d.jpg",
  caption: "3D promo",
  validFrom: null,
  validUntil: null,
};

function base(overrides = {}) {
  return {
    priceQuery: true,
    treatment: "3D 小颜术",
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: [nowActivePromo],
    contactId: 42,
    wasPromoRecentlySent: async () => false,
    ...overrides,
  };
}

test("explicit price enquiry resolves the matching service promotion", async () => {
  const calls = [];
  const promo = await resolvePricePromotionForReply(base({
    wasPromoRecentlySent: async (...args) => {
      calls.push(args);
      return false;
    },
  }));

  assert.equal(promo?.name, "3D First Trial");
  assert.deepEqual(calls, [[42, "https://example.test/3d.jpg", 24]]);
});

test("normal service questions and unknown services do not resolve promo media", async () => {
  let dedupeChecks = 0;
  const wasPromoRecentlySent = async () => {
    dedupeChecks += 1;
    return false;
  };

  assert.equal(
    await resolvePricePromotionForReply(base({
      priceQuery: false,
      wasPromoRecentlySent,
    })),
    null
  );
  assert.equal(
    await resolvePricePromotionForReply(base({
      treatment: null,
      wasPromoRecentlySent,
    })),
    null
  );
  assert.equal(
    await resolvePricePromotionForReply(base({
      treatment: "9D 逆龄抗衰",
      wasPromoRecentlySent,
    })),
    null
  );
  assert.equal(dedupeChecks, 0);
});

test("handoff, booking-ready, attention and failed text delivery all suppress promo media", async () => {
  const blockers = [
    { flagged: true },
    { bookingReady: true },
    { keywordReason: "urgent" },
    { needsAttention: true },
    { textSendSucceeded: false },
  ];

  for (const blocker of blockers) {
    assert.equal(
      await resolvePricePromotionForReply(base(blocker)),
      null,
      JSON.stringify(blocker)
    );
  }
});

test("ambiguous active promotions for one service fail closed before duplicate lookup", async () => {
  let dedupeChecks = 0;
  const promo = await resolvePricePromotionForReply(base({
    promotions: [
      nowActivePromo,
      {
        ...nowActivePromo,
        name: "3D Second Offer",
        imageUrl: "https://example.test/3d-second.jpg",
        caption: "second 3D promo",
      },
    ],
    wasPromoRecentlySent: async () => {
      dedupeChecks += 1;
      return false;
    },
  }));

  assert.equal(promo, null);
  assert.equal(dedupeChecks, 0);
});

test("same accepted promo within the duplicate window is suppressed", async () => {
  const promo = await resolvePricePromotionForReply(base({
    wasPromoRecentlySent: async () => true,
  }));
  assert.equal(promo, null);
});

test("legacy or disabled promotions fail closed", async () => {
  assert.equal(
    await resolvePricePromotionForReply(base({
      promotions: [{ ...nowActivePromo, sendOnPriceQuery: false }],
    })),
    null
  );
  assert.equal(
    await resolvePricePromotionForReply(base({
      promotions: [{ ...nowActivePromo, linkedService: "" }],
    })),
    null
  );
});
