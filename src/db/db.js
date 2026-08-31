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
 * Runs the schema files against the database. Safe to call on every startup.
 */
async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const telegramAlertsSchema = fs.readFileSync(
    path.join(__dirname, "telegramAlertsSchema.sql"),
    "utf8"
  );
  const socialChannelsSchema = fs.readFileSync(
    path.join(__dirname, "socialChannelsSchema.sql"),
    "utf8"
  );
  const accessControlSchema = fs.readFileSync(
    path.join(__dirname, "accessControlSchema.sql"),
    "utf8"
  );
  await pool.query(schema);
  await pool.query(telegramAlertsSchema);
  await pool.query(socialChannelsSchema);
  await pool.query(accessControlSchema);
}

module.exports = { pool, initSchema };
