"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const { recordQuarantinedWhatsAppChanges } = require("../src/db/whatsappSenderQuarantineRepo");
const { partitionLegacyWhatsAppWebhook } = require("../src/services/whatsappLegacySenderBoundary");

const connectionString = process.env.TEST_DATABASE_URL;

async function isolatedSchema(fn) {
  const db = new Client({ connectionString });
  const schema = `sender_foundation_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    const pool = {
      async connect() {
        const client = new Client({ connectionString });
        await client.connect();
        await client.query(`SET search_path TO ${schema}`);
        return { query: (...args) => client.query(...args), release: () => client.end() };
      },
    };
    await fn({ db, pool });
  } finally {
    await db.query("SET search_path TO public").catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await db.end();
  }
}

test("migration 078 preserves a seeded production-sized legacy Inbox and is repeatable",
  { skip: !connectionString }, async () => {
    await isolatedSchema(async ({ db, pool }) => {
      const migrations = loadMigrations();
      assert.equal(migrations.at(-1).version, 78);
      await runMigrations(pool, { quiet: true, migrations: migrations.filter(m => m.version < 78) });
      const contacts = await db.query(`
        INSERT INTO contacts (whatsapp_number)
        SELECT '6018' || LPAD(n::text, 7, '0')
        FROM generate_series(1, 183) AS n
        RETURNING id, whatsapp_number`);
      assert.equal(contacts.rowCount, 183);
      const msgs = await db.query(`
        INSERT INTO messages (contact_id, role, content)
        SELECT c.id,
               CASE WHEN gs.n % 3 = 0 THEN 'assistant' ELSE 'user' END,
               'legacy-message-' || gs.n::text
        FROM generate_series(1, 2184) AS gs(n)
        JOIN LATERAL (
          SELECT id FROM contacts ORDER BY id OFFSET ((gs.n - 1) % 183) LIMIT 1
        ) AS c ON TRUE
        RETURNING id`);
      assert.equal(msgs.rowCount, 2184);
      const before = await db.query(`
        SELECT
          (SELECT COUNT(*)::integer FROM contacts) AS contacts,
          (SELECT COUNT(*)::integer FROM messages) AS messages,
          (SELECT md5(string_agg(id::text || ':' || whatsapp_number, ',' ORDER BY id))
             FROM contacts) AS contact_fingerprint,
          (SELECT md5(string_agg(id::text || ':' || contact_id || ':' || content,
                                  ',' ORDER BY id))
             FROM messages) AS message_fingerprint`);
      const apply = await runMigrations(pool, { quiet: true });
      assert.equal(apply.appliedCount, 1);
      assert.equal(apply.currentVersion, 78);
      const after = await db.query(`
        SELECT
          (SELECT COUNT(*)::integer FROM contacts) AS contacts,
          (SELECT COUNT(*)::integer FROM messages) AS messages,
          (SELECT md5(string_agg(id::text || ':' || whatsapp_number, ',' ORDER BY id))
             FROM contacts) AS contact_fingerprint,
          (SELECT md5(string_agg(id::text || ':' || contact_id || ':' || content,
                                  ',' ORDER BY id))
             FROM messages) AS message_fingerprint`);
      assert.deepEqual(after.rows[0], before.rows[0]);

      const newColumns = await db.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'whatsapp_sender_id'
        ORDER BY table_name`);
      assert.deepEqual(newColumns.rows, [
        { table_name: "contacts", column_name: "whatsapp_sender_id" },
        { table_name: "messages", column_name: "whatsapp_sender_id" },
      ]);
      const unique = await db.query(`
        SELECT to_regclass('contacts_whatsapp_number_key')::text AS contact_unique,
               to_regclass('idx_contacts_channel_user_id')::text AS channel_unique,
               to_regclass('whatsapp_sender_quarantined_events')::text AS quarantine_table`);
      assert.ok(unique.rows[0].contact_unique);
      assert.ok(unique.rows[0].channel_unique);
      assert.ok(unique.rows[0].quarantine_table);
      const repeat = await runMigrations(pool, { quiet: true });
      assert.equal(repeat.appliedCount, 0);
    });
  }
);

test("foreign WhatsApp events are durably quarantined without contact creation and dedupe on replay",
  { skip: !connectionString }, async () => {
    await isolatedSchema(async ({ db, pool }) => {
      await runMigrations(pool, { quiet: true });
      const webhook = {
        object: "whatsapp_business_account",
        entry: [{ id: "200000000000002", changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "100000000000002" },
            messages: [{ id: "wamid.ariel", from: "60135550000",
              type: "text", text: { body: "a private patient message" } }],
          },
        }] }],
      };
      const isolate = partitionLegacyWhatsAppWebhook(webhook, {
        expectedPhoneNumberId: "100000000000001",
      });
      assert.equal(isolate.acceptedBody.entry.length, 0);
      assert.equal(isolate.quarantined.length, 1);
      await recordQuarantinedWhatsAppChanges(isolate.quarantined, db);
      await recordQuarantinedWhatsAppChanges(isolate.quarantined, db);
      const rows = await db.query(
        "SELECT fingerprint, seen_count, meta_phone_number_id, event_field FROM whatsapp_sender_quarantined_events"
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(Number(rows.rows[0].seen_count), 2);
      assert.equal(rows.rows[0].event_field, "messages");
      assert.equal(rows.rows[0].meta_phone_number_id, "100000000000002");
      const contacts = await db.query("SELECT COUNT(*)::integer AS n FROM contacts");
      assert.equal(contacts.rows[0].n, 0);
      const rawAudit = await db.query(
        "SELECT row_to_json(t)::text AS data FROM whatsapp_sender_quarantined_events t"
      );
      assert.equal(rawAudit.rows[0].data.includes("a private patient message"), false);
      assert.equal(rawAudit.rows[0].data.includes("60135550000"), false);
    });
  }
);
