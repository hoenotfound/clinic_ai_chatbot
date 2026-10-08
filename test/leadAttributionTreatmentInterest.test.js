const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const clinicConfig = require("../src/config/clinicConfig");
const leadAttributionRepo = require("../src/db/leadAttributionRepo");

function installServiceConfig() {
  const previousServices = clinicConfig.services;
  const previousAliases = clinicConfig.serviceAliases;
  clinicConfig.services = [
    { name: "3D 小颜术" },
    { name: "骨盆调理" },
  ];
  clinicConfig.serviceAliases = [
    { alias: "小颜术", officialService: "3D 小颜术" },
    { alias: "骨盆", officialService: "骨盆调理" },
  ];
  return () => {
    clinicConfig.services = previousServices;
    clinicConfig.serviceAliases = previousAliases;
  };
}

test("first-touch Meta attribution seeds a blank treatment interest from ad name", async (t) => {
  const originalConnect = pool.connect;
  const restoreConfig = installServiceConfig();
  t.after(() => {
    pool.connect = originalConnect;
    restoreConfig();
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/INSERT INTO lead_attributions/.test(sql)) {
        return { rows: [{ id: 1, lead_id: 9, source: "meta_ads" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  await leadAttributionRepo.createFirstTouch({
    leadId: 9,
    firstMessageId: 22,
    attribution: {
      source: "meta_ads",
      channel: "whatsapp",
      adName: "骨盆 1",
    },
  });

  const leadUpdate = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.ok(leadUpdate);
  assert.match(leadUpdate.sql, /treatment_interest = CASE/);
  assert.equal(leadUpdate.params[3], "骨盆调理");
});

test("Meta enrichment seeds treatment interest when the ad name arrives later", async (t) => {
  const originalConnect = pool.connect;
  const restoreConfig = installServiceConfig();
  t.after(() => {
    pool.connect = originalConnect;
    restoreConfig();
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/UPDATE lead_attributions/.test(sql)) {
        return {
          rows: [{
            id: 1,
            lead_id: 9,
            meta_ad_id: "300",
            enrichment_status: "enriched",
          }],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  await leadAttributionRepo.markMetaEnrichmentSuccess(1, {
    adId: "300",
    adName: "小颜术 5",
    campaignName: "Face Campaign",
  });

  const leadUpdate = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.ok(leadUpdate);
  assert.match(leadUpdate.sql, /NULLIF\(BTRIM\(treatment_interest\), ''\) IS NULL/);
  assert.deepEqual(leadUpdate.params, [9, "Face Campaign", "3D 小颜术"]);
});
