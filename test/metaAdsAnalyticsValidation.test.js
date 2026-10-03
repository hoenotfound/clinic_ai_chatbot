const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AnalyticsValidationError,
  normalizeMetaAdsAnalyticsQuery,
} = require("../src/utils/analyticsValidation");

test("normalizes Meta Ads analytics hierarchy filters", () => {
  const filters = normalizeMetaAdsAnalyticsQuery({
    from: "2026-10-01",
    to: "2026-10-04",
    level: "adset",
    accountId: "123",
    campaignId: "456",
    adsetId: "789",
    adId: "999",
  }, new Date("2026-10-04T00:00:00+08:00"));

  assert.equal(filters.level, "adset");
  assert.equal(filters.accountId, "123");
  assert.equal(filters.campaignId, "456");
  assert.equal(filters.adsetId, "789");
  assert.equal(filters.adId, "999");
  assert.equal(filters.dayCount, 4);
});

test("rejects invalid Meta Ads analytics level and IDs", () => {
  assert.throws(
    () => normalizeMetaAdsAnalyticsQuery({ level: "account" }),
    AnalyticsValidationError
  );
  assert.throws(
    () => normalizeMetaAdsAnalyticsQuery({ accountId: "act_123" }),
    /numeric Meta ID/
  );
  assert.throws(
    () => normalizeMetaAdsAnalyticsQuery({ campaignId: ["123", "456"] }),
    /single value/
  );
});
