"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runFollowUpRead, preparedNameForSql, compactReadSql } =
  require("../src/utils/namedFollowUpRead");

test("follow-up reads default to exact unchanged SQL and parameters", async () => {
  const calls = [];
  const pool = { query(...args) { calls.push(args); return Promise.resolve({ rows: [1] }); } };
  const sql = "SELECT $1::integer AS value";
  const params = [7];
  const result = await runFollowUpRead(pool, pool, sql, params, { env: {} });
  assert.deepEqual(result.rows, [1]);
  assert.deepEqual(calls, [[sql, params]]);
});

test("only enabled real-pool reads use stable per-SQL named statements", async () => {
  const calls = [];
  const pool = { query(...args) { calls.push(args); return Promise.resolve({ rows: [] }); } };
  const env = { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED: "true" };
  const sql = "SELECT $1::integer AS value", other = "SELECT $1::text AS value";
  await runFollowUpRead(pool, pool, sql, [7], { env });
  await runFollowUpRead(pool, pool, sql, [8], { env });
  await runFollowUpRead(pool, pool, other, ["x"], { env });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(calls[0][0], { text: sql, values: [7], name: preparedNameForSql(sql) });
  assert.deepEqual(calls[1][0], { text: sql, values: [8], name: calls[0][0].name });
  assert.notEqual(calls[2][0].name, calls[0][0].name);
  assert.ok(calls[0][0].name.length < 63);
});

test("injected databases and disabled switches preserve query interface", async () => {
  const calls = [];
  const pool = {};
  const testDb = { query(...args) { calls.push(args); return Promise.resolve({ rows: [] }); } };
  const sql = "SELECT now()", values = [];
  await runFollowUpRead(testDb, pool, sql, values,
    { env: { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED: "true" } });
  await runFollowUpRead(testDb, pool, sql, values,
    { env: { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED: "false" } });
  assert.deepEqual(calls, [[sql, values], [sql, values]]);
});

test("database failures propagate and never cause automatic replays", async () => {
  let calls = 0;
  const error = Object.assign(new Error("prepared statement unavailable"), { code: "0A000" });
  const pool = { query() { calls++; return Promise.reject(error); } };
  await assert.rejects(runFollowUpRead(pool, pool, "SELECT 1", [],
    { env: { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED: "true" } }), e => e === error);
  assert.equal(calls, 1);
});

test("different SQL text always produces different names", () => {
  assert.notEqual(preparedNameForSql("SELECT 1"), preparedNameForSql("SELECT 2"));
});

// PostgreSQL CI verifies node-postgres' real prepared-query protocol; no writes.
test("real PostgreSQL reuses the same named SELECT with new parameter bindings", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
    ssl: false, max: 1, idleTimeoutMillis: 1000 });
  const env = { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED: "true" };
  const sql = "SELECT $1::integer AS value";
  try {
    const first = await runFollowUpRead(pool, pool, sql, [17], { env });
    const next = await runFollowUpRead(pool, pool, sql, [29], { env });
    assert.equal(first.rows[0].value, 17);
    assert.equal(next.rows[0].value, 29);
  } finally {
    await pool.end();
  }
});

test("SQL formatting reduction keeps quoted values, identifiers and inline comments", () => {
  const input = [
    "  SELECT 'hello -- literal' AS label,",
    '         "a -- quoted identifier" AS field',
    "    -- remove only this whole comment",
    "  FROM t -- preserve this inline comment",
  ].join("\n");
  assert.equal(compactReadSql(input), [
    "SELECT 'hello -- literal' AS label,",
    '"a -- quoted identifier" AS field',
    "",
    "FROM t -- preserve this inline comment",
  ].join("\n"));
});

test("multiline literals and dollar quotes remain byte-for-byte unchanged", () => {
  const input = [
    "  SELECT 'line one",
    "  -- a literal line",
    "   line three' AS text,",
    "  $tag$",
    "  -- another literal",
    "  $tag$ AS source;",
  ].join("\n");
  const output = compactReadSql(input);
  assert.match(output, /'line one\n  -- a literal line\n   line three'/);
  assert.match(output, /\$tag\$\n  -- another literal\n  \$tag\$/);
  assert.ok(output.startsWith("SELECT "));
});

test("unknown or incomplete literal syntax falls back to original SQL", () => {
  const input = "    SELECT 'not closed\n    -- not removable";
  assert.equal(compactReadSql(input), input);
});

test("enabled read sends compact SQL and the name matches the compact text", async () => {
  const calls = [];
  const db = {query(...args){ calls.push(args); return Promise.resolve({rows:[]}); }};
  const sql = "  SELECT $1::int\n    -- unneeded SQL comment\n    AS value";
  await runFollowUpRead(db, db, sql, [8],
    {env: { NEUTRO_NAMED_FOLLOWUP_READS_ENABLED:"true" }});
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0].text, "SELECT $1::int\n\nAS value");
  assert.equal(calls[0][0].name, preparedNameForSql(calls[0][0].text));
});
