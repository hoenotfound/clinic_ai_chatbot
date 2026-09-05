const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");

const connectionString = process.env.TEST_DATABASE_URL;

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test(
  "observability migration records failures and stale-owner recovery without changing inbound job behavior",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `observability_${process.pid}_${Date.now()}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (id SERIAL PRIMARY KEY);
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          whatsapp_message_id TEXT UNIQUE,
          sent_by_username TEXT,
          media_url TEXT,
          media_key TEXT,
          media_mime_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false
        );
      `);
      await client.query(read("src/db/inboundProcessingSchema.sql"));
      await client.query(read("src/db/migrations/012_observability_health.sql"));

      // Keep each scenario on its own conversation. A failed predecessor on the
      // same contact is intentionally supposed to block newer work, so sharing
      // one contact here would test ordering protection instead of observability.
      const contacts = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const failureContactId = contacts.rows[0].id;
      const recoveryContact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const recoveryContactId = recoveryContact.rows[0].id;
      const ordinaryContact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const ordinaryContactId = ordinaryContact.rows[0].id;
      const failOpenContact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const failOpenContactId = failOpenContact.rows[0].id;

      const failureClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: failureContactId,
        content: "failure test",
        storedMessageId: "observability-failure-message",
        channel: "whatsapp",
        incoming: { id: "observability-failure-message", from: "60110000001", channel: "whatsapp", text: "failure test" },
      }, client);
      const failureLease = await inboundProcessingRepo.claimPendingByMessageId(
        failureClaim.savedInbound.id,
        client,
        "failure-worker"
      );
      await inboundProcessingRepo.markFailed(failureLease.id, new Error("simulated"), client);

      const failureEvents = await client.query(
        "SELECT job_type, job_id, channel FROM inbound_failure_events ORDER BY id"
      );
      assert.deepEqual(failureEvents.rows, [{
        job_type: "message",
        job_id: String(failureLease.id),
        channel: "whatsapp",
      }]);

      const recoveryClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: recoveryContactId,
        content: "recovery test",
        storedMessageId: "observability-recovery-message",
        channel: "whatsapp",
        incoming: { id: "observability-recovery-message", from: "60110000002", channel: "whatsapp", text: "recovery test" },
      }, client);
      const originalLease = await inboundProcessingRepo.claimPendingByMessageId(
        recoveryClaim.savedInbound.id,
        client,
        "old-render-process"
      );
      await client.query(
        `UPDATE inbound_processing_jobs
         SET claimed_at = NOW() - interval '4 minutes'
         WHERE id = $1`,
        [originalLease.id]
      );

      const recovered = await inboundProcessingRepo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 180,
        maxAttempts: 5,
        ownerId: "new-render-process",
      }, client);
      assert.equal(recovered.some((job) => String(job.id) === String(originalLease.id)), true);

      const recoveryEvents = await client.query(
        "SELECT job_type, job_id, channel FROM inbound_recovery_events ORDER BY id"
      );
      assert.deepEqual(recoveryEvents.rows, [{
        job_type: "message",
        job_id: String(originalLease.id),
        channel: "whatsapp",
      }]);

      const ordinaryClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: ordinaryContactId,
        content: "normal pending",
        storedMessageId: "observability-normal-message",
        channel: "whatsapp",
        incoming: { id: "observability-normal-message", from: "60110000003", channel: "whatsapp", text: "normal pending" },
      }, client);
      await inboundProcessingRepo.claimPendingByMessageId(
        ordinaryClaim.savedInbound.id,
        client,
        "new-render-process"
      );
      const recoveryCount = await client.query(
        "SELECT COUNT(*)::int AS count FROM inbound_recovery_events"
      );
      assert.equal(recoveryCount.rows[0].count, 1, "a normal pending claim must not look like a restart recovery");

      // Simulate a broken diagnostics sink. A new telemetry row will violate
      // this NOT VALID constraint, but the durable job update must still commit.
      await client.query(
        "ALTER TABLE inbound_failure_events ADD CONSTRAINT reject_future_observability CHECK (false) NOT VALID"
      );
      const failOpenClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: failOpenContactId,
        content: "fail-open test",
        storedMessageId: "observability-fail-open-message",
        channel: "whatsapp",
        incoming: { id: "observability-fail-open-message", from: "60110000004", channel: "whatsapp", text: "fail-open test" },
      }, client);
      const failOpenLease = await inboundProcessingRepo.claimPendingByMessageId(
        failOpenClaim.savedInbound.id,
        client,
        "fail-open-worker"
      );
      const failedDespiteTelemetry = await inboundProcessingRepo.markFailed(
        failOpenLease.id,
        new Error("diagnostics must not block this"),
        client
      );
      assert.equal(failedDespiteTelemetry.status, "failed");
      const durableState = await client.query(
        "SELECT status FROM inbound_processing_jobs WHERE id = $1",
        [failOpenLease.id]
      );
      assert.equal(durableState.rows[0].status, "failed");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);