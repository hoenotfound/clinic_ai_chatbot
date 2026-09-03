const { pool } = require("./db");

async function listConnectionHealth(queryable = pool) {
  const result = await queryable.query(
    `SELECT check_key, last_check_status, last_check_summary,
            last_checked_at, last_success_at, last_webhook_at
     FROM setup_connection_health
     ORDER BY check_key`
  );
  return result.rows;
}

async function saveCheckResults(results, queryable = pool) {
  for (const result of results) {
    if (!result?.key || !result?.status) continue;
    await queryable.query(
      `INSERT INTO setup_connection_health (
         check_key, last_check_status, last_check_summary,
         last_checked_at, last_success_at, updated_at
       )
       VALUES ($1, $2, $3, $4,
         CASE WHEN $2 = 'ready' THEN $4::timestamptz ELSE NULL END,
         now()
       )
       ON CONFLICT (check_key) DO UPDATE SET
         last_check_status = EXCLUDED.last_check_status,
         last_check_summary = EXCLUDED.last_check_summary,
         last_checked_at = EXCLUDED.last_checked_at,
         last_success_at = CASE
           WHEN EXCLUDED.last_check_status = 'ready' THEN EXCLUDED.last_checked_at
           ELSE setup_connection_health.last_success_at
         END,
         updated_at = now()`,
      [result.key, result.status, result.summary || null, result.checkedAt]
    );
  }
}

async function recordWebhook(checkKey, at = new Date(), queryable = pool) {
  await queryable.query(
    `INSERT INTO setup_connection_health (check_key, last_webhook_at, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (check_key) DO UPDATE SET
       last_webhook_at = GREATEST(
         COALESCE(setup_connection_health.last_webhook_at, '-infinity'::timestamptz),
         EXCLUDED.last_webhook_at
       ),
       updated_at = now()`,
    [checkKey, at]
  );
}

module.exports = { listConnectionHealth, recordWebhook, saveCheckResults };
