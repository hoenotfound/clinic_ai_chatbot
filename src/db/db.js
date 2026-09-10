const { Pool } = require("pg");
const {
  DEFAULT_MIGRATION_LOCK_RETRY_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  runMigrations,
} = require("./migrationRunner");

const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function databasePoolOptions(env = process.env) {
  return {
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: positiveInt(
      env.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS
    ),
  };
}

// Neon (and most managed Postgres hosts) require SSL. Neon connection
// strings work with the default `ssl: { rejectUnauthorized: false }` — no
// need to fuss with CA certs for this use case.
const poolOptions = databasePoolOptions();
const pool = new Pool(poolOptions);

pool.on("error", (err) => {
  // Fired on idle client errors (e.g. a dropped connection) — log instead of
  // crashing the whole process, since the pool recovers on its own.
  console.error("Unexpected Postgres pool error:", err);
});

/**
 * Applies only missing, versioned database migrations before startup.
 *
 * The name is kept as initSchema() for compatibility with the existing server
 * bootstrap and tests, but schema setup is no longer a blind replay of every
 * SQL file on every Render restart.
 */
async function initSchema(options = {}) {
  const startedAt = Date.now();
  const lockTimeoutMs = positiveInt(
    options.lockTimeoutMs ?? process.env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
  );
  const lockRetryMs = positiveInt(
    options.lockRetryMs ?? process.env.DATABASE_MIGRATION_LOCK_RETRY_MS,
    DEFAULT_MIGRATION_LOCK_RETRY_MS
  );

  console.log(
    `[Startup] Database initialization started ` +
      `(connect timeout ${poolOptions.connectionTimeoutMillis}ms, ` +
      `migration lock timeout ${lockTimeoutMs}ms).`
  );

  try {
    const result = await runMigrations(pool, {
      ...options,
      lockTimeoutMs,
      lockRetryMs,
    });
    console.log(
      `[Startup] Database initialization complete at migration version ` +
        `${result.currentVersion} (${Date.now() - startedAt}ms).`
    );
    return result;
  } catch (err) {
    console.error(
      `[Startup] Database initialization failed after ${Date.now() - startedAt}ms: ` +
        `${err?.message || err}`
    );
    throw err;
  }
}

module.exports = {
  DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
  databasePoolOptions,
  initSchema,
  pool,
};
