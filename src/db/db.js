const { Pool } = require("pg");
const { runMigrations } = require("./migrationRunner");

// Neon (and most managed Postgres hosts) require SSL. Neon connection
// strings work with the default `ssl: { rejectUnauthorized: false }` — no
// need to fuss with CA certs for this use case.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
async function initSchema() {
  return runMigrations(pool);
}

module.exports = { pool, initSchema };
