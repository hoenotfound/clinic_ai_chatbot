const { Pool } = require("pg");
const { createScopedPool } = require("./inboxDatabaseScope");
const {
  DEFAULT_MIGRATION_LOCK_RETRY_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  runMigrations,
} = require("./migrationRunner");

// Preserve the existing 10-second production deadline. A longer deadline can
// be opted into only after testing the Meta router's 8-second webhook forward
// timeout against a sleeping Neon compute. Never replay a failed SQL statement:
// the database or provider may already have accepted the operation.
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_POOL_MAX = 10; // node-postgres's existing default
const DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS = 10_000; // existing pg default

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed : fallback;
}

function databasePoolOptions(env = process.env) {
  const slug = String(env.CLIENT_SLUG || "client")
    .replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 42) || "client";
  return {
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    application_name: `da-chatbot-${slug}`,
    // Keep the effective pg defaults for concurrency and idle eviction.
    // Both can be adjusted separately if production metrics warrant it.
    max: boundedInt(env.DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_MAX, 1, 20),
    idleTimeoutMillis: boundedInt(
      env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS,
      1_000, 60_000
    ),
    connectionTimeoutMillis: boundedInt(
      env.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
      1_000, 30_000
    ),
  };
}

// Neon (and most managed Postgres hosts) require SSL. Neon connection
// strings work with the default `ssl: { rejectUnauthorized: false }` — no
// need to fuss with CA certs for this use case.
const poolOptions = databasePoolOptions();
const pool = createScopedPool(new Pool(poolOptions));

pool.on("error", (err) => {
  // Fired on idle client errors (e.g. a dropped connection) — log instead of
  // crashing the whole process, since the pool recovers on its own.
  console.error("Unexpected Postgres pool error:", err);
});

// node-postgres emits connection errors on checked-out clients directly, not
// through Pool's idle-client error event. A server-side transaction timeout
// could otherwise become an unhandled EventEmitter 'error' and crash Render.
// The query still rejects; callers must roll back/discard their connection.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Unexpected Postgres client error:", {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  });
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
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS,
  databasePoolOptions,
  initSchema,
  pool,
};
