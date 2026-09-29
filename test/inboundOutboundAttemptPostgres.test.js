const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "outbound reservation atomically creates one assistant row per inbound processing job",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `inbound_outbound_${process.pid}_${Date.now()}`;
    const processingSql = fs.readFileSync(
      path.join(__dirname, "../src/db/inboundProcessingSchema.sql"),
      "utf8"
    );
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/021_reliability_review_followups.sql"),
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
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
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
      await client.query(migrationSql);

      const contactResult = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const contactId = contactResult.rows[0].id;
      const incoming = {
        id: "wamid-outbound-fence-1",
        from: "60128880000",
        channel: "whatsapp",
        text: "hello",
      };

      const durable = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: "hello",
        storedMessageId: incoming.id,
        channel: "whatsapp",
        incoming,
      }, client);
      const job = await inboundProcessingRepo.claimPendingByMessageId(
        durable.savedInbound.id,
        client,
        "test-owner"
      );

      const first = await inboundProcessingRepo.reserveOutboundAttempt({
        processingJobId: job.id,
        contactId,
        content: "Hi, how can I help?",
        origin: "ai_reply",
      }, client);

      assert.equal(first.alreadyStarted, false);
      assert.equal(first.message.role, "assistant");
      assert.equal(first.message.content, "Hi, how can I help?");

      const second = await inboundProcessingRepo.reserveOutboundAttempt({
        processingJobId: job.id,
        contactId,
        content: "This must never become a second reply",
        origin: "ai_reply",
      }, client);

      assert.equal(second.alreadyStarted, true);

      const assistantCount = await client.query(
        "SELECT COUNT(*)::int AS count FROM messages WHERE contact_id = $1 AND role = 'assistant'",
        [contactId]
      );
      assert.equal(assistantCount.rows[0].count, 1);

      await inboundProcessingRepo.finalizeOutboundAttempt(
        job.id,
        {
          outcome: "accepted",
          providerMessageId: "wamid-provider-1",
        },
        client
      );
      const attempt = await inboundProcessingRepo.getOutboundAttempt(job.id, client);
      assert.equal(attempt.outcome, "accepted");
      assert.equal(attempt.provider_message_id, "wamid-provider-1");
      assert.equal(Number(attempt.assistant_message_id), Number(first.message.id));

      const ambiguousIncoming = {
        id: "wamid-outbound-fence-2",
        from: "60128880000",
        channel: "whatsapp",
        text: "second turn",
      };
      const ambiguousDurable = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: "second turn",
        storedMessageId: ambiguousIncoming.id,
        channel: "whatsapp",
        incoming: ambiguousIncoming,
      }, client);
      await inboundProcessingRepo.markCompleted(job.id, client);
      const ambiguousJob = await inboundProcessingRepo.claimPendingByMessageId(
        ambiguousDurable.savedInbound.id,
        client,
        "test-owner"
      );
      const ambiguousReservation = await inboundProcessingRepo.reserveOutboundAttempt({
        processingJobId: ambiguousJob.id,
        contactId,
        content: "Possibly sent reply",
        origin: "ai_reply",
      }, client);

      const ambiguousMessage = await inboundProcessingRepo.markOutboundAttemptAmbiguous(
        ambiguousJob.id,
        "Delivery could not be confirmed.",
        client
      );
      assert.equal(ambiguousMessage.marked, true);
      assert.equal(ambiguousMessage.message.delivery_status, "unknown");
      assert.equal(
        ambiguousMessage.message.delivery_error,
        "Delivery could not be confirmed."
      );

      const ambiguousAttempt = await inboundProcessingRepo.getOutboundAttempt(
        ambiguousJob.id,
        client
      );
      assert.equal(ambiguousAttempt.outcome, "ambiguous");
      assert.equal(
        Number(ambiguousAttempt.assistant_message_id),
        Number(ambiguousReservation.message.id)
      );

      // A late provider result must win over ambiguity classification.
      const lateIncoming = {
        id: "wamid-outbound-fence-3",
        from: "60128880000",
        channel: "whatsapp",
        text: "third turn",
      };
      await inboundProcessingRepo.markCompleted(ambiguousJob.id, client);
      const lateDurable = await inboundProcessingRepo.storeInboundClaim({
        contactId,
        content: "third turn",
        storedMessageId: lateIncoming.id,
        channel: "whatsapp",
        incoming: lateIncoming,
      }, client);
      const lateJob = await inboundProcessingRepo.claimPendingByMessageId(
        lateDurable.savedInbound.id,
        client,
        "test-owner"
      );
      const lateReservation = await inboundProcessingRepo.reserveOutboundAttempt({
        processingJobId: lateJob.id,
        contactId,
        content: "Provider accepted this",
        origin: "ai_reply",
      }, client);
      await client.query(
        `UPDATE messages
         SET whatsapp_message_id = 'wamid-late-provider', delivery_status = 'pending'
         WHERE id = $1`,
        [lateReservation.message.id]
      );

      const lateAmbiguous = await inboundProcessingRepo.markOutboundAttemptAmbiguous(
        lateJob.id,
        "Must not overwrite provider state.",
        client
      );
      assert.equal(lateAmbiguous.marked, false);
      assert.equal(lateAmbiguous.state.whatsapp_message_id, "wamid-late-provider");

      const lateMessage = await client.query(
        "SELECT delivery_status, delivery_error FROM messages WHERE id = $1",
        [lateReservation.message.id]
      );
      assert.equal(lateMessage.rows[0].delivery_status, "pending");
      assert.equal(lateMessage.rows[0].delivery_error, null);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
