const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
  normalizeResultMediaTriggerMode,
  rotateAfter,
  resolveResultMediaForReply,
} = require("../src/utils/resultMediaTrigger");

const resultMedia = [
  {
    service: "3D 小颜术",
    enabled: true,
    sendAfterPrice: true,
    autoSendCount: 1,
    items: [
      {
        imageUrl: "https://example.test/3d-1.jpg",
        caption: "3D example 1",
      },
      {
        imageUrl: "https://example.test/3d-2.jpg",
        caption: "3D example 2",
      },
    ],
  },
];

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
    resultMedia,
    contactId: 42,
    wasMediaRecentlySent: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
    ...overrides,
  };
}

test("price enquiry resolves one approved service-level result example", async () => {
  const recentCalls = [];
  const historyCalls = [];
  const selected = await resolveResultMediaForReply(base({
    wasMediaRecentlySent: async (...args) => {
      recentCalls.push(args);
      return false;
    },
    getMostRecentlySentMediaUrl: async (...args) => {
      historyCalls.push(args);
      return null;
    },
  }));

  assert.equal(selected.service, "3D 小颜术");
  assert.deepEqual(selected.items, [resultMedia[0].items[0]]);
  assert.deepEqual(recentCalls, [
    [42, "https://example.test/3d-1.jpg", DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS],
    [42, "https://example.test/3d-2.jpg", DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS],
  ]);
  assert.deepEqual(historyCalls, [[
    42,
    [
      "https://example.test/3d-1.jpg",
      "https://example.test/3d-2.jpg",
    ],
  ]]);
});

test("after the cooldown expires, automatic result media rotates after the last accepted example", async () => {
  const selected = await resolveResultMediaForReply(base({
    getMostRecentlySentMediaUrl: async () => "https://example.test/3d-1.jpg",
  }));

  assert.deepEqual(selected.items, [resultMedia[0].items[1]]);
});

test("rotation wraps and preserves configured multi-example send order", async () => {
  const third = {
    imageUrl: "https://example.test/3d-3.jpg",
    caption: "3D example 3",
  };
  const selected = await resolveResultMediaForReply(base({
    resultMedia: [{
      ...resultMedia[0],
      autoSendCount: 2,
      items: [...resultMedia[0].items, third],
    }],
    getMostRecentlySentMediaUrl: async () => third.imageUrl,
  }));

  assert.deepEqual(selected.items, [
    resultMedia[0].items[0],
    resultMedia[0].items[1],
  ]);
});

test("package-only enquiry does not trigger result media without a price question", async () => {
  const selected = await resolveResultMediaForReply(base({
    priceQuery: false,
    packageQuery: true,
  }));

  assert.equal(selected, null);
});

test("any recently accepted configured result image suppresses the whole automatic set", async () => {
  const checked = [];
  const selected = await resolveResultMediaForReply(base({
    wasMediaRecentlySent: async (contactId, imageUrl, hours) => {
      checked.push([contactId, imageUrl, hours]);
      return imageUrl.endsWith("3d-1.jpg");
    },
  }));

  assert.equal(selected, null);
  assert.deepEqual(checked, [
    [42, "https://example.test/3d-1.jpg", 168],
  ]);
});

test("autoSendCount is capped at two and never exceeds configured items", async () => {
  const selected = await resolveResultMediaForReply(base({
    resultMedia: [{
      ...resultMedia[0],
      autoSendCount: 9,
    }],
  }));

  assert.equal(selected.items.length, 2);
});

test("disabled, non-price, unsafe and failed reply states suppress result media", async () => {
  const cases = [
    { priceQuery: false, packageQuery: false },
    { flagged: true },
    { bookingReady: true },
    { keywordReason: "urgent" },
    { needsAttention: true },
    { textSendSucceeded: false },
    { treatment: null },
    {
      resultMedia: [{
        ...resultMedia[0],
        enabled: false,
      }],
    },
    {
      resultMedia: [{
        ...resultMedia[0],
        sendAfterPrice: false,
      }],
    },
  ];

  for (const change of cases) {
    assert.equal(
      await resolveResultMediaForReply(base(change)),
      null,
      JSON.stringify(change)
    );
  }
});

test("ambiguous duplicate service sets fail closed", async () => {
  const selected = await resolveResultMediaForReply(base({
    resultMedia: [
      resultMedia[0],
      {
        ...resultMedia[0],
        items: [{
          imageUrl: "https://example.test/other.jpg",
          caption: "Other",
        }],
      },
    ],
  }));

  assert.equal(selected, null);
});


test("rotation treats the legacy public path and private preview path as the same stored image", () => {
  const items = [
    {
      imageUrl: "/api/config/result-media/image/41",
      caption: "one",
    },
    {
      imageUrl: "/api/config/result-media/image/42",
      caption: "two",
    },
  ];

  assert.deepEqual(
    rotateAfter(items, "https://legacy.example/promo-images/41"),
    [items[1], items[0]]
  );
});


test("legacy result media config normalizes to price-only without changing existing clients", () => {
  assert.equal(normalizeResultMediaTriggerMode({ sendAfterPrice: true }), "price_only");
  assert.equal(normalizeResultMediaTriggerMode({ sendAfterPrice: false }), "off");
  assert.equal(
    normalizeResultMediaTriggerMode({ triggerMode: "service_enquiry", sendAfterPrice: true }),
    "service_enquiry"
  );
});

test("service-enquiry mode sends for a direct customer service enquiry", async () => {
  const selected = await resolveResultMediaForReply(base({
    priceQuery: false,
    serviceQuery: true,
    serviceQuerySource: "customer_message",
    resultMedia: [{
      ...resultMedia[0],
      triggerMode: "service_enquiry",
      sendAfterPrice: undefined,
    }],
  }));

  assert.equal(selected.service, "3D 小颜术");
  assert.equal(selected.triggerMode, "service_enquiry");
  assert.equal(selected.serviceQuerySource, "customer_message");
  assert.deepEqual(selected.items, [resultMedia[0].items[0]]);
});


test("service-enquiry mode accepts ad and conversation intent", async () => {
  for (const source of ["meta_ad", "conversation"]) {
    const selected = await resolveResultMediaForReply(base({
      priceQuery: false,
      serviceQuery: true,
      serviceQuerySource: source,
      resultMedia: [{
        ...resultMedia[0],
        triggerMode: "service_enquiry",
        sendAfterPrice: undefined,
      }],
    }));
    assert.equal(selected?.serviceQuerySource, source);
  }
});

test("service-enquiry mode fails closed for an invalid serviceQuery source", async () => {
  const selected = await resolveResultMediaForReply(base({
    priceQuery: false,
    serviceQuery: true,
    serviceQuerySource: "invalid_source",
    resultMedia: [{
      ...resultMedia[0],
      triggerMode: "service_enquiry",
      sendAfterPrice: undefined,
    }],
  }));
  assert.equal(selected, null);
});

test("service-enquiry mode accepts explicit price or package enquiries", async () => {
  const configured = [{
    ...resultMedia[0],
    triggerMode: "service_enquiry",
    sendAfterPrice: undefined,
  }];

  assert.ok(await resolveResultMediaForReply(base({
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: true,
    resultMedia: configured,
  })));

  assert.ok(await resolveResultMediaForReply(base({
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    packageQuery: true,
    resultMedia: configured,
  })));
});

test("off trigger mode never auto-sends result media", async () => {
  const selected = await resolveResultMediaForReply(base({
    serviceQuery: true,
    serviceQuerySource: "customer_message",
    resultMedia: [{
      ...resultMedia[0],
      triggerMode: "off",
      sendAfterPrice: undefined,
    }],
  }));
  assert.equal(selected, null);
});
