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
    assert.match(sql, /FROM whatsapp_free_entry_referrals r/);
    assert.ok(sql.includes("r.contact_id = l.contact_id"));
    assert.ok(sql.includes("JOIN messages latest_ad_message"));
    assert.ok(sql.includes("latest_ad_message.contact_id = r.contact_id"));
    assert.ok(sql.includes("latest_ad_message.role = 'user'"));
    assert.ok(sql.includes("COALESCE(latest_ad_message.source_created_at,"));
    assert.ok(sql.includes("latest_ad_message.created_at) DESC"));
    assert.equal(sql.includes("ORDER BY r.recorded_at DESC"), false,
      "a delayed webhook must not make an older Meta click look latest");
    assert.ok(sql.includes("mi.ad_id = latest_ref.meta_ad_id"));
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
        latest_meta_ad_id: "301",
        latest_ad_name: "Pelvis Relaunch",
        latest_campaign_name: "New Promo",
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
  assert.equal(context.latest_meta_ad_id, "301");
  assert.equal(context.latest_ad_name, "Pelvis Relaunch");
  assert.equal(context.latest_campaign_name, "New Promo");
  assert.notEqual(context.meta_ad_id, context.latest_meta_ad_id,
    "the Inbox can show a newer ad without rewriting the original lead attribution");
});
