const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "social automated follow-up retries stay sent instead of re-entering crash recovery",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `followup_multichannel_${process.pid}_${Date.now()}`;
    const safetySql = fs.readFileSync(
      path.join(__dirname, "../src/db/followUpMultiChannelSchema.sql"),
      "utf8"
    );

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          channel TEXT NOT NULL
        );
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          delivery_status TEXT,
          delivery_error TEXT
        );
      `);
      await client.query(safetySql);

      const facebook = await client.query(
        "INSERT INTO contacts (channel) VALUES ('facebook') RETURNING id"
      );
      const whatsapp = await client.query(
        "INSERT INTO contacts (channel) VALUES ('whatsapp') RETURNING id"
      );

      const failedSocial = await client.query(
        `INSERT INTO messages
           (contact_id, is_automated_follow_up, delivery_status, delivery_error)
         VALUES ($1, true, 'failed', 'Meta rejected')
         RETURNING id`,
        [facebook.rows[0].id]
      );
      const retriedSocial = await client.query(
        `UPDATE messages
         SET delivery_status = NULL, delivery_error = NULL
         WHERE id = $1
         RETURNING delivery_status, delivery_error`,
        [failedSocial.rows[0].id]
      );
      assert.equal(retriedSocial.rows[0].delivery_status, "sent");
      assert.equal(retriedSocial.rows[0].delivery_error, null);

      const unknownSocial = await client.query(
        `INSERT INTO messages
           (contact_id, is_automated_follow_up, delivery_status, delivery_error)
         VALUES ($1, true, 'unknown', 'Restarted during send')
         RETURNING id`,
        [facebook.rows[0].id]
      );
      const retriedUnknown = await client.query(
        `UPDATE messages
         SET delivery_status = NULL, delivery_error = NULL
         WHERE id = $1
         RETURNING delivery_status`,
        [unknownSocial.rows[0].id]
      );
      assert.equal(retriedUnknown.rows[0].delivery_status, "sent");

      const failedWhatsapp = await client.query(
        `INSERT INTO messages
           (contact_id, is_automated_follow_up, delivery_status, delivery_error)
         VALUES ($1, true, 'failed', 'WhatsApp rejected')
         RETURNING id`,
        [whatsapp.rows[0].id]
      );
      const retriedWhatsapp = await client.query(
        `UPDATE messages
         SET delivery_status = NULL, delivery_error = NULL
         WHERE id = $1
         RETURNING delivery_status`,
        [failedWhatsapp.rows[0].id]
      );
      assert.equal(retriedWhatsapp.rows[0].delivery_status, null);

      const ordinarySocial = await client.query(
        `INSERT INTO messages
           (contact_id, is_automated_follow_up, delivery_status, delivery_error)
         VALUES ($1, false, 'failed', 'Meta rejected')
         RETURNING id`,
        [facebook.rows[0].id]
      );
      const retriedOrdinary = await client.query(
        `UPDATE messages
         SET delivery_status = NULL, delivery_error = NULL
         WHERE id = $1
         RETURNING delivery_status`,
        [ordinarySocial.rows[0].id]
      );
      assert.equal(retriedOrdinary.rows[0].delivery_status, null);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
