const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getActivePromotion,
  getActivePromotions,
  getPricePromotion,
  isPromotionActive,
  localDateString,
} = require("../src/utils/activePromotion");

const promo = {
  name: "HIFU",
  imageUrl: "https://example.com/hifu.jpg",
  caption: "promo",
  linkedService: "HIFU Non-Surgical Facelift",
  sendOnPriceQuery: true,
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

test("price promotion must be active, enabled, imaged, and linked to the requested service", () => {
  const now = new Date("2026-09-10T04:00:00Z");
  assert.equal(
    getPricePromotion([promo], "HIFU Non-Surgical Facelift", now)?.name,
    "HIFU"
  );
  assert.equal(getPricePromotion([promo], "Pico Laser", now), null);
  assert.equal(getPricePromotion([{ ...promo, sendOnPriceQuery: false }], "HIFU Non-Surgical Facelift", now), null);
  assert.equal(getPricePromotion([{ ...promo, imageUrl: "" }], "HIFU Non-Surgical Facelift", now), null);
  assert.equal(getPricePromotion([{ ...promo, caption: "" }], "HIFU Non-Surgical Facelift", now), null);
});

test("price promotion service matching preserves Chinese service names", () => {
  const now = new Date("2026-09-10T04:00:00Z");
  const chinesePromo = {
    ...promo,
    name: "3D First Trial",
    linkedService: "3D 小颜术",
  };
  assert.equal(getPricePromotion([chinesePromo], "3D 小颜术", now)?.name, "3D First Trial");
  assert.equal(getPricePromotion([chinesePromo], "3D 骨盆调理", now), null);
});
