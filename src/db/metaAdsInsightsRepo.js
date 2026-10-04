const { pool } = require("./db");

const INSERT_COLUMNS = [
  "account_id",
  "account_name",
  "account_currency",
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
const MAX_LEASE_MS = 2 * 60 * 60 * 1000;

function rowValues(row) {
  return [
    row.accountId,
    row.accountName || null,
    row.accountCurrency,
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

function normalizeLeaseMs(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("Meta Ads sync lease duration must be a positive integer.");
  }
  return Math.min(parsed, MAX_LEASE_MS);
}

function requireLeaseToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 200) {
    throw new TypeError("Meta Ads sync lease token is missing or invalid.");
  }
  return token;
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
       account_name = EXCLUDED.account_name,
       account_currency = EXCLUDED.account_currency,
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

function validateRows(accountId, rows) {
  const normalizedAccountId = String(accountId);
  for (const row of rows) {
    if (String(row?.accountId || "") !== normalizedAccountId) {
      throw new Error("Meta Ads insight rows must belong to the account being replaced.");
    }
    if (!String(row?.accountCurrency || "").trim()) {
      throw new Error("Meta Ads insight rows must include account currency.");
    }
  }
}

async function replaceInsightsRange(accountId, since, until, rows = [], database = pool) {
  validateRows(accountId, rows);

  const client = await database.connect();
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

async function getLatestHierarchyForAdIds(adIds, database = pool) {
  const ids = [...new Set(
    (adIds || [])
      .map((value) => String(value || "").trim())
      .filter((value) => /^\d+$/.test(value))
  )];
  if (!ids.length) return new Map();

  const result = await database.query(
    `SELECT DISTINCT ON (ad_id)
       ad_id, account_id, account_name, account_currency,
       campaign_id, campaign_name, adset_id, adset_name, ad_name
     FROM meta_ad_insights_daily
     WHERE ad_id = ANY($1::text[])
     ORDER BY ad_id, insight_date DESC, updated_at DESC`,
    [ids]
  );
  return new Map(result.rows.map((row) => [String(row.ad_id), row]));
}

async function tryAcquireSyncLease(accountId, leaseToken, leaseMs, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const durationMs = normalizeLeaseMs(leaseMs);
  const result = await database.query(
    `INSERT INTO meta_ads_insights_sync_state (
       account_id, lease_token, lease_until, updated_at
     ) VALUES (
       $1, $2, now() + ($3::bigint * interval '1 millisecond'), now()
     )
     ON CONFLICT (account_id) DO UPDATE SET
       lease_token = EXCLUDED.lease_token,
       lease_until = EXCLUDED.lease_until,
       updated_at = now()
     WHERE meta_ads_insights_sync_state.lease_until IS NULL
        OR meta_ads_insights_sync_state.lease_until <= now()
        OR meta_ads_insights_sync_state.lease_token = EXCLUDED.lease_token
     RETURNING account_id`,
    [accountId, token, durationMs]
  );
  return Boolean(result.rows[0]);
}

async function renewSyncLease(accountId, leaseToken, leaseMs, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const durationMs = normalizeLeaseMs(leaseMs);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET lease_until = now() + ($3::bigint * interval '1 millisecond'),
         updated_at = now()
     WHERE account_id = $1
       AND lease_token = $2
       AND lease_until > now()
     RETURNING account_id`,
    [accountId, token, durationMs]
  );
  return Boolean(result.rows[0]);
}

async function releaseSyncLease(accountId, leaseToken, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET lease_token = NULL, lease_until = NULL, updated_at = now()
     WHERE account_id = $1 AND lease_token = $2
     RETURNING account_id`,
    [accountId, token]
  );
  return Boolean(result.rows[0]);
}

async function getSyncState(accountId, database = pool) {
  const result = await database.query(
    `SELECT account_id, last_attempt_at, last_success_at, last_error,
            last_backfill_completed_at, backfill_next_date,
            coverage_start_date, coverage_end_date,
            last_range_start, last_range_end,
            lease_token, lease_until, updated_at
     FROM meta_ads_insights_sync_state
     WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0] || null;
}

async function markSyncStarted(accountId, since, until, leaseToken, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET last_attempt_at = now(),
         last_range_start = $2::date,
         last_range_end = $3::date,
         last_error = NULL,
         updated_at = now()
     WHERE account_id = $1 AND lease_token = $4
     RETURNING account_id`,
    [accountId, since, until, token]
  );
  if (!result.rows[0]) {
    const err = new Error("Meta Ads Insights sync lease was lost before the sync started.");
    err.code = "SYNC_LEASE_LOST";
    throw err;
  }
}

async function resetBackfillCoverage(accountId, coverageStart, leaseToken, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET coverage_start_date = $2::date,
         coverage_end_date = NULL,
         backfill_next_date = $2::date,
         updated_at = now()
     WHERE account_id = $1 AND lease_token = $3
     RETURNING account_id`,
    [accountId, coverageStart, token]
  );
  if (!result.rows[0]) {
    const err = new Error("Meta Ads Insights sync lease was lost before backfill coverage reset.");
    err.code = "SYNC_LEASE_LOST";
    throw err;
  }
}

async function markBackfillProgress(accountId, since, until, nextDate, leaseToken, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET last_success_at = now(),
         last_error = NULL,
         backfill_next_date = $4::date,
         coverage_end_date = $3::date,
         last_range_start = $2::date,
         last_range_end = $3::date,
         updated_at = now()
     WHERE account_id = $1 AND lease_token = $5
     RETURNING account_id`,
    [accountId, since, until, nextDate, token]
  );
  if (!result.rows[0]) {
    const err = new Error("Meta Ads Insights sync lease was lost while saving backfill progress.");
    err.code = "SYNC_LEASE_LOST";
    throw err;
  }
}

async function markSyncSuccess(
  accountId,
  since,
  until,
  leaseToken,
  { backfillCompleted = false } = {},
  database = pool
) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET last_success_at = now(),
         last_error = NULL,
         last_backfill_completed_at = CASE
           WHEN $5::boolean THEN COALESCE(last_backfill_completed_at, now())
           ELSE last_backfill_completed_at
         END,
         backfill_next_date = CASE WHEN $5::boolean THEN NULL ELSE backfill_next_date END,
         coverage_start_date = CASE
           WHEN $5::boolean THEN $2::date
           ELSE coverage_start_date
         END,
         coverage_end_date = CASE
           WHEN $5::boolean THEN $3::date
           WHEN coverage_end_date IS NOT NULL
             AND $2::date <= coverage_end_date + 1
             THEN GREATEST(coverage_end_date, $3::date)
           ELSE coverage_end_date
         END,
         last_range_start = $2::date,
         last_range_end = $3::date,
         lease_token = NULL,
         lease_until = NULL,
         updated_at = now()
     WHERE account_id = $1 AND lease_token = $4
     RETURNING account_id`,
    [accountId, since, until, token, Boolean(backfillCompleted)]
  );
  if (!result.rows[0]) {
    const err = new Error("Meta Ads Insights sync lease was lost before success could be recorded.");
    err.code = "SYNC_LEASE_LOST";
    throw err;
  }
}

async function markSyncFailure(accountId, since, until, errorText, leaseToken, database = pool) {
  const token = requireLeaseToken(leaseToken);
  const result = await database.query(
    `UPDATE meta_ads_insights_sync_state
     SET last_attempt_at = now(),
         last_error = $4,
         last_range_start = $2::date,
         last_range_end = $3::date,
         lease_token = NULL,
         lease_until = NULL,
         updated_at = now()
     WHERE account_id = $1 AND lease_token = $5
     RETURNING account_id`,
    [
      accountId,
      since,
      until,
      String(errorText || "Meta Ads Insights sync failed.").slice(0, 1000),
      token,
    ]
  );
  return Boolean(result.rows[0]);
}

module.exports = {
  MAX_LEASE_MS,
  UPSERT_CHUNK_SIZE,
  getLatestHierarchyForAdIds,
  getSyncState,
  markBackfillProgress,
  markSyncFailure,
  markSyncStarted,
  markSyncSuccess,
  releaseSyncLease,
  renewSyncLease,
  resetBackfillCoverage,
  replaceInsightsRange,
  tryAcquireSyncLease,
  validateRows,
};
