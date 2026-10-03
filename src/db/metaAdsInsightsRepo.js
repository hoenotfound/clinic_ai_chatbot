const { pool } = require("./db");

const INSERT_COLUMNS = [
  "account_id",
  "insight_date",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "actions",
];

const UPSERT_CHUNK_SIZE = 250;

function rowValues(row) {
  return [
    row.accountId,
    row.date,
    row.campaignId || null,
    row.campaignName || null,
    row.adsetId || null,
    row.adsetName || null,
    row.adId,
    row.adName || null,
    row.spend ?? 0,
    row.impressions ?? 0,
    row.reach ?? 0,
    row.clicks ?? 0,
    row.ctr ?? null,
    row.cpc ?? null,
    row.cpm ?? null,
    row.frequency ?? null,
    JSON.stringify(Array.isArray(row.actions) ? row.actions : []),
  ];
}

async function insertChunk(client, rows) {
  if (!rows.length) return;

  const params = [];
  const tuples = rows.map((row) => {
    const values = rowValues(row);
    const offset = params.length;
    params.push(...values);
    const placeholders = values.map((_, index) => {
      const position = offset + index + 1;
      return index === INSERT_COLUMNS.length - 1
        ? `$${position}::jsonb`
        : `$${position}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  await client.query(
    `INSERT INTO meta_ad_insights_daily (
       ${INSERT_COLUMNS.join(", ")}
     ) VALUES ${tuples.join(", ")}
     ON CONFLICT (account_id, insight_date, ad_id) DO UPDATE SET
       campaign_id = EXCLUDED.campaign_id,
       campaign_name = EXCLUDED.campaign_name,
       adset_id = EXCLUDED.adset_id,
       adset_name = EXCLUDED.adset_name,
       ad_name = EXCLUDED.ad_name,
       spend = EXCLUDED.spend,
       impressions = EXCLUDED.impressions,
       reach = EXCLUDED.reach,
       clicks = EXCLUDED.clicks,
       ctr = EXCLUDED.ctr,
       cpc = EXCLUDED.cpc,
       cpm = EXCLUDED.cpm,
       frequency = EXCLUDED.frequency,
       actions = EXCLUDED.actions,
       synced_at = now(),
       updated_at = now()`,
    params
  );
}

async function replaceInsightsRange(accountId, since, until, rows = []) {
  if (rows.some((row) => String(row?.accountId || "") !== String(accountId))) {
    throw new Error("Meta Ads insight rows must belong to the account being replaced.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM meta_ad_insights_daily
       WHERE account_id = $1
         AND insight_date >= $2::date
         AND insight_date <= $3::date`,
      [accountId, since, until]
    );

    for (let index = 0; index < rows.length; index += UPSERT_CHUNK_SIZE) {
      await insertChunk(client, rows.slice(index, index + UPSERT_CHUNK_SIZE));
    }

    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getSyncState(accountId) {
  const result = await pool.query(
    `SELECT account_id, last_attempt_at, last_success_at, last_error,
            last_backfill_completed_at, last_range_start, last_range_end, updated_at
     FROM meta_ads_insights_sync_state
     WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0] || null;
}

async function markSyncStarted(accountId, since, until) {
  await pool.query(
    `INSERT INTO meta_ads_insights_sync_state (
       account_id, last_attempt_at, last_range_start, last_range_end, last_error, updated_at
     ) VALUES ($1, now(), $2::date, $3::date, NULL, now())
     ON CONFLICT (account_id) DO UPDATE SET
       last_attempt_at = now(),
       last_range_start = EXCLUDED.last_range_start,
       last_range_end = EXCLUDED.last_range_end,
       last_error = NULL,
       updated_at = now()`,
    [accountId, since, until]
  );
}

async function markSyncSuccess(accountId, since, until, { backfillCompleted = false } = {}) {
  await pool.query(
    `INSERT INTO meta_ads_insights_sync_state (
       account_id, last_attempt_at, last_success_at, last_error,
       last_backfill_completed_at, last_range_start, last_range_end, updated_at
     ) VALUES (
       $1, now(), now(), NULL,
       CASE WHEN $4::boolean THEN now() ELSE NULL END,
       $2::date, $3::date, now()
     )
     ON CONFLICT (account_id) DO UPDATE SET
       last_success_at = now(),
       last_error = NULL,
       last_backfill_completed_at = CASE
         WHEN $4::boolean THEN COALESCE(
           meta_ads_insights_sync_state.last_backfill_completed_at,
           now()
         )
         ELSE meta_ads_insights_sync_state.last_backfill_completed_at
       END,
       last_range_start = EXCLUDED.last_range_start,
       last_range_end = EXCLUDED.last_range_end,
       updated_at = now()`,
    [accountId, since, until, Boolean(backfillCompleted)]
  );
}

async function markSyncFailure(accountId, since, until, errorText) {
  await pool.query(
    `INSERT INTO meta_ads_insights_sync_state (
       account_id, last_attempt_at, last_error, last_range_start, last_range_end, updated_at
     ) VALUES ($1, now(), $4, $2::date, $3::date, now())
     ON CONFLICT (account_id) DO UPDATE SET
       last_attempt_at = now(),
       last_error = EXCLUDED.last_error,
       last_range_start = EXCLUDED.last_range_start,
       last_range_end = EXCLUDED.last_range_end,
       updated_at = now()`,
    [accountId, since, until, String(errorText || "Meta Ads Insights sync failed.").slice(0, 1000)]
  );
}

module.exports = {
  UPSERT_CHUNK_SIZE,
  getSyncState,
  markSyncFailure,
  markSyncStarted,
  markSyncSuccess,
  replaceInsightsRange,
};
