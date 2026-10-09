const test = require("node:test");
const assert = require("node:assert/strict");
const { getAiCostAnalytics } = require("../src/db/aiCostAnalyticsRepo");

test("daily AI cost reporting uses MYT, enforces contact scope in every query and keeps unknown separate", async () => {
  const statements = [];
  const mock = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (statements.length === 1) return { rows: [{
        day: "2026-10-09", calls: 5, priced_calls: 3,
        unpriced_calls: 2, unattributed_calls: 0, new_leads: 2, usd: "0.0084",
      }] };
      if (statements.length === 2) return { rows: [{
        provider: "gemini", purpose: "customer_reply", calls: 5,
        unpriced_calls: 2, usd: "0.0084", prompt_tokens: "8000", cached_tokens: "0",
      }] };
      if (statements.length === 3) return { rows: [{
        contact_id: 7, channel: "whatsapp", calls: 5, usd: "0.0084", unpriced_calls: 2,
      }] };
      if (statements.length === 4) return { rows: [{
        model: "gemini-3.8-flash", purpose: "customer_reply",
        successful_calls: 5, below_4096: 0, at_least_4096: 5,
        cache_hits: 0, cache_metadata_missing: 5, distinct_prefixes: 1, mean_prompt_tokens: 14000,
      }] };
      return { rows: [{ lead_id: 77, contact_id: 7, calls: 4, usd: "0.0084", unpriced_calls: 1 }] };
    },
  };
  const result = await getAiCostAnalytics({
    days: 7, accessibleContactIds: [7, 9], database: mock, fxRate: "4.10",
  });
  assert.equal(result.currency, "MYR");
  assert.equal(result.daily[0].newLeads, 2);
  assert.equal(result.daily[0].unpricedCalls, 2);
  assert.equal(result.byContact[0].contactId, 7);
  assert.equal(result.cacheDiagnostics[0].cacheMetadataMissing, 5);
  assert.equal(result.byLead[0].leadId, 77);
  assert.equal(result.daily[0].estimatedMyr, 0.0084 * 4.10);
  assert.equal(statements.length, 5);
  for (const { sql, params } of statements) {
    assert.match(sql, /Asia\/Kuala_Lumpur/);
    assert.match(sql, /ANY\(\$2::int\[\]\)/);
    assert.deepEqual(params, [7, [7, 9]]);
  }
});

test("restricted staff with no contacts cannot receive unscoped cost data", async () => {
  const paramsSeen = [];
  const mock = { async query(sql, params) { paramsSeen.push(params); return { rows: [] }; } };
  await getAiCostAnalytics({ accessibleContactIds: [], database: mock, days: 200 });
  assert.equal(paramsSeen.length, 5);
  assert.deepEqual(paramsSeen[0], [30, []]);
});
