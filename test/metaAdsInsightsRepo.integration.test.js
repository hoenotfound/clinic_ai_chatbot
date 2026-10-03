const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

const { initSchema, pool } = require("../src/db/db");
const insightsRepo = require("../src/db/metaAdsInsightsRepo");

function insight(accountId, date, adId, spend) {
  return {
    accountId,
    accountName: "Integration Test Account",
    accountCurrency: "MYR",
    date,
    campaignId: "100",
    campaignName: "Campaign",
    adsetId: "200",
    adsetName: "Ad Set",
    adId,
    adName: `Ad ${adId}`,
    spend,
    impressions: 100,
    reach: 80,
    clicks: 10,
    ctr: 10,
    cpc: spend / 10,
    cpm: spend * 10,
    frequency: 1.25,
    actions: [],
  };
}

test(
  "Meta Ads repository atomically replaces only the requested date range and leases one owner",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    await initSchema({ quiet: true });
    const accountId = `88${Date.now()}`;

    t.after(async () => {
      await pool.query(
        "DELETE FROM meta_ad_insights_daily WHERE account_id = $1",
        [accountId]
      ).catch(() => {});
      await pool.query(
        "DELETE FROM meta_ads_insights_sync_state WHERE account_id = $1",
        [accountId]
      ).catch(() => {});
      await pool.end().catch(() => {});
    });

    await insightsRepo.replaceInsightsRange(
      accountId,
      "2026-10-01",
      "2026-10-04",
      [
        insight(accountId, "2026-10-01", "301", 10),
        insight(accountId, "2026-10-02", "302", 20),
        insight(accountId, "2026-10-04", "304", 40),
      ]
    );

    await insightsRepo.replaceInsightsRange(
      accountId,
      "2026-10-01",
      "2026-10-03",
      [
        insight(accountId, "2026-10-01", "301", 11),
        insight(accountId, "2026-10-03", "303", 30),
      ]
    );

    const rows = await pool.query(
      `SELECT insight_date::text AS insight_date, ad_id, spend::text AS spend,
              account_currency
       FROM meta_ad_insights_daily
       WHERE account_id = $1
       ORDER BY insight_date, ad_id`,
      [accountId]
    );

    assert.deepEqual(rows.rows, [
      {
        insight_date: "2026-10-01",
        ad_id: "301",
        spend: "11.0000",
        account_currency: "MYR",
      },
      {
        insight_date: "2026-10-03",
        ad_id: "303",
        spend: "30.0000",
        account_currency: "MYR",
      },
      {
        insight_date: "2026-10-04",
        ad_id: "304",
        spend: "40.0000",
        account_currency: "MYR",
      },
    ]);

    assert.equal(
      await insightsRepo.tryAcquireSyncLease(accountId, "owner-a", 300000),
      true
    );
    assert.equal(
      await insightsRepo.tryAcquireSyncLease(accountId, "owner-b", 300000),
      false
    );
    assert.equal(
      await insightsRepo.releaseSyncLease(accountId, "owner-a"),
      true
    );
    assert.equal(
      await insightsRepo.tryAcquireSyncLease(accountId, "owner-b", 300000),
      true
    );
  }
);
