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
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
