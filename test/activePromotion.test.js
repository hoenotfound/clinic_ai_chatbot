const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getActivePromotion,
  getActivePromotions,
  isPromotionActive,
  localDateString,
} = require("../src/utils/activePromotion");

const promo = {
  name: "HIFU",
  imageUrl: "https://example.com/hifu.jpg",
  caption: "promo",
  validFrom: "2026-09-01",
  validUntil: "2026-09-30",
};

test("date-only validUntil remains active through the end date in Malaysia", () => {
  const lateOnSep30Malaysia = new Date("2026-09-30T15:59:59Z"); // 23:59:59 +08
  assert.equal(isPromotionActive(promo, lateOnSep30Malaysia), true);
  assert.equal(getActivePromotion([promo], lateOnSep30Malaysia)?.name, "HIFU");
});

test("date-only promotion expires on the next Malaysia calendar day", () => {
  const oct1Malaysia = new Date("2026-09-30T16:00:00Z"); // 00:00 +08 Oct 1
  assert.equal(isPromotionActive(promo, oct1Malaysia), false);
});

test("active promotions used by the AI can be text-only while promo image sending requires imageUrl", () => {
  const textOnly = { ...promo, imageUrl: "" };
  const now = new Date("2026-09-10T04:00:00Z");
  assert.equal(getActivePromotions([textOnly], now).length, 1);
  assert.equal(getActivePromotion([textOnly], now), null);
});

test("an invalid optional clinic timezone falls back to Malaysia instead of breaking replies", () => {
  const now = new Date("2026-09-30T15:59:59Z");
  assert.equal(localDateString(now, "Not/A_Timezone"), "2026-09-30");
  assert.equal(
    isPromotionActive(promo, now, { timeZone: "Not/A_Timezone" }),
    true
  );
});