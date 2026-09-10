const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  listMigrationFiles,
  runOpsMigrations,
} = require("../src/ops/migrationRunner");

test("Ops Registry migrations use their own namespace instead of client migrations", () => {
  const opsDir = path.join(__dirname, "..", "src", "ops", "migrations");
  const clientDir = path.join(__dirname, "..", "src", "db", "migrations");
  assert.deepEqual(listMigrationFiles(opsDir), [
    "001_ops_clients.sql",
    "002_unique_token_env_key.sql",
  ]);
  assert.equal(fs.readdirSync(clientDir).some((name) => /ops_clients/i.test(name)), false);

  const initialSql = fs.readFileSync(path.join(opsDir, "001_ops_clients.sql"), "utf8");
  const uniquenessSql = fs.readFileSync(path.join(opsDir, "002_unique_token_env_key.sql"), "utf8");
  assert.match(initialSql, /CREATE TABLE IF NOT EXISTS ops_clients/i);
  assert.match(uniquenessSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_clients_token_env_key_unique/i);
  assert.doesNotMatch(
    `${initialSql}\n${uniquenessSql}`,
    /DROP\s+TABLE|TRUNCATE|customer|message_content|access_token|api_key|database_url|admin_password/i,
  );
});

test("migration runner records migrations and skips already applied files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-migrations-"));
  fs.writeFileSync(path.join(dir, "001_first.sql"), "CREATE TABLE first_table(id int);");
  fs.writeFileSync(path.join(dir, "002_second.sql"), "CREATE TABLE second_table(id int);");
  fs.writeFileSync(path.join(dir, "README.md"), "ignored");

  const queries = [];
  const connection = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/SELECT name FROM ops_schema_migrations/.test(sql)) {
        return { rows: [{ name: "001_first.sql" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => connection,
  };

  try {
    const applied = await runOpsMigrations(pool, { migrationsDir: dir });
    assert.deepEqual(applied, ["002_second.sql"]);
    assert.equal(queries.some(({ sql }) => /CREATE TABLE first_table/.test(sql)), false);
    assert.equal(queries.some(({ sql }) => /CREATE TABLE second_table/.test(sql)), true);
    assert.equal(queries.some(({ sql, params }) => /INSERT INTO ops_schema_migrations/.test(sql) && params?.[0] === "002_second.sql"), true);
    assert.equal(queries.at(-1).sql, "COMMIT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
