const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const repo = require("../src/db/telegramImmediateAlertRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "immediate Telegram queue migrates legacy markers, retries safely, and fences leases",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `telegram_immediate_${process.pid}_${Date.now()}`;
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/020_telegram_immediate_alert_queue.sql"),
      "utf8"
    );

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY
        );

        CREATE TABLE telegram_immediate_alerts (
          id SERIAL PRIMARY KEY,
          event_key TEXT NOT NULL UNIQUE,
          alert_type TEXT NOT NULL,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        INSERT INTO contacts (id) VALUES (12), (13);
        INSERT INTO telegram_immediate_alerts (
          event_key, alert_type, contact_id, created_at
        )
        VALUES (
          'legacy:12:1',
          'human_intervention',
          12,
          now() - interval '1 day'
        );
      `);
      await client.query(migrationSql);

      const legacy = await client.query(
        `SELECT status, attempts, sent_at, terminal_at
         FROM telegram_immediate_alerts
         WHERE event_key = 'legacy:12:1'`
      );
      assert.equal(legacy.rows[0].status, "sent");
      assert.equal(legacy.rows[0].attempts, 0);
      assert.ok(legacy.rows[0].sent_at);
      assert.equal(legacy.rows[0].terminal_at, null);

      const poolLike = {
        query: (...args) => client.query(...args),
        async connect() {
          return {
            query: (...args) => client.query(...args),
            release() {},
          };
        },
      };
      const query = client.query.bind(client);

      const queued = await repo.queueAlert({
        eventKey: "booking-ready:12:44",
        type: "booking_ready",
        contactId: 12,
        messageText: "Booking ready queued alert",
      }, poolLike);
      assert.equal(queued.status, "pending");
      assert.equal(queued.attempts, 0);

      const firstClaim = await repo.claimReady({
        limit: 5,
        staleAfterSeconds: 60,
        maxAttempts: 5,
      }, query);
      assert.equal(firstClaim.length, 1);
      assert.equal(firstClaim[0].id, queued.id);
      assert.equal(firstClaim[0].status, "sending");
      assert.equal(firstClaim[0].attempts, 1);
      assert.match(firstClaim[0].lease_token, /^[a-f0-9]{32}$/);

      const failed = await repo.markFailed(
        queued.id,
        firstClaim[0].lease_token,
        new Error("Telegram timeout"),
        { retryDelaySeconds: 1, maxAttempts: 5 },
        query
      );
      assert.equal(failed.status, "pending");
      assert.equal(failed.terminal_at, null);
      assert.ok(failed.next_attempt_at);
      assert.match(failed.error_text, /Telegram timeout/);

      // Old leases cannot overwrite the row after the claim was released.
      assert.equal(
        await repo.markSent(queued.id, firstClaim[0].lease_token, query),
        null
      );

      await client.query(
        `UPDATE telegram_immediate_alerts
         SET next_attempt_at = now() - interval '1 second'
         WHERE id = $1`,
        [queued.id]
      );
      const retryClaim = await repo.claimReady({
        limit: 5,
        staleAfterSeconds: 60,
        maxAttempts: 5,
      }, query);
      assert.equal(retryClaim.length, 1);
      assert.equal(retryClaim[0].attempts, 2);
      assert.notEqual(retryClaim[0].lease_token, firstClaim[0].lease_token);

      const sent = await repo.markSent(
        queued.id,
        retryClaim[0].lease_token,
        query
      );
      assert.equal(sent.status, "sent");
      assert.ok(sent.sent_at);
      assert.equal(sent.lease_token, null);

      const firstHuman = await repo.queueAlert({
        eventKey: "human:13:100",
        type: "human_intervention",
        contactId: 13,
        messageText: "First human alert",
        cooldownMinutes: 30,
      }, poolLike);
      assert.ok(firstHuman);

      const suppressedHuman = await repo.queueAlert({
        eventKey: "human:13:101",
        type: "human_intervention",
        contactId: 13,
        messageText: "Second human alert",
        cooldownMinutes: 30,
      }, poolLike);
      assert.equal(suppressedHuman, null);

      const finalAttempt = await repo.queueAlert({
        eventKey: "delivery:12:event:final",
        type: "delivery_failure",
        contactId: 12,
        messageText: "Final attempt",
      }, poolLike);
      const finalClaim = await repo.claimReady({
        limit: 5,
        staleAfterSeconds: 60,
        maxAttempts: 5,
      }, query);
      const finalRow = finalClaim.find((row) => row.id === finalAttempt.id);
      assert.ok(finalRow);

      await client.query(
        `UPDATE telegram_immediate_alerts
         SET attempts = 5,
             status = 'sending',
             claimed_at = now() - interval '2 minutes'
         WHERE id = $1`,
        [finalAttempt.id]
      );
      const exhausted = await repo.markExhaustedStale({
        staleAfterSeconds: 60,
        maxAttempts: 5,
      }, query);
      assert.ok(exhausted.some((row) => row.id === finalAttempt.id));

      const terminal = await client.query(
        `SELECT status, terminal_at, lease_token
         FROM telegram_immediate_alerts
         WHERE id = $1`,
        [finalAttempt.id]
      );
      assert.equal(terminal.rows[0].status, "failed");
      assert.ok(terminal.rows[0].terminal_at);
      assert.equal(terminal.rows[0].lease_token, null);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
