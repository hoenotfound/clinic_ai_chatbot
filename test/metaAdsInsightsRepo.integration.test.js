const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const insightsRepo = require("../src/db/metaAdsInsightsRepo");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

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
    const database = new Pool({
      connectionString: TEST_DATABASE_URL,
      ssl: false,
      max: 4,
    });
    const accountId = `88${Date.now()}`;

    t.after(async () => {
      await database.query(
        "DELETE FROM meta_ad_insights_daily WHERE account_id = $1",
        [accountId]
      ).catch(() => {});
      await database.query(
        "DELETE FROM meta_ads_insights_sync_state WHERE account_id = $1",
        [accountId]
      ).catch(() => {});
      await database.end().catch(() => {});
    });

    await database.query(
      fs.readFileSync(
        path.join(__dirname, "..", "src/db/migrations/027_meta_ads_insights.sql"),
        "utf8"
      )
    );

    await insightsRepo.replaceInsightsRange(
      accountId,
      "2026-10-01",
      "2026-10-04",
      [
        insight(accountId, "2026-10-01", "301", 10),
        insight(accountId, "2026-10-02", "302", 20),
        insight(accountId, "2026-10-04", "304", 40),
      ],
      database
    );

    await insightsRepo.replaceInsightsRange(
      accountId,
      "2026-10-01",
      "2026-10-03",
      [
        insight(accountId, "2026-10-01", "301", 11),
        insight(accountId, "2026-10-03", "303", 30),
      ],
      database
    );

    const rows = await database.query(
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
      await insightsRepo.tryAcquireSyncLease(
        accountId,
        "owner-a",
        300000,
        database
      ),
      true
    );
    assert.equal(
      await insightsRepo.tryAcquireSyncLease(
        accountId,
        "owner-b",
        300000,
        database
      ),
      false
    );
    assert.equal(
      await insightsRepo.releaseSyncLease(accountId, "owner-a", database),
      true
    );
    assert.equal(
      await insightsRepo.tryAcquireSyncLease(
        accountId,
        "owner-b",
        300000,
        database
      ),
      true
    );
  }
);
