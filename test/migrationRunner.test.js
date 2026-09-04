const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASELINE_MIGRATIONS,
  loadMigrations,
  sha256,
  validateAppliedMigrations,
  validateMigrationPlan,
} = require("../src/db/migrationRunner");

test("migration plan keeps the historical 001-011 baseline immutable and ordered", () => {
  const migrations = loadMigrations();

  assert.ok(migrations.length >= BASELINE_MIGRATIONS.length);
  assert.deepEqual(
    migrations.slice(0, BASELINE_MIGRATIONS.length).map((migration) => migration.version),
    Array.from({ length: BASELINE_MIGRATIONS.length }, (_, index) => index + 1)
  );
  assert.deepEqual(
    migrations.slice(0, BASELINE_MIGRATIONS.length).map((migration) => migration.name),
    BASELINE_MIGRATIONS.map((migration) => migration.name)
  );
  assert.equal(migrations[0].filename, "schema.sql");
  assert.equal(migrations[10].filename, "loginRateLimitSchema.sql");

  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(migration.sql.length > 0);
  }
});

test("migration validation rejects version gaps and duplicate names", () => {
  assert.throws(
    () =>
      validateMigrationPlan([
        { version: 1, name: "one", sql: "SELECT 1" },
        { version: 3, name: "three", sql: "SELECT 3" },
      ]),
    /expected version 2, found 3/i
  );

  assert.throws(
    () =>
      validateMigrationPlan([
        { version: 1, name: "same", sql: "SELECT 1" },
        { version: 2, name: "same", sql: "SELECT 2" },
      ]),
    /duplicate migration name/i
  );
});

test("applied migration history refuses checksum drift and databases newer than the app", () => {
  const migrations = [
    {
      version: 1,
      name: "one",
      sql: "SELECT 1",
      checksum: sha256(Buffer.from("SELECT 1")),
    },
  ];

  assert.doesNotThrow(() =>
    validateAppliedMigrations(
      [{ version: 1, name: "one", checksum: migrations[0].checksum }],
      migrations
    )
  );

  assert.throws(
    () =>
      validateAppliedMigrations(
        [{ version: 1, name: "one", checksum: "0".repeat(64) }],
        migrations
      ),
    /checksum mismatch/i
  );

  assert.throws(
    () =>
      validateAppliedMigrations(
        [
          { version: 1, name: "one", checksum: migrations[0].checksum },
          { version: 2, name: "future", checksum: "f".repeat(64) },
        ],
        migrations
      ),
    /database is newer than the running code/i
  );
});
