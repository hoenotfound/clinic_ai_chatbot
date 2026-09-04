const { pool } = require("./db");

const VALID_SCOPES = new Set(["ip", "username", "pair"]);

function normalizeKeys(keys) {
  const seen = new Set();
  const normalized = [];

  for (const key of keys || []) {
    const scope = String(key?.scope || "").trim();
    const keyHash = String(key?.keyHash || "").trim();
    if (!VALID_SCOPES.has(scope) || !keyHash) continue;
    const dedupeKey = `${scope}:${keyHash}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ scope, keyHash });
  }

  return normalized;
}

function tupleWhere(keys, firstParam = 1) {
  const params = [];
  const tuples = keys.map((key, index) => {
    const base = firstParam + index * 2;
    params.push(key.scope, key.keyHash);
    return `($${base}, $${base + 1})`;
  });
  return { sql: tuples.join(", "), params };
}

async function getStates(keys, database = pool) {
  const normalized = normalizeKeys(keys);
  if (!normalized.length) return [];
  const tuples = tupleWhere(normalized);
  const result = await database.query(
    `SELECT scope, key_hash, failures, window_started_at, updated_at
     FROM login_rate_limits
     WHERE (scope, key_hash) IN (${tuples.sql})`,
    tuples.params
  );
  return result.rows;
}

/**
 * Atomically increments every supplied bucket. If its fixed window has already
 * expired, the same statement resets that bucket to a fresh count of one.
 *
 * Login middleware uses this as an attempt reservation before bcrypt runs. That
 * closes the race where many parallel requests could all observe the same old
 * counter and pass the limiter before any rejected password was recorded.
 */
async function recordFailure(
  keys,
  { windowSeconds = 15 * 60 } = {},
  database = pool
) {
  const normalized = normalizeKeys(keys);
  if (!normalized.length) return [];
  const safeWindowSeconds = Math.max(60, Math.min(24 * 60 * 60, Number(windowSeconds) || 900));

  const params = [];
  const rows = normalized.map((key, index) => {
    const base = index * 2 + 1;
    params.push(key.scope, key.keyHash);
    return `($${base}, $${base + 1}, 1, NOW(), NOW())`;
  });
  const windowParam = params.length + 1;
  params.push(safeWindowSeconds);

  const result = await database.query(
    `INSERT INTO login_rate_limits (
       scope, key_hash, failures, window_started_at, updated_at
     )
     VALUES ${rows.join(", ")}
     ON CONFLICT (scope, key_hash) DO UPDATE
     SET failures = CASE
           WHEN login_rate_limits.window_started_at <=
             NOW() - ($${windowParam}::int * interval '1 second')
           THEN 1
           ELSE login_rate_limits.failures + 1
         END,
         window_started_at = CASE
           WHEN login_rate_limits.window_started_at <=
             NOW() - ($${windowParam}::int * interval '1 second')
           THEN NOW()
           ELSE login_rate_limits.window_started_at
         END,
         updated_at = NOW()
     RETURNING scope, key_hash, failures, window_started_at, updated_at`,
    params
  );
  return result.rows;
}

/** Undo only the current successful request's reservation for selected buckets. */
async function decrementKeys(keys, database = pool) {
  const normalized = normalizeKeys(keys);
  if (!normalized.length) return 0;
  const tuples = tupleWhere(normalized);
  const result = await database.query(
    `UPDATE login_rate_limits
     SET failures = GREATEST(failures - 1, 0),
         updated_at = NOW()
     WHERE (scope, key_hash) IN (${tuples.sql})`,
    tuples.params
  );
  return result.rowCount || 0;
}

async function clearKeys(keys, database = pool) {
  const normalized = normalizeKeys(keys);
  if (!normalized.length) return 0;
  const tuples = tupleWhere(normalized);
  const result = await database.query(
    `DELETE FROM login_rate_limits
     WHERE (scope, key_hash) IN (${tuples.sql})`,
    tuples.params
  );
  return result.rowCount || 0;
}

async function pruneExpired(
  { olderThanSeconds = 24 * 60 * 60 } = {},
  database = pool
) {
  const safeSeconds = Math.max(15 * 60, Math.min(30 * 24 * 60 * 60, Number(olderThanSeconds) || 86400));
  const result = await database.query(
    `DELETE FROM login_rate_limits
     WHERE updated_at < NOW() - ($1::int * interval '1 second')`,
    [safeSeconds]
  );
  return result.rowCount || 0;
}

module.exports = {
  VALID_SCOPES,
  clearKeys,
  decrementKeys,
  getStates,
  normalizeKeys,
  pruneExpired,
  recordFailure,
};
