const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNextMetaEnrichmentDueAt,
} = require("../src/db/metaAdsEnrichmentScheduleRepo");

test("Meta enrichment schedule looks only at pending rows with an ad id", async () => {
  let capturedSql = null;
  const dueAt = new Date("2026-09-06T13:00:00.000Z");

  const result = await getNextMetaEnrichmentDueAt(async (sql) => {
    capturedSql = sql;
    return { rows: [{ due_at: dueAt }] };
  });

  assert.equal(result, dueAt);
  assert.match(capturedSql, /enrichment_status = 'pending'/);
  assert.match(capturedSql, /meta_ad_id IS NOT NULL/);
  assert.match(capturedSql, /MIN\(COALESCE\(enrichment_next_attempt_at, now\(\)\)\)/);
});
