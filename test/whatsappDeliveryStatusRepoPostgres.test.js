const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const repo = require("../src/db/whatsappDeliveryStatusRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "WhatsApp delivery-status jobs dedupe, retry stale work and persist terminal state",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `wa_delivery_status_${process.pid}_${Date.now()}`;
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/014_whatsapp_delivery_status_jobs.sql"),
      "utf8"
    );
    const query = client.query.bind(client);

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL,
          whatsapp_message_id TEXT UNIQUE,
          delivery_status TEXT,
          delivery_error TEXT
        );
      `);
      await client.query(migrationSql);

      const update = {
        wamid: "wamid-durable-status-1",
        status: "delivered",
        errorCode: null,
        errorTitle: null,
        errorMessage: null,
      };
      const first = await repo.storeBatch([update], query);
      assert.equal(first.length, 1);
      assert.equal(first[0].processing_status, "pending");
      assert.equal(first[0].attempts, 0);

      const duplicate = await repo.storeBatch([update], query);
      assert.deepEqual(duplicate, []);
      const count = await client.query(
        "SELECT COUNT(*)::int AS count FROM whatsapp_delivery_status_jobs"
      );
      assert.equal(count.rows[0].count, 1);

      const claimed = await repo.claimByIds([first[0].id], query);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].processing_status, "processing");
      assert.equal(claimed[0].attempts, 1);

      await repo.markFailed(claimed[0].id, new Error("temporary database failure"), query);
      const retry = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(retry.length, 1);
      assert.equal(retry[0].id, claimed[0].id);
      assert.equal(retry[0].attempts, 2);

      await repo.markCompleted(retry[0].id, query);
      const none = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(none, []);

      const staleStored = await repo.storeBatch([
        { wamid: "wamid-durable-status-stale", status: "read" },
      ], query);
      const staleClaim = await repo.claimByIds([staleStored[0].id], query);
      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET claimed_at = NOW() - interval '2 minutes'
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      const staleRecovered = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(staleRecovered.length, 1);
      assert.equal(staleRecovered[0].id, staleClaim[0].id);
      assert.equal(staleRecovered[0].attempts, 2);

      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET attempts = 5,
             processing_status = 'processing',
             claimed_at = NOW() - interval '2 minutes',
             last_error = 'simulated final-attempt crash'
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      const exhausted = await repo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(exhausted.length, 1);
      assert.equal(exhausted[0].id, staleClaim[0].id);

      const terminal = await repo.markTerminal(staleClaim[0].id, query);
      assert.ok(terminal.terminal_at);
      const noLongerExhausted = await repo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(noLongerExhausted, []);

      await client.query(
        `INSERT INTO contacts (id) VALUES (42);
         INSERT INTO messages (contact_id, whatsapp_message_id, delivery_status, delivery_error)
         VALUES (42, 'wamid-find-me', 'failed', 'provider failure')`
      );
      const message = await repo.findMessageByWamid("wamid-find-me", query);
      assert.equal(message.contact_id, 42);
      assert.equal(message.delivery_status, "failed");

      const attention = await repo.setDeliveryAttentionState(
        42,
        "Delivery failed: provider failure",
        query
      );
      assert.equal(attention.id, 42);
      const attentionRow = await client.query(
        "SELECT needs_attention, attention_reason FROM contacts WHERE id = 42"
      );
      assert.deepEqual(attentionRow.rows[0], {
        needs_attention: true,
        attention_reason: "Delivery failed: provider failure",
      });

      // A durable delivery replay must never replace a more important handoff
      // or safety reason that staff is already looking at.
      await client.query(
        `UPDATE contacts
         SET needs_attention = true, attention_reason = 'AI handoff: urgent review'
         WHERE id = 42`
      );
      const protectedAttention = await repo.setDeliveryAttentionState(
        42,
        "Delivery failed: later replay",
        query
      );
      assert.equal(protectedAttention, null);
      const protectedRow = await client.query(
        "SELECT needs_attention, attention_reason FROM contacts WHERE id = 42"
      );
      assert.deepEqual(protectedRow.rows[0], {
        needs_attention: true,
        attention_reason: "AI handoff: urgent review",
      });
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);

test("unsupported provider statuses are ignored instead of poisoning webhook persistence", () => {
  assert.equal(repo.normalizeUpdate({ wamid: "x", status: "unknown_future_status" }), null);
  assert.equal(repo.normalizeUpdate({ status: "read" }), null);
});
