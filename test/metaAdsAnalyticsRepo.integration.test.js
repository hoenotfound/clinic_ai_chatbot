const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const { getMetaAdsAnalytics } = require("../src/db/metaAdsAnalyticsRepo");
const { getAnalyticsPipelineProfile } = require("../src/db/analyticsPipelineProfile");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test(
  "Meta Ads analytics keeps zero-lead spend, joins CRM by Ad ID, and exposes attribution coverage",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await client.connect();

    const schemaName = `meta_ads_analytics_it_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`
      ).catch(() => {});
      await client.end().catch(() => {});
    });

    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

    await client.query(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY,
        channel TEXT NOT NULL
      );

      CREATE TABLE pipeline_stages (
        id INTEGER PRIMARY KEY,
        stage_type TEXT NOT NULL,
        system_key TEXT
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE leads (
        id INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL,
        stage_id INTEGER NOT NULL,
        temperature TEXT,
        estimated_value NUMERIC,
        appointment_status TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        started_message_id INTEGER
      );

      CREATE TABLE lead_stage_history (
        lead_id INTEGER NOT NULL,
        to_stage_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE lead_attributions (
        lead_id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        meta_ad_id TEXT,
        meta_account_id TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        adset_id TEXT,
        adset_name TEXT,
        ad_name TEXT
      );

      INSERT INTO contacts (id, channel) VALUES
        (1, 'whatsapp'),
        (2, 'whatsapp'),
        (3, 'instagram');

      INSERT INTO pipeline_stages (id, stage_type, system_key) VALUES
        (1, 'open', 'new'),
        (2, 'open', 'appointment_set'),
        (3, 'open', 'visited'),
        (4, 'won', 'won');

      INSERT INTO messages (id, created_at) VALUES
        (101, '2026-10-02T02:00:00Z'),
        (102, '2026-10-03T02:00:00Z'),
        (103, '2026-10-03T03:00:00Z');

      INSERT INTO leads (
        id, contact_id, stage_id, temperature, estimated_value,
        appointment_status, created_at, started_message_id
      ) VALUES
        (1, 1, 4, 'hot', 500, 'visited', '2026-10-02T02:00:00Z', 101),
        (2, 2, 1, 'warm', 800, NULL, '2026-10-03T02:00:00Z', 102),
        (3, 3, 1, 'warm', 300, NULL, '2026-10-03T03:00:00Z', 103);

      INSERT INTO lead_stage_history (lead_id, to_stage_id, created_at) VALUES
        (1, 2, '2026-10-02T04:00:00Z'),
        (1, 3, '2026-10-02T06:00:00Z'),
        (1, 4, '2026-10-04T06:00:00Z');

      INSERT INTO lead_attributions (
        lead_id, source, meta_ad_id, meta_account_id,
        campaign_id, campaign_name, adset_id, adset_name, ad_name
      ) VALUES
        (1, 'meta_ads', '300', '123', '100', 'Campaign A', '200', 'Set A', 'Ad A'),
        (2, 'meta_ads', '301', '123', '100', 'Old Campaign Name', '201', 'Set B', 'Ad B'),
        (3, 'meta_ads', '999', NULL, NULL, NULL, NULL, NULL, NULL);
    `);

    await client.query(
      fs.readFileSync(
        path.join(__dirname, "..", "src/db/migrations/027_meta_ads_insights.sql"),
        "utf8"
      )
    );

    await client.query(`
      INSERT INTO meta_ad_insights_daily (
        account_id, account_name, account_currency, insight_date,
        campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        spend, impressions, reach, clicks, ctr, cpc, cpm, frequency
      ) VALUES
        ('123', 'Clinic Ads', 'MYR', '2026-10-02',
         '100', 'Campaign A Renamed', '200', 'Set A', '300', 'Ad A',
         100, 1000, 800, 50, 5, 2, 100, 1.25),
        ('123', 'Clinic Ads', 'MYR', '2026-10-03',
         '100', 'Campaign A Renamed', '201', 'Set B', '301', 'Ad B',
         50, 500, 400, 20, 4, 2.5, 100, 1.25),
        ('123', 'Clinic Ads', 'MYR', '2026-10-03',
         '100', 'Campaign A Renamed', '202', 'Set C', '302', 'Ad C',
         25, 250, 200, 5, 2, 5, 100, 1.25)
    `);

    const database = {
      query(text, params) {
        return client.query(text, params);
      },
    };
    const baseFilters = {
      from: "2026-10-01",
      to: "2026-10-04",
      dayCount: 4,
      timeZone: "Asia/Kuala_Lumpur",
      accountId: null,
      campaignId: null,
      adsetId: null,
      adId: null,
    };
    const analyticsProfile = getAnalyticsPipelineProfile({
      businessType: "aesthetic_clinic",
    });

    const campaign = await getMetaAdsAnalytics(
      { ...baseFilters, level: "campaign" },
      { database, analyticsProfile }
    );

    assert.equal(campaign.money.currency, "MYR");
    assert.equal(campaign.money.mixedCurrency, false);
    assert.equal(campaign.summary.spend, 175);
    assert.equal(campaign.summary.crmLeads, 3);
    assert.equal(campaign.summary.hotLeads, 1);
    assert.equal(campaign.summary.appointments, 1);
    assert.equal(campaign.summary.visits, 1);
    assert.equal(campaign.summary.won, 1);
    assert.equal(campaign.summary.estimatedWonValue, 500);
    assert.equal(campaign.summary.estimatedRoas, 2.86);
    assert.deepEqual(campaign.attributionCoverage, {
      metaAttributedLeads: 3,
      matchedToSyncedAds: 2,
      unmatchedToSyncedAds: 1,
      matchedRate: 66.7,
    });
    assert.equal(campaign.rows.length, 1);
    assert.equal(campaign.rows[0].id, "100");
    assert.equal(campaign.rows[0].name, "Campaign A Renamed");
    assert.equal(campaign.rows[0].spend, 175);
    assert.equal(campaign.rows[0].crmLeads, 2);
    assert.equal(campaign.rows[0].costPerLead, 87.5);

    const ads = await getMetaAdsAnalytics(
      { ...baseFilters, level: "ad" },
      { database, analyticsProfile }
    );

    const byId = new Map(ads.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("302").spend, 25);
    assert.equal(byId.get("302").crmLeads, 0);
    assert.equal(byId.get("302").costPerLead, null);
    assert.equal(byId.get("999").spend, 0);
    assert.equal(byId.get("999").crmLeads, 1);
    assert.equal(byId.get("999").currency, null);
  }
);
