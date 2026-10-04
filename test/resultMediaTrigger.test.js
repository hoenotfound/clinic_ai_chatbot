const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
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
    ...overrides,
  };
}

test("price enquiry resolves one approved service-level result example", async () => {
  const calls = [];
  const selected = await resolveResultMediaForReply(base({
    wasMediaRecentlySent: async (...args) => {
      calls.push(args);
      return false;
    },
  }));

  assert.equal(selected.service, "3D 小颜术");
  assert.deepEqual(selected.items, [resultMedia[0].items[0]]);
  assert.deepEqual(calls, [
    [42, "https://example.test/3d-1.jpg", DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS],
    [42, "https://example.test/3d-2.jpg", DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS],
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
