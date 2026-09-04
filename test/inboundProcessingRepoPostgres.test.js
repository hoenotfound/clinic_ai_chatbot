const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "message + processing job are atomic, deduplicated and restart-recoverable",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `inbound_processing_${process.pid}_${Date.now()}`;
    const processingSql = fs.readFileSync(
      path.join(__dirname, "../src/db/inboundProcessingSchema.sql"),
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
      await client.query(processingSql);

      const contact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const contactId = contact.rows[0].id;
      const incoming = {
        id: "wamid-durable-1",
        from: "60123456789",
        channel: "whatsapp",
        text: "hello",
        mediaType: null,
        unsupportedType: null,
      };

      const first = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: "hello",
        storedMessageId: incoming.id,
        channel: "whatsapp",
        incoming,
      }, client);

      assert.ok(first?.savedInbound?.id);
      assert.ok(first?.processingJob?.id);
      assert.equal(first.processingJob.status, "pending");
      assert.equal(first.processingJob.incoming_payload.id, incoming.id);

      const duplicate = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: "hello again",
        storedMessageId: incoming.id,
        channel: "whatsapp",
        incoming,
      }, client);
      assert.equal(duplicate, null);

      const counts = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM messages) AS messages,
          (SELECT COUNT(*)::int FROM inbound_processing_jobs) AS jobs
      `);
      assert.deepEqual(counts.rows[0], { messages: 1, jobs: 1 });

      await inboundProcessingRepo.markPrepared(
        first.savedInbound.id,
        true,
        client
      );
      const claimed = await inboundProcessingRepo.claimPendingByMessageId(
        first.savedInbound.id,
        client
      );
      assert.equal(claimed.status, "processing");
      assert.equal(claimed.attempts, 1);

      // Simulate a Render process dying while this job is in-flight. The next
      // server must be able to reclaim it after the stale-processing grace.
      await client.query(
        `UPDATE inbound_processing_jobs
         SET claimed_at = NOW() - interval '2 minutes'
         WHERE id = $1`,
        [claimed.id]
      );

      const recovered = await inboundProcessingRepo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, client);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].id, claimed.id);
      assert.equal(recovered[0].attempts, 2);
      assert.equal(recovered[0].status, "processing");

      const context = await inboundProcessingRepo.getJobContext(
        claimed.id,
        client
      );
      assert.equal(context.savedInbound.id, first.savedInbound.id);
      assert.equal(context.job.incoming_payload.text, "hello");
      assert.equal(context.job.was_first_message, true);
      assert.equal(context.derivedFirstMessage, true);

      await inboundProcessingRepo.markCompleted(claimed.id, client);
      const nothingLeft = await inboundProcessingRepo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, client);
      assert.deepEqual(nothingLeft, []);

      // Worst-case restart: the process dies immediately after leasing the
      // fifth/final attempt. The job is no longer retryable, but it must remain
      // discoverable so the recovery worker can hand it to staff.
      const exhaustedIncoming = {
        ...incoming,
        id: "wamid-durable-exhausted",
        text: "please help",
      };
      const exhaustedClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: exhaustedIncoming.text,
        storedMessageId: exhaustedIncoming.id,
        channel: "whatsapp",
        incoming: exhaustedIncoming,
      }, client);
      const exhaustedLease = await inboundProcessingRepo.claimPendingByMessageId(
        exhaustedClaim.savedInbound.id,
        client
      );
      await client.query(
        `UPDATE inbound_processing_jobs
         SET attempts = 5,
             status = 'processing',
             claimed_at = NOW() - interval '2 minutes',
             last_error = 'simulated final-attempt crash'
         WHERE id = $1`,
        [exhaustedLease.id]
      );

      const exhausted = await inboundProcessingRepo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, client);
      assert.equal(exhausted.length, 1);
      assert.equal(exhausted[0].id, exhaustedLease.id);
      assert.equal(exhausted[0].attempts, 5);
      assert.equal(exhausted[0].terminal_at, null);

      const terminal = await inboundProcessingRepo.markTerminal(
        exhaustedLease.id,
        client
      );
      assert.equal(terminal.status, "failed");
      assert.ok(terminal.terminal_at);
      assert.equal(terminal.last_error, "simulated final-attempt crash");

      const noLongerUnsurfaced = await inboundProcessingRepo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, client);
      assert.deepEqual(noLongerUnsurfaced, []);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
