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
  assert.equal(await resolveResultMediaForReply({ ...base, treatment: null }), null);
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
