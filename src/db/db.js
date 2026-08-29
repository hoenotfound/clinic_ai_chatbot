const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

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
 * Runs schema.sql against the database. Safe to call on every startup —
 * every statement is CREATE/ALTER/INDEX IF NOT EXISTS, so this is a no-op
 * once the schema already exists.
 */
async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const telegramAlertsSchema = fs.readFileSync(
    path.join(__dirname, "telegramAlertsSchema.sql"),
    "utf8"
  );
  await pool.query(schema);
  await pool.query(telegramAlertsSchema);
}

module.exports = { pool, initSchema };
