const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "scheduled-message schema is compatible with the existing messages table",
  { skip: !connectionString },
  async () => {
    const repoSource = fs.readFileSync(
      path.join(__dirname, "../src/db/scheduledMessageRepo.js"),
      "utf8"
    );
    const schemaMatch = repoSource.match(
      /schemaPromise = pool\.query\(`([\s\S]*?)`\)\.catch/
    );
    assert.ok(schemaMatch, "Could not locate scheduled-message schema SQL");

    const client = new Client({ connectionString });
    const schemaName = `scheduled_messages_${process.pid}_${Date.now()}`;

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
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(schemaMatch[1]);

      const columnType = await client.query(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'scheduled_messages'
           AND column_name = 'message_id'`,
        [schemaName]
      );
      assert.equal(columnType.rows[0]?.data_type, "integer");

      const contact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      await client.query(
        "INSERT INTO messages (contact_id, role) VALUES ($1, 'user')",
        [contact.rows[0].id]
      );

      const latestInbound = await client.query(
        `SELECT created_at
         FROM messages
         WHERE contact_id = $1 AND role = 'user'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [contact.rows[0].id]
      );
      assert.equal(latestInbound.rowCount, 1);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
