"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { markScoreDeferred } = require("../src/db/leadScoringRepo");

test("Postgres: temporary provider-wide failure restores the durable scoring attempt atomically", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "scoring_defer_" + process.pid + "_" + Date.now();
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE lead_temperature_scores (
        id BIGINT PRIMARY KEY, lead_id INTEGER, through_message_id INTEGER,
        status TEXT NOT NULL DEFAULT 'processing', attempts INTEGER NOT NULL DEFAULT 1,
        error_text TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO lead_temperature_scores(id,lead_id,through_message_id,status,attempts)
      VALUES (1,7,10,'processing',1);
    `);
    const temporary = new Error("Gemini 429: rate limit");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const deferred = await markScoreDeferred(1, temporary, client);
      assert.equal(deferred.deferred, true);
      assert.equal(deferred.terminal, false);
      assert.equal(Number(deferred.attempts), 0,
        "a long rate-limit outage must not consume the finite scoring budget");
      await client.query("UPDATE lead_temperature_scores SET status='processing',attempts=attempts+1 WHERE id=1");
    }
    assert.equal((await client.query("SELECT attempts FROM lead_temperature_scores WHERE id=1")).rows[0].attempts, 1);
    await client.query("UPDATE lead_temperature_scores SET status='completed' WHERE id=1");
    assert.equal(await markScoreDeferred(1, temporary, client), null,
      "a provider error must not overwrite a completed scoring result");
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await client.end();
  }
});
