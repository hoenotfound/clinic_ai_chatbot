const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const retryRepo = require("../src/db/whatsappOutboundRetryRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "WhatsApp retry repository executes migration 039 and preserves retry state transitions",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `whatsapp_retry_${process.pid}_${Date.now()}`;
    const migrationSql = fs.readFileSync(
      path.join(
        __dirname,
        "../src/db/migrations/039_whatsapp_transient_outbound_retry.sql"
      ),
      "utf8"
    );

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          whatsapp_number TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'whatsapp',
          mode TEXT NOT NULL DEFAULT 'ai',
          needs_attention BOOLEAN NOT NULL DEFAULT false
        );

        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          whatsapp_message_id TEXT,
          sent_by_username TEXT,
          media_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivery_status TEXT,
          delivery_error TEXT
        );

        CREATE TABLE inbound_outbound_attempts (
          processing_job_id BIGINT PRIMARY KEY,
          inbound_message_id INTEGER,
          assistant_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          origin TEXT NOT NULL,
          outcome TEXT,
          provider_message_id TEXT,
          error_text TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finalized_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(migrationSql);

      const contact = (
        await client.query(
          `INSERT INTO contacts (whatsapp_number)
           VALUES ('60123456789')
           RETURNING id`
        )
      ).rows[0];

      const message = (
        await client.query(
          `INSERT INTO messages (
             contact_id, role, content, delivery_status, delivery_error
           )
           VALUES ($1, 'assistant', 'Hello', 'failed', 'Meta busy')
           RETURNING id`,
          [contact.id]
        )
      ).rows[0];

      await client.query(
        `INSERT INTO inbound_outbound_attempts (
           processing_job_id,
           assistant_message_id,
           contact_id,
           origin,
           outcome,
           error_text
         )
         VALUES (1, $1, $2, 'ai_reply', 'rejected', 'Meta busy')`,
        [message.id, contact.id]
      );

      const queued = await retryRepo.enqueueTextRetry(
        {
          messageId: message.id,
          contactId: contact.id,
          recipient: "60123456789",
          origin: "ai_reply",
          delaySeconds: 0,
          errorText: "Meta busy",
          providerStatus: 500,
          providerErrorCode: 131000,
        },
        client
      );
      assert.equal(queued.status, "scheduled");
      assert.equal(queued.attempts, 0);

      const [firstClaim] = await retryRepo.claimDue({ limit: 1 }, client);
      assert.equal(firstClaim.claimed_from_status, "scheduled");
      assert.equal(firstClaim.processing_kind, "send_pending");
      assert.equal(firstClaim.attempts, 1);

      const eligible = await retryRepo.checkSendEligibility(
        {
          id: firstClaim.id,
          leaseToken: firstClaim.lease_token,
          messageId: message.id,
          contactId: contact.id,
        },
        client
      );
      assert.equal(eligible.contact_mode, "ai");
      assert.equal(eligible.has_newer_customer_message, false);
      assert.equal(eligible.has_newer_staff_message, false);

      const started = await retryRepo.markSendStarted(
        firstClaim.id,
        firstClaim.lease_token,
        client
      );
      assert.equal(started.processing_kind, "send_started");

      await retryRepo.reschedule(
        firstClaim.id,
        firstClaim.lease_token,
        {
          delaySeconds: 0,
          errorText: "Meta still busy",
          providerStatus: 500,
          providerErrorCode: 131000,
        },
        client
      );

      const [secondClaim] = await retryRepo.claimDue({ limit: 1 }, client);
      assert.equal(secondClaim.attempts, 2);

      await retryRepo.markSent(
        secondClaim.id,
        secondClaim.lease_token,
        client
      );

      await client.query(
        `UPDATE messages
         SET whatsapp_message_id = 'wamid-old',
             delivery_status = 'failed',
             delivery_error = 'async failure'
         WHERE id = $1`,
        [message.id]
      );

      const requeued = await retryRepo.enqueueDeliveryFailureRetry(
        {
          messageId: message.id,
          contactId: contact.id,
          delaySeconds: 0,
          errorText: "async failure",
          providerErrorCode: 131000,
          maxAttempts: 3,
        },
        client
      );

      assert.equal(requeued.status, "scheduled");
      assert.equal(requeued.attempts, 2);
      assert.equal(requeued.completed_at, null);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
