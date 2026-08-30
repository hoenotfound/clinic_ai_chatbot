const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const {
  recoverStaleTerminalProcessingFailures,
} = require("../src/db/leadScoringFailureRecoveryRepo");

test("stale third-attempt processing scores are converted to terminal failures", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return {
      rows: [
        { id: 120, lead_id: 8, through_message_id: 55, attempts: 3 },
      ],
    };
  };

  const recovered = await recoverStaleTerminalProcessingFailures();

  assert.match(captured.sql, /status = 'failed'/);
  assert.match(captured.sql, /WHERE status = 'processing'/);
  assert.match(captured.sql, /attempts >= 3/);
  assert.match(captured.sql, /updated_at <= now\(\) - \(10 \* interval '1 minute'\)/);
  assert.match(captured.sql, /Lead scoring attempt timed out before completion/);
  assert.equal(captured.params, undefined);
  assert.deepEqual(recovered, [
    { id: 120, lead_id: 8, through_message_id: 55, attempts: 3 },
  ]);
});
