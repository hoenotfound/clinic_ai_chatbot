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
    packageQuery: false,
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

  assert.equal(promo?.promotion?.name, "3D First Trial");
  assert.deepEqual(promo?.packages.map((item) => item.imageUrl), ["https://example.test/3d.jpg"]);
  assert.deepEqual(calls, [[42, "https://example.test/3d.jpg", "3D promo", 24]]);
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


test("generic package price enquiry returns all unsent package options", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
      { name: "Package C", title: "", aliases: ["C"], imageUrl: "https://example.test/c.jpg", caption: "C promo" },
    ],
  };
  const calls = [];
  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    wasPromoRecentlySent: async (...args) => {
      calls.push(args);
      return false;
    },
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B", "Package C"]);
  assert.equal(calls.length, 3);
});

test("specific package enquiry sends only that configured package", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "子宫调理套餐", aliases: ["B", "子宫套餐"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };
  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "子宫套餐多少钱？",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package B"]);
});

test("per-package duplicate suppression keeps only unsent package options", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: [], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: [], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
      { name: "Package C", title: "", aliases: [], imageUrl: "https://example.test/c.jpg", caption: "C promo" },
    ],
  };
  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    wasPromoRecentlySent: async (_contactId, imageUrl) =>
      imageUrl === "https://example.test/a.jpg",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package B", "Package C"]);
});

test("generic customer price enquiry is never narrowed by a model-only package guess", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: [], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: [], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };
  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "多少钱？",
  }));
  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B"]);
});


test("explicit current-message package wording overrides an incorrect model package label", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "子宫调理套餐", aliases: ["B", "子宫套餐"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };
  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "Package B多少钱？",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package B"]);
});

test("single-letter package aliases beside Chinese text are detected separately", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  assert.equal(
    await resolvePricePromotionForReply(base({
      promotions: [packagePromo],
      customerText: "A跟B多少钱？",
    })),
    null
  );
});

test("mentioning multiple configured packages in the current price question sends no automatic media", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };
  assert.equal(
    await resolvePricePromotionForReply(base({
      promotions: [packagePromo],
      customerText: "Package A 跟 Package B 分别多少钱？",
    })),
    null
  );
});


test("explicit package-list enquiry can send packages without a price question", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    priceQuery: false,
    packageQuery: true,
    promotions: [packagePromo],
    customerText: "有什么package？",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B"]);
});

test("mentioning a package in a normal suitability question does not trigger media", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  assert.equal(
    await resolvePricePromotionForReply(base({
      priceQuery: false,
      packageQuery: false,
      customerText: "Package B适合产后吗？",
      promotions: [packagePromo],
    })),
    null
  );
});


test("short price follow-up reuses the most recent customer-named package", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "子宫调理套餐", aliases: ["B", "子宫套餐"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "多少钱？",
    conversationHistory: [
      { role: "user", content: "我想了解子宫套餐" },
      { role: "assistant", content: "可以，你想了解哪方面？" },
      { role: "user", content: "多少钱？" },
    ],
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package B"]);
});

test("generic price enquiry with no package context returns all configured package options", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "骨盆多少钱？",
    conversationHistory: [
      { role: "user", content: "我想了解骨盆" },
      { role: "assistant", content: "可以的" },
      { role: "user", content: "骨盆多少钱？" },
    ],
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B"]);
});


test("older package mentions do not narrow a later generic price enquiry after an unrelated customer turn", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "子宫调理套餐", aliases: ["B", "子宫套餐"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "多少钱？",
    conversationHistory: [
      { role: "user", content: "我想了解子宫套餐" },
      { role: "assistant", content: "可以的" },
      { role: "user", content: "一般多久做一次？" },
      { role: "assistant", content: "会看个人情况" },
      { role: "user", content: "多少钱？" },
    ],
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B"]);
});


test("generic English and Malaysian package wording does not falsely match Package A", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
      { name: "Package C", title: "", aliases: ["C"], imageUrl: "https://example.test/c.jpg", caption: "C promo" },
    ],
  };

  for (const customerText of ["what package available?", "package apa ada?"]) {
    const bundle = await resolvePricePromotionForReply(base({
      priceQuery: false,
      packageQuery: true,
      promotions: [packagePromo],
      customerText,
    }));
    assert.deepEqual(
      bundle.packages.map((item) => item.name),
      ["Package A", "Package B", "Package C"],
      customerText
    );
  }
});

test("concatenated explicit PackageB wording still resolves Package B", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "PackageB多少钱？",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package B"]);
});


test("lowercase English article a does not select Package A", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    priceQuery: false,
    packageQuery: true,
    promotions: [packagePromo],
    customerText: "do you have a package?",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A", "Package B"]);
});

test("explicit uppercase single-letter alias still selects its package", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "A多少钱？",
  }));

  assert.deepEqual(bundle.packages.map((item) => item.name), ["Package A"]);
});

test("short follow-up after multiple packages were named fails closed", async () => {
  const packagePromo = {
    name: "Pelvis Packages",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    imageUrl: "",
    caption: "",
    validFrom: null,
    validUntil: null,
    packages: [
      { name: "Package A", title: "", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A promo" },
      { name: "Package B", title: "", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B promo" },
      { name: "Package C", title: "", aliases: ["C"], imageUrl: "https://example.test/c.jpg", caption: "C promo" },
    ],
  };

  const bundle = await resolvePricePromotionForReply(base({
    promotions: [packagePromo],
    customerText: "多少钱？",
    conversationHistory: [
      { role: "user", content: "Package A 跟 Package B 有什么分别？" },
      { role: "assistant", content: "主要差别在配套内容。" },
      { role: "user", content: "多少钱？" },
    ],
  }));

  assert.equal(bundle, null);
});

test("promotion media uses the configured customer-language image and caption with per-field fallback", async () => {
  const localizedPromo = {
    ...nowActivePromo,
    mediaTranslations: {
      zh: {
        imageUrl: "https://example.test/3d-zh.jpg",
        caption: "3D 中文优惠",
      },
      ms: {
        caption: "Promosi 3D BM",
      },
    },
  };

  const zhCalls = [];
  const zh = await resolvePricePromotionForReply(base({
    promotions: [localizedPromo],
    language: "zh",
    wasPromoRecentlySent: async (...args) => {
      zhCalls.push(args);
      return false;
    },
  }));
  assert.equal(zh.packages[0].imageUrl, "https://example.test/3d-zh.jpg");
  assert.equal(zh.packages[0].caption, "3D 中文优惠");
  assert.deepEqual(zhCalls, [[42, "https://example.test/3d-zh.jpg", "3D 中文优惠", 24]]);

  const ms = await resolvePricePromotionForReply(base({
    promotions: [localizedPromo],
    language: "ms",
  }));
  assert.equal(ms.packages[0].imageUrl, "https://example.test/3d.jpg");
  assert.equal(ms.packages[0].caption, "Promosi 3D BM");
});
