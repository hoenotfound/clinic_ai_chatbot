const fs = require("fs");
const path = require("path");

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");
const MIGRATION_PATTERN = /^\d{3}_.+\.sql$/;
const OPS_MIGRATION_LOCK_ID = 117001;

function listMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort();
}

async function runOpsMigrations(pool, options = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL pool/client is required for Ops Registry migrations.");
  }

  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const connection = typeof pool.connect === "function" ? await pool.connect() : pool;
  const release = connection !== pool && typeof connection.release === "function"
    ? () => connection.release()
    : () => {};

  let transactionStarted = false;

  try {
    await connection.query("BEGIN");
    transactionStarted = true;
    await connection.query("SELECT pg_advisory_xact_lock($1)", [OPS_MIGRATION_LOCK_ID]);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ops_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await connection.query("SELECT name FROM ops_schema_migrations");
    const applied = new Set((appliedResult.rows || []).map((row) => row.name));
    const newlyApplied = [];

    for (const name of listMigrationFiles(migrationsDir)) {
      if (applied.has(name)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
      await connection.query(sql);
      await connection.query(
        "INSERT INTO ops_schema_migrations (name) VALUES ($1)",
        [name],
      );
      newlyApplied.push(name);
    }

    await connection.query("COMMIT");
    transactionStarted = false;
    return newlyApplied;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.query("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
    }
    throw error;
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  listMigrationFiles,
  runOpsMigrations,
};
