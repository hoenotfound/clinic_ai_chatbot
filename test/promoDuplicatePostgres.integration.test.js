const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const {
  wasPromoRecentlySentWithExecutor,
} = require("../src/db/messagesRepo");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test(
  "promo duplicate suppression works against PostgreSQL delivery rows",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `promo_dedupe_it_${process.pid}_${Date.now()}`;
    const client = new Client({
      connectionString: TEST_DATABASE_URL,
      ssl: false,
    });

    await client.connect();
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`
    );

    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`)
        .catch(() => {});
      await client.end().catch(() => {});
    });

    await client.query(`
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        media_url TEXT,
        whatsapp_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivery_status TEXT
      )
    `);

    const imageUrl = "https://example.test/3d.jpg";

    assert.equal(
      await wasPromoRecentlySentWithExecutor(client, 42, imageUrl, 24),
      false
    );

    await client.query(
      `INSERT INTO messages (
         contact_id, role, media_url, whatsapp_message_id, delivery_status
       ) VALUES ($1, 'assistant', $2, 'provider-accepted', 'pending')`,
      [42, imageUrl]
    );

    assert.equal(
      await wasPromoRecentlySentWithExecutor(client, 42, imageUrl, 24),
      true
    );

    await client.query("TRUNCATE messages RESTART IDENTITY");
    await client.query(
      `INSERT INTO messages (
         contact_id, role, media_url, whatsapp_message_id, delivery_status
       ) VALUES
         (42, 'assistant', $1, 'provider-failed', 'failed'),
         (42, 'assistant', $1, NULL, NULL),
         (42, 'user', $1, 'provider-user', 'pending'),
         (99, 'assistant', $1, 'provider-other-contact', 'pending'),
         (42, 'assistant', $1, 'provider-old', 'pending')`,
      [imageUrl]
    );
    await client.query(
      "UPDATE messages SET created_at = NOW() - INTERVAL '25 hours' WHERE whatsapp_message_id = 'provider-old'"
    );

    assert.equal(
      await wasPromoRecentlySentWithExecutor(client, 42, imageUrl, 24),
      false
    );
  }
);
