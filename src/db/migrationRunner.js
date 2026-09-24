const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9][a-z0-9_]*)\.sql$/;

// These are the exact schema files that main executed on every startup before
// versioned migrations were introduced. Keep them frozen: existing databases
// will execute each one one final time (they are idempotent by design), while a
// brand-new database can build the same current schema from zero.
//
// expectedGitBlobSha is a guard against editing a historical migration in
// place. Future schema changes belong in src/db/migrations/012_*.sql onward.
const BASELINE_MIGRATIONS = Object.freeze([
  { version: 1, name: "core_schema", file: "schema.sql", expectedGitBlobSha: "b78f339fa5d05d192b5c930d2ef549d3f2216825" },
  { version: 2, name: "telegram_alerts", file: "telegramAlertsSchema.sql", expectedGitBlobSha: "e1474879a09da1e78d39e31c069d56c03ae403d9" },
  { version: 3, name: "social_channels", file: "socialChannelsSchema.sql", expectedGitBlobSha: "7cd77575bde87e940c21a041aa5103d3efa9b118" },
  { version: 4, name: "follow_up_multi_channel", file: "followUpMultiChannelSchema.sql", expectedGitBlobSha: "33a270283e1b7a617e55f944640254a3e62e442a" },
  { version: 5, name: "access_control", file: "accessControlSchema.sql", expectedGitBlobSha: "6ea083134cd3c5494ddd3610f8e76cab88e79991" },
  { version: 6, name: "lead_distribution_safety", file: "leadDistributionSafetySchema.sql", expectedGitBlobSha: "4781e38066571fd078835d7ce4513a214f115c26" },
  { version: 7, name: "lead_attribution", file: "leadAttributionSchema.sql", expectedGitBlobSha: "996c2f71b3e6b1c1e5340b6d094b7527929a702b" },
  { version: 8, name: "whatsapp_policy", file: "whatsappPolicySchema.sql", expectedGitBlobSha: "b15bdfeccaa16a9aa009b4dcb48f1af44b1b69ca" },
  { version: 9, name: "setup_status", file: "setupStatusSchema.sql", expectedGitBlobSha: "7c5a9b047c611a7bf8a2bb7cc712f3e5fc0207cc" },
  { version: 10, name: "inbound_processing", file: "inboundProcessingSchema.sql", expectedGitBlobSha: "b8661d5422fc387c79fcde1abd0138a237c93754" },
  { version: 11, name: "login_rate_limits", file: "loginRateLimitSchema.sql", expectedGitBlobSha: "0d19d885f25864935a53b5728a1b38e349daa974" },
]);

// Two signed 32-bit keys for a transaction-scoped advisory lock.
//
// Render client databases use Neon pooled connections (PgBouncer transaction
// pooling). Session-level advisory locks are unsafe there because the lock and
// unlock statements can run on different PostgreSQL backends. Keep migration
// coordination inside the same explicit transaction as each migration instead.
//
// The second key is an intentional lock epoch bump from the legacy
// session-level lock. That prevents a stale legacy lock left behind on a pooled
// backend from blocking deployments after this fix.
const LEGACY_MIGRATION_LOCK_KEYS = Object.freeze([441121, 20260904]);
const MIGRATION_LOCK_KEYS = Object.freeze([441121, 20260924]);
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_MIGRATION_LOCK_RETRY_MS = 250;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the migration mutex inside an already-open PostgreSQL transaction.
 *
 * IMPORTANT: callers must issue BEGIN before calling this function and must
 * COMMIT or ROLLBACK afterward. pg_advisory_xact_lock is released
 * automatically at transaction end, which makes it safe with PgBouncer
 * transaction pooling.
 */
async function acquireMigrationLock(
  client,
  {
    lockKeys = MIGRATION_LOCK_KEYS,
    timeoutMs = DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    retryMs = DEFAULT_MIGRATION_LOCK_RETRY_MS,
    now = Date.now,
    sleepFn = sleep,
  } = {}
) {
  const safeTimeoutMs = positiveInt(timeoutMs, DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
  const safeRetryMs = Math.min(
    safeTimeoutMs,
    positiveInt(retryMs, DEFAULT_MIGRATION_LOCK_RETRY_MS)
  );
  const startedAt = now();

  while (true) {
    const result = await client.query(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
      lockKeys
    );
    if (result.rows?.[0]?.acquired === true) return true;

    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= safeTimeoutMs) {
      const err = new Error(
        `Timed out after ${safeTimeoutMs}ms waiting for the database migration lock. ` +
          "Another app instance or migration may still be using it."
      );
      err.code = "MIGRATION_LOCK_TIMEOUT";
      throw err;
    }

    await sleepFn(Math.min(safeRetryMs, Math.max(1, safeTimeoutMs - elapsedMs)));
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function gitBlobSha1(buffer) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const header = Buffer.from(`blob ${body.length}\0`);
  return crypto.createHash("sha1").update(header).update(body).digest("hex");
}

function migrationFromFile({ version, name, filePath, expectedGitBlobSha = null }) {
  const sqlBuffer = fs.readFileSync(filePath);
  if (expectedGitBlobSha) {
    const actualGitBlobSha = gitBlobSha1(sqlBuffer);
    if (actualGitBlobSha !== expectedGitBlobSha) {
      throw new Error(
        `Historical migration drift detected for ${path.basename(filePath)}. ` +
          `Expected Git blob ${expectedGitBlobSha}, got ${actualGitBlobSha}. ` +
          "Do not edit applied schema files; add a new numbered migration instead."
      );
    }
  }

  return {
    version,
    name,
    filename: path.basename(filePath),
    filePath,
    sql: sqlBuffer.toString("utf8"),
    checksum: sha256(sqlBuffer),
  };
}

function discoverFutureMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = MIGRATION_FILE_PATTERN.exec(entry.name);
      if (!match) {
        throw new Error(
          `Invalid migration filename ${entry.name}. Use NNN_snake_case_name.sql (for example 012_add_contact_tags.sql).`
        );
      }
      return {
        version: Number(match[1]),
        name: match[2],
        filePath: path.join(MIGRATIONS_DIR, entry.name),
      };
    });
}

function normalizeMigration(migration) {
  if (!migration || !Number.isInteger(migration.version) || migration.version <= 0) {
    throw new Error("Every database migration must have a positive integer version.");
  }
  if (!/^[a-z0-9][a-z0-9_]*$/.test(migration.name || "")) {
    throw new Error(`Migration ${migration.version} has an invalid name.`);
  }
  if (typeof migration.sql !== "string") {
    throw new Error(`Migration ${migration.version} must contain SQL text.`);
  }
  const sqlBuffer = Buffer.from(migration.sql, "utf8");
  return {
    ...migration,
    checksum: migration.checksum || sha256(sqlBuffer),
  };
}

function validateMigrationPlan(migrations) {
  const normalized = migrations.map(normalizeMigration).sort((a, b) => a.version - b.version);
  const names = new Set();

  normalized.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration sequence is incomplete: expected version ${expectedVersion}, found ${migration.version}.`
      );
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate migration name: ${migration.name}.`);
    }
    names.add(migration.name);
  });

  return normalized;
}

function loadMigrations() {
  const baseline = BASELINE_MIGRATIONS.map((migration) =>
    migrationFromFile({
      ...migration,
      filePath: path.join(__dirname, migration.file),
    })
  );
  const future = discoverFutureMigrationFiles().map((migration) => migrationFromFile(migration));
  return validateMigrationPlan([...baseline, ...future]);
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function validateAppliedMigrations(appliedRows, migrations) {
  const sortedRows = [...appliedRows].sort((a, b) => Number(a.version) - Number(b.version));
  const planByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  sortedRows.forEach((row, index) => {
    const version = Number(row.version);
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new Error(
        `Database migration history is incomplete: expected version ${expectedVersion}, found ${version}. ` +
          "Do not skip or manually reorder migrations."
      );
    }

    const planned = planByVersion.get(version);
    if (!planned) {
      throw new Error(
        `Database migration ${version} (${row.name}) is not present in this app version. ` +
          "The database is newer than the running code; deploy the matching/newer app version instead of starting an older build."
      );
    }
    if (row.name !== planned.name) {
      throw new Error(
        `Database migration ${version} name mismatch: database has ${row.name}, code has ${planned.name}.`
      );
    }
    if (row.checksum !== planned.checksum) {
      throw new Error(
        `Database migration ${version} (${row.name}) checksum mismatch. ` +
          "An applied migration was edited; restore it and create a new migration for the schema change."
      );
    }
  });
}

async function runMigrations(poolLike, options = {}) {
  if (!poolLike || typeof poolLike.connect !== "function") {
    throw new Error("runMigrations requires a PostgreSQL pool-like object with connect().");
  }

  const migrations = validateMigrationPlan(options.migrations || loadMigrations());
  const lockTimeoutMs = positiveInt(
    options.lockTimeoutMs,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
  );
  const lockRetryMs = positiveInt(
    options.lockRetryMs,
    DEFAULT_MIGRATION_LOCK_RETRY_MS
  );
  const client = await poolLike.connect();
  let appliedCount = 0;
  let loggedLockAcquired = false;
  let finalAppliedRows = [];

  try {
    if (!options.quiet) {
      console.log(
        `[Startup] Waiting for database migration lock (max ${lockTimeoutMs}ms)...`
      );
    }

    while (true) {
      await client.query("BEGIN");
      let activeMigration = null;

      try {
        // The transaction-scoped advisory lock pins this transaction's
        // migration work to one PostgreSQL backend even when DATABASE_URL
        // points at a PgBouncer transaction pool.
        await acquireMigrationLock(client, {
          timeoutMs: lockTimeoutMs,
          retryMs: lockRetryMs,
        });

        if (!loggedLockAcquired && !options.quiet) {
          console.log("[Startup] Database migration lock acquired.");
          loggedLockAcquired = true;
        }

        await ensureMigrationTable(client);
        const appliedResult = await client.query(
          "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC"
        );
        validateAppliedMigrations(appliedResult.rows, migrations);

        const appliedVersions = new Set(
          appliedResult.rows.map((row) => Number(row.version))
        );
        activeMigration = migrations.find(
          (migration) => !appliedVersions.has(migration.version)
        );

        if (!activeMigration) {
          finalAppliedRows = appliedResult.rows;
          await client.query("COMMIT");
          break;
        }

        await client.query(activeMigration.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [activeMigration.version, activeMigration.name, activeMigration.checksum]
        );
        await client.query("COMMIT");
        appliedCount += 1;

        if (!options.quiet) {
          console.log(
            `Applied database migration ${String(activeMigration.version).padStart(3, "0")}_${activeMigration.name}`
          );
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});

        if (activeMigration && err?.code !== "MIGRATION_LOCK_TIMEOUT") {
          const wrapped = new Error(
            `Database migration ${String(activeMigration.version).padStart(3, "0")}_${activeMigration.name} failed: ${err.message}`
          );
          wrapped.cause = err;
          throw wrapped;
        }
        throw err;
      }
    }

    const result = {
      appliedCount,
      skippedCount: migrations.length - appliedCount,
      currentVersion: migrations.length ? migrations[migrations.length - 1].version : 0,
      migrations: finalAppliedRows,
    };
    if (!options.quiet) {
      console.log(
        `[Startup] Database migrations ready at version ${result.currentVersion} ` +
          `(${result.appliedCount} applied, ${result.skippedCount} already current).`
      );
    }
    return result;
  } finally {
    // Transaction-scoped advisory locks are released automatically by COMMIT
    // or ROLLBACK, so no session-level unlock query is required (or safe when
    // running through PgBouncer transaction pooling).
    if (typeof client.release === "function") await client.release();
  }
}

module.exports = {
  BASELINE_MIGRATIONS,
  DEFAULT_MIGRATION_LOCK_RETRY_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  LEGACY_MIGRATION_LOCK_KEYS,
  MIGRATION_FILE_PATTERN,
  MIGRATION_LOCK_KEYS,
  acquireMigrationLock,
  gitBlobSha1,
  loadMigrations,
  runMigrations,
  sha256,
  validateAppliedMigrations,
  validateMigrationPlan,
};
