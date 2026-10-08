const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const repo = require("../src/db/whatsappDeliveryStatusRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "WhatsApp delivery-status jobs dedupe, fence stale leases and persist terminal state",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `wa_delivery_status_${process.pid}_${Date.now()}`;
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/014_whatsapp_delivery_status_jobs.sql"),
      "utf8"
    );
    const integrityMigrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/045_whatsapp_unmatched_delivery_monitoring.sql"),
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
        CREATE TABLE outbound_message_evidence (
          message_id INTEGER,
          provider_message_id TEXT
        );
      `);
      await client.query(migrationSql);
      await client.query(integrityMigrationSql);

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
      assert.equal(first[0].lease_token, null);

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
      assert.match(claimed[0].lease_token, /^[a-f0-9]{32}$/);

      await repo.markFailed(
        claimed[0].id,
        claimed[0].lease_token,
        new Error("temporary database failure"),
        query
      );
      const retry = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(retry.length, 1);
      assert.equal(retry[0].id, claimed[0].id);
      assert.equal(retry[0].attempts, 2);
      assert.match(retry[0].lease_token, /^[a-f0-9]{32}$/);
      assert.notEqual(retry[0].lease_token, claimed[0].lease_token);

      await repo.markCompleted(retry[0].id, retry[0].lease_token, query);
      const none = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(none, []);

      // A stale worker that wakes up after another process completed this job
      // must not be able to roll the terminal state backward.
      assert.equal(
        await repo.markFailed(
          retry[0].id,
          claimed[0].lease_token,
          new Error("late stale-worker failure"),
          query
        ),
        null
      );
      assert.equal(await repo.markTerminal(retry[0].id, query), null);
      const completedRow = await client.query(
        "SELECT processing_status, lease_token, terminal_at FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [retry[0].id]
      );
      assert.deepEqual(completedRow.rows[0], {
        processing_status: "completed",
        lease_token: null,
        terminal_at: null,
      });

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
      assert.notEqual(staleRecovered[0].lease_token, staleClaim[0].lease_token);

      // The replaced worker is still alive in this simulation. Its old lease
      // must not be able to fail or complete the newer worker's active claim.
      assert.equal(
        await repo.markFailed(
          staleClaim[0].id,
          staleClaim[0].lease_token,
          new Error("old worker resumed late"),
          query
        ),
        null
      );
      assert.equal(
        await repo.markCompleted(
          staleClaim[0].id,
          staleClaim[0].lease_token,
          query
        ),
        null
      );
      const replacementLease = await client.query(
        `SELECT processing_status, attempts, lease_token
         FROM whatsapp_delivery_status_jobs
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      assert.deepEqual(replacementLease.rows[0], {
        processing_status: "processing",
        attempts: 2,
        lease_token: staleRecovered[0].lease_token,
      });

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
      assert.equal(terminal.lease_token, null);
      const noLongerExhausted = await repo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(noLongerExhausted, []);
      assert.equal(
        await repo.markCompleted(
          staleClaim[0].id,
          staleRecovered[0].lease_token,
          query
        ),
        null
      );

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

      // Exact replays should be no-ops so they do not keep bumping contact
      // timestamps or emitting unnecessary realtime refreshes.
      assert.equal(
        await repo.setDeliveryAttentionState(
          42,
          "Delivery failed: provider failure",
          query
        ),
        null
      );

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

      // A completed provider failure can lose its matching message later.
      // Flag it once after a grace period, but exclude known message/evidence
      // records and preserve the flagged row through ordinary pruning.
      const failureCases = await repo.storeBatch([
        { wamid: "wamid-orphaned", status: "failed", errorCode: "131053" },
        { wamid: "wamid-linked", status: "failed", errorCode: "131053" },
        { wamid: "wamid-evidence", status: "failed", errorCode: "131053" },
        { wamid: "wamid-recent", status: "failed", errorCode: "131053" }
      ], query);
      for (const item of failureCases) {
        const rows = await repo.claimByIds([item.id], query);
        await repo.markCompleted(item.id, rows[0].lease_token, query);
      }
      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET completed_at = NOW() - interval '10 minutes'
         WHERE wamid IN ('wamid-orphaned','wamid-linked','wamid-evidence')`
      );
      await client.query(
        "INSERT INTO messages (contact_id, whatsapp_message_id) VALUES (42, 'wamid-linked')"
      );
      await client.query(
        "INSERT INTO outbound_message_evidence (provider_message_id) VALUES ('wamid-evidence')"
      );
      const flagged = await repo.flagUnmatchedCompletedFailures(
        { graceSeconds: 300, limit: 25 }, query
      );
      assert.deepEqual(flagged.map((row) => row.id), [failureCases[0].id]);
      assert.deepEqual(await repo.flagUnmatchedCompletedFailures(
        { graceSeconds: 300, limit: 25 }, query
      ), []);
      const persisted = await client.query(
        "SELECT unmatched_detected_at FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [failureCases[0].id]
      );
      assert.ok(persisted.rows[0].unmatched_detected_at);
      await repo.pruneCompleted({ olderThanHours: 0 }, query);
      const retained = await client.query(
        "SELECT id FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [failureCases[0].id]
      );
      assert.equal(retained.rowCount, 1);
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
