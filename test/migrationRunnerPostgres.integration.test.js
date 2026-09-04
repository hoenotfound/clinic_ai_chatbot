const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const {
  BASELINE_MIGRATIONS,
  loadMigrations,
  runMigrations,
} = require("../src/db/migrationRunner");

const connectionString = process.env.TEST_DATABASE_URL;

function poolForSchema(schemaName) {
  return {
    async connect() {
      const client = new Client({ connectionString });
      await client.connect();
      await client.query(`SET search_path TO ${schemaName}`);
      return {
        query: (...args) => client.query(...args),
        release: () => client.end(),
      };
    },
  };
}

async function withIsolatedSchema(prefix, fn) {
  const admin = new Client({ connectionString });
  const schemaName = `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await admin.query(`SET search_path TO ${schemaName}`);
    await fn({ admin, schemaName, pool: poolForSchema(schemaName) });
  } finally {
    await admin.query("SET search_path TO public").catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await admin.end();
  }
}

test(
  "fresh database is built once and concurrent/restarted app instances do not reapply migrations",
  { skip: !connectionString },
  async () => {
    await withIsolatedSchema("migrations_fresh", async ({ admin, pool }) => {
      const migrations = loadMigrations();

      // Simulate two Render instances starting against the same fresh client
      // database. The advisory lock must serialize them so only one applies
      // each migration and the other sees the completed history.
      const results = await Promise.all([
        runMigrations(pool, { quiet: true }),
        runMigrations(pool, { quiet: true }),
      ]);

      assert.deepEqual(
        results.map((result) => result.appliedCount).sort((a, b) => a - b),
        [0, migrations.length]
      );
      assert.ok(results.every((result) => result.currentVersion === migrations.length));

      const history = await admin.query(
        "SELECT version, name FROM schema_migrations ORDER BY version"
      );
      assert.equal(history.rowCount, migrations.length);
      assert.deepEqual(
        history.rows.map((row) => Number(row.version)),
        migrations.map((migration) => migration.version)
      );

      const tables = await admin.query(`
        SELECT
          to_regclass('contacts') AS contacts,
          to_regclass('messages') AS messages,
          to_regclass('inbound_processing_jobs') AS inbound_processing_jobs,
          to_regclass('login_rate_limits') AS login_rate_limits
      `);
      assert.ok(tables.rows[0].contacts);
      assert.ok(tables.rows[0].messages);
      assert.ok(tables.rows[0].inbound_processing_jobs);
      assert.ok(tables.rows[0].login_rate_limits);

      // A normal Render restart is now a cheap no-op instead of replaying all
      // historical schema SQL.
      const restarted = await runMigrations(pool, { quiet: true });
      assert.equal(restarted.appliedCount, 0);
      assert.equal(restarted.skippedCount, migrations.length);
    });
  }
);

test(
  "an existing pre-migration database is baselined without losing its data",
  { skip: !connectionString },
  async () => {
    await withIsolatedSchema("migrations_legacy", async ({ admin, pool }) => {
      const migrations = loadMigrations();
      const baseline = migrations.slice(0, BASELINE_MIGRATIONS.length);

      // Reproduce today's production state: the old startup path has already
      // executed all of its schema files, but schema_migrations does not exist.
      for (const migration of baseline) {
        await admin.query(migration.sql);
      }

      const contact = await admin.query(
        `INSERT INTO contacts (whatsapp_number, name)
         VALUES ('60123456789', 'Existing Patient')
         RETURNING id`
      );
      await admin.query(
        `INSERT INTO messages (contact_id, role, content, whatsapp_message_id)
         VALUES ($1, 'user', 'Existing conversation stays intact', 'legacy-message-1')`,
        [contact.rows[0].id]
      );
      const stagesBefore = await admin.query("SELECT COUNT(*)::int AS count FROM pipeline_stages");

      const result = await runMigrations(pool, { quiet: true });
      assert.equal(result.appliedCount, migrations.length);

      const preservedContact = await admin.query(
        "SELECT whatsapp_number, name FROM contacts WHERE id = $1",
        [contact.rows[0].id]
      );
      assert.deepEqual(preservedContact.rows[0], {
        whatsapp_number: "60123456789",
        name: "Existing Patient",
      });

      const preservedMessage = await admin.query(
        "SELECT content FROM messages WHERE whatsapp_message_id = 'legacy-message-1'"
      );
      assert.equal(preservedMessage.rows[0].content, "Existing conversation stays intact");

      const stagesAfter = await admin.query("SELECT COUNT(*)::int AS count FROM pipeline_stages");
      assert.equal(stagesAfter.rows[0].count, stagesBefore.rows[0].count);

      const history = await admin.query("SELECT COUNT(*)::int AS count FROM schema_migrations");
      assert.equal(history.rows[0].count, migrations.length);
    });
  }
);

test(
  "a failed migration rolls back its schema changes and is not marked applied",
  { skip: !connectionString },
  async () => {
    await withIsolatedSchema("migrations_rollback", async ({ admin, pool }) => {
      const customMigrations = [
        {
          version: 1,
          name: "create_probe",
          sql: "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY); INSERT INTO migration_probe VALUES (1);",
        },
        {
          version: 2,
          name: "failing_change",
          sql: "CREATE TABLE should_be_rolled_back (id INTEGER); SELECT * FROM migration_table_that_does_not_exist;",
        },
      ];

      await assert.rejects(
        () => runMigrations(pool, { quiet: true, migrations: customMigrations }),
        /migration 002_failing_change failed/i
      );

      const history = await admin.query(
        "SELECT version, name FROM schema_migrations ORDER BY version"
      );
      assert.deepEqual(
        history.rows.map((row) => ({ version: Number(row.version), name: row.name })),
        [{ version: 1, name: "create_probe" }]
      );

      const probe = await admin.query("SELECT id FROM migration_probe");
      assert.equal(probe.rows[0].id, 1);

      const rolledBack = await admin.query("SELECT to_regclass('should_be_rolled_back') AS table_name");
      assert.equal(rolledBack.rows[0].table_name, null);
    });
  }
);
