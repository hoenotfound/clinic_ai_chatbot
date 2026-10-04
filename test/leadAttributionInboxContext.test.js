const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const leadAttributionRepo = require("../src/db/leadAttributionRepo");

test("loads the current Inbox lead with Meta hierarchy fallback", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM leads l/);
    assert.match(sql, /LEFT JOIN lead_attributions la/);
    assert.match(sql, /FROM meta_ad_insights_daily mi/);
    assert.match(sql, /ORDER BY l\.is_closed ASC/);
    assert.deepEqual(params, [42]);
    return {
      rows: [{
        lead_id: 9,
        contact_id: 42,
        source: "meta_ads",
        meta_ad_id: "300",
        meta_account_id: "123",
        campaign_id: "100",
        campaign_name: "Pelvis Campaign",
        adset_id: "200",
        adset_name: "Women KL",
        ad_name: "Pelvis Creative",
        temperature: "hot",
        stage_name: "Appointment",
      }],
    };
  };

  const context = await leadAttributionRepo.getForContactCurrentLead(42);
  assert.equal(context.lead_id, 9);
  assert.equal(context.source, "meta_ads");
  assert.equal(context.ad_name, "Pelvis Creative");
  assert.equal(context.campaign_name, "Pelvis Campaign");
});
