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
    customerText: "How much for 3D 小颜术?",
    treatment: "3D 小颜术",
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions: [nowActivePromo],
    contactId: 42,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
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
  assert.deepEqual(zhCalls, [
    [42, "https://example.test/3d.jpg", "3D promo", 24],
    [42, "https://example.test/3d.jpg", "Promosi 3D BM", 24],
    [42, "https://example.test/3d-zh.jpg", "3D 中文优惠", 24],
  ]);

  const ms = await resolvePricePromotionForReply(base({
    promotions: [localizedPromo],
    language: "ms",
  }));
  assert.equal(ms.packages[0].imageUrl, "https://example.test/3d.jpg");
  assert.equal(ms.packages[0].caption, "Promosi 3D BM");
});

test("promotion duplicate guard treats translated versions as the same package", async () => {
  const localizedPromo = {
    ...nowActivePromo,
    mediaTranslations: {
      zh: {
        imageUrl: "https://example.test/3d-zh.jpg",
        caption: "3D 中文优惠",
      },
    },
  };
  const result = await resolvePricePromotionForReply(base({
    promotions: [localizedPromo],
    language: "zh",
    wasPromoRecentlySent: async (_contactId, imageUrl, caption) =>
      imageUrl === "https://example.test/3d.jpg" && caption === "3D promo",
  }));
  assert.equal(result, null);
});


test("greetings and language-only turns never send a price image even if AI reports a price query", async () => {
  for (const customerText of ["English", "Hi, English", "BM", "Hello", "中文", "OK", "Thanks", "Noted", "收到"]) {
    let queried = false;
    const result = await resolvePricePromotionForReply(base({
      customerText,
      priceQuery: true,
      packageQuery: true,
      wasPromoRecentlySent: async () => { queried = true; return false; },
    }));
    assert.equal(result, null, customerText);
    assert.equal(queried, false);
  }
  const permitted = await resolvePricePromotionForReply(base({
    customerText: "Hi, what is the price for 3D 小颜术?",
  }));
  assert.ok(permitted?.packages?.length);
});


test("AI price-query flag cannot trigger pricing graphics for Malay session or duration questions", async () => {
  for (const customerText of [
    "Berapa lama rawatan ini?",
    "Berapa kali kena datang?",
    "Berapa sesi diperlukan untuk rawatan?",
    "Berapa minit 3D?",
    "What is your contact information?",
  ]) {
    let attempted = false;
    assert.equal(await resolvePricePromotionForReply(base({
      customerText,
      priceQuery: true,
      packageQuery: true,
      wasPromoRecentlySent: async () => { attempted = true; return false; },
    })), null, customerText);
    assert.equal(attempted, false);
  }
});


test("misclassified English how-much duration questions do not send price media", async () => {
  for (const customerText of [
    "How much time does the 3D treatment take?",
    "How much recovery time after 3D?",
    "How much longer before the treatment ends?",
    "How much pain does pelvic treatment cause?",
  ]) {
    let checked = false;
    const result = await resolvePricePromotionForReply(base({
      customerText,
      priceQuery: true, // Simulate a mistaken AI classification.
      wasPromoRecentlySent: async () => { checked = true; return false; },
    }));
    assert.equal(result, null, customerText);
    assert.equal(checked, false, customerText);
  }

  const actualPrice = await resolvePricePromotionForReply(base({
    customerText: "How much time does 3D take, and how much is it?",
  }));
  assert.ok(actualPrice?.packages?.length);
});


test("English recovery time and waiting questions are never price-media triggers", async () => {
  for (const customerText of [
    "How much is the recovery time?",
    "How much should I wait after pelvic treatment?",
    "How much will it take to recover?",
  ]) {
    let mediaLookup = false;
    const result = await resolvePricePromotionForReply(base({
      customerText,
      priceQuery: true,
      packageQuery: true,
      wasPromoRecentlySent: async () => { mediaLookup = true; return false; },
    }));
    assert.equal(result, null, customerText);
    assert.equal(mediaLookup, false, customerText);
  }
  assert.ok(await resolvePricePromotionForReply(base({
    customerText: "How much is the recovery time and what is the price?",
  })));
});


test("unresolved provider delivery blocks promotional images even after the standard cooldown", async () => {
  const checks = [];
  const attemptedAcceptedHistory = [];
  const unresolved = await resolvePricePromotionForReply(base({
    hasUnconfirmedMediaDelivery: async (contactId, imageUrl) => {
      checks.push([contactId, imageUrl]);
      return imageUrl === nowActivePromo.imageUrl;
    },
    wasPromoRecentlySent: async (...args) => {
      attemptedAcceptedHistory.push(args);
      return false;
    },
  }));
  assert.equal(unresolved, null);
  assert.deepEqual(checks, [[42, nowActivePromo.imageUrl]]);
  assert.equal(attemptedAcceptedHistory.length, 0,
    "unresolved delivery must be checked before the accepted-send cooldown");
  assert.equal(await resolvePricePromotionForReply(base({
    hasUnconfirmedMediaDelivery: undefined,
  })), null, "missing delivery verifier fails closed rather than permitting a repeat");
  assert.equal(await resolvePricePromotionForReply(base({
    hasUnconfirmedMediaDelivery: async () => { throw new Error("test provider receipt unavailable"); },
  })), null, "a verifier outage must suppress optional media without breaking the AI reply");
  assert.ok((await resolvePricePromotionForReply(base({
    hasUnconfirmedMediaDelivery: async () => false,
  })))?.packages?.length, "a reconciled image remains eligible under existing normal rules");
});

test("an unconfirmed translated promotional graphic blocks every language of the package", async () => {
  const localizedPromo = {
    ...nowActivePromo,
    mediaTranslations: {
      zh: { imageUrl: "https://example.test/3d-zh.jpg", caption: "3D 中文优惠" },
      ms: { imageUrl: "https://example.test/3d-ms.jpg", caption: "Promosi 3D" },
    },
  };
  const lookups = [];
  for (const language of ["en", "zh", "ms"]) {
    const result = await resolvePricePromotionForReply(base({
      promotions: [localizedPromo], language,
      hasUnconfirmedMediaDelivery: async (contactId, imageUrl) => {
        lookups.push({ language, contactId, imageUrl });
        return imageUrl === "https://example.test/3d-zh.jpg";
      },
      wasPromoRecentlySent: async () => false,
    }));
    assert.equal(result, null, language);
    assert.ok(lookups.some((call) =>
      call.language === language && call.imageUrl === "https://example.test/3d-zh.jpg"
    ), "must consult translated variants even if the customer prefers another language");
  }
});

test("one unconfirmed option holds an entire multi-package pricing sequence", async () => {
  const bundle = {
    name: "Pelvis October",
    linkedService: "3D 小颜术",
    sendOnPriceQuery: true,
    packages: [
      { name: "Package A", aliases: ["A"], imageUrl: "https://example.test/a.jpg", caption: "A offer" },
      { name: "Package B", aliases: ["B"], imageUrl: "https://example.test/b.jpg", caption: "B offer" },
    ],
  };
  let lookups = 0;
  const decision = await resolvePricePromotionForReply(base({
    promotions: [bundle],
    customerText: "How much is the offer?",
    conversationHistory: [],
    hasUnconfirmedMediaDelivery: async (_contactId, imageUrl) => {
      lookups++;
      return imageUrl.endsWith("/b.jpg");
    },
    wasPromoRecentlySent: async () => false,
  }));
  assert.equal(decision, null, "do not send only half of the configured A/B package bundle");
  assert.ok(lookups >= 2);
});

test("CTWA service-interest opt-ins cannot auto-send pricing even when AI sets priceQuery", async () => {
  const promo = {
    name:"Pelvis Trial",linkedService:"骨盆调理",sendOnPriceQuery:true,
    imageUrl:"https://example.test/pelvic-promo.jpg",caption:"RM388",
  };
  const opts = base({
    treatment:"骨盆调理",promotions:[promo],
    priceQuery:true,packageQuery:true,
  });
  const prefills = [
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi～我现在想了解骨盆调理，可以跟进我，有优惠也发我看看",
  ];
  for (const customerText of prefills) {
    assert.equal(await resolvePricePromotionForReply({...opts,customerText}),null,customerText);
  }
  const real = await resolvePricePromotionForReply({
    ...opts,customerText:prefills[1]+"。骨盆套餐有哪些？",
  });
  assert.equal(real?.packages?.length,1);
});

test("runtime promotion resolver never sends graphics for a package explanation despite model packageQuery", async () => {
  const promo = {
    name: "Pelvis Offer", linkedService: "骨盆调理",
    sendOnPriceQuery: true, imageUrl: "https://example.test/pelvis.jpg",
    caption: "RM388",
  };
  const opts = base({
    priceQuery: true, packageQuery: true,
    treatment: "骨盆调理", promotions: [promo],
  });
  for (const customerText of [
    "Hi～我想了解 Neutro Sense TCM 的骨盆配套。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "可以介绍一下骨盆配套吗？",
    "Tell me the details of the pelvic package",
    "I want to know how Package B works",
  ]) {
    assert.equal(await resolvePricePromotionForReply({ ...opts, customerText }), null, customerText);
  }
  for (const customerText of ["你们有什么骨盆配套？", "骨盆套餐多少钱？"]) {
    const result = await resolvePricePromotionForReply({ ...opts, customerText });
    assert.equal(result?.promotion?.name, "Pelvis Offer", customerText);
  }
});

test("package information does not activate automatic promotion media", async () => {
  const promo = {
    name: "Pelvic Offer", linkedService: "骨盆调理",
    sendOnPriceQuery: true, imageUrl: "https://example.test/pelvis.jpg",
    caption: "RM388",
  };
  const baseReply = base({
    treatment: "骨盆调理", promotions: [promo],
    priceQuery: true, packageQuery: true,
  });
  for (const customerText of [
    "Please send me package details",
    "Show me this treatment package",
    "Can you send me the pelvic package details?",
    "What are the package details?",
    "Can I get details about package B?",
    "可以发我骨盆配套介绍吗？",
    "你们的配套内容是什么？",
  ]) {
    const result = await resolvePricePromotionForReply({
      ...baseReply, customerText,
    });
    assert.equal(result, null, customerText);
  }
  for (const customerText of [
    "你们有什么骨盆配套？", "骨盆套餐多少钱？", "Package B?",
    "What packages are available?",
  ]) {
    const result = await resolvePricePromotionForReply({
      ...baseReply, customerText,
    });
    assert.equal(result?.promotion?.name, "Pelvic Offer", customerText);
  }
});


test("marketing refusals are not automatic price/media requests even if model flags pricing", async () => {
  const offer = {
    name: "Pelvic Offer", linkedService: "骨盆调理",
    sendOnPriceQuery: true, imageUrl: "https://example.test/pelvis-promo.jpg",
    caption: "RM388",
  };
  for (const customerText of [
    "No promotions please, just explain pelvic treatment",
    "No more offers please. How long does pelvic treatment take?",
    "Don't send me promotions, can you explain how 3D works?",
  ]) {
    const result = await resolvePricePromotionForReply(base({
      customerText, treatment: "骨盆调理",
      promotions: [offer], priceQuery: true, packageQuery: true,
    }));
    assert.equal(result, null, customerText);
  }
});
