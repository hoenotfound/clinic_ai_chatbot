const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const { recordOutcome } = require("../src/db/outboundMessageEvidenceRepo");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

async function withIsolatedSchema(fn) {
  const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  const schemaName = `outbound_evidence_it_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
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
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
      );
    `);
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "..", "src", "db", "migrations", "015_outbound_message_evidence.sql"),
      "utf8"
    );
    await client.query(migrationSql);
    await fn(client);
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await client.end();
  }
}

test(
  "accepted readiness evidence persists timestamps in PostgreSQL without parameter type conflicts",
  { skip: !TEST_DATABASE_URL },
  async () => {
    await withIsolatedSchema(async (client) => {
      const contact = await client.query("INSERT INTO contacts DEFAULT VALUES RETURNING id");
      const message = await client.query(
        "INSERT INTO messages (contact_id) VALUES ($1) RETURNING id",
        [contact.rows[0].id]
      );
      const attemptedAt = new Date("2026-09-10T09:15:00.000Z");

      const row = await recordOutcome({
        messageId: message.rows[0].id,
        contactId: contact.rows[0].id,
        channel: "whatsapp",
        origin: "ai_reply",
        accepted: true,
        providerMessageId: "wamid.integration-test",
        attemptedAt,
      }, client);

      assert.equal(row.accepted, true);
      assert.equal(row.provider_message_id, "wamid.integration-test");
      assert.equal(new Date(row.attempted_at).toISOString(), attemptedAt.toISOString());
      assert.equal(new Date(row.accepted_at).toISOString(), attemptedAt.toISOString());
    });
  }
);
