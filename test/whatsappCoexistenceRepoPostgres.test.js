const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const coexistenceRepo = require("../src/db/whatsappCoexistenceRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "Business App echo persistence is atomic and duplicate retries do not retake ownership",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `coexistence_${process.pid}_${Date.now()}`;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
          takeover_by TEXT,
          takeover_at TIMESTAMPTZ,
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT,
          is_unread BOOLEAN NOT NULL DEFAULT false,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

        CREATE TABLE follow_up_ai_decisions (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL,
          trigger_message_id INTEGER NOT NULL,
          follow_up_step INTEGER NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          topic TEXT,
          UNIQUE (trigger_message_id, follow_up_step)
        );
      `);

      const inserted = await client.query(
        "INSERT INTO contacts (needs_attention, is_unread) VALUES (true, true) RETURNING id"
      );
      const contactId = inserted.rows[0].id;

      const first = await coexistenceRepo.persistStaffEchoIfNew(
        contactId,
        "Handled from phone",
        "wamid.business-app-1",
        "WhatsApp Business App",
        "AI handoff",
        client
      );

      assert.ok(first?.message?.id);
      assert.equal(first.isNew, true);
      assert.equal(first.message.role, "assistant");
      assert.equal(first.message.sent_by_username, "WhatsApp Business App");
      assert.equal(first.contact.mode, "ai");
      assert.equal(first.contact.takeover_by, null);
      assert.equal(first.contact.needs_attention, false);
      assert.equal(first.contact.is_unread, false);

      const duplicate = await coexistenceRepo.persistStaffEchoIfNew(
        contactId,
        "Handled from phone",
        "wamid.business-app-1",
        "WhatsApp Business App",
        "AI handoff",
        client
      );
      assert.equal(duplicate.isNew, false);
      assert.equal(duplicate.message.id, first.message.id);

      const duplicateState = await client.query(
        `SELECT mode, takeover_by,
                (SELECT COUNT(*)::int FROM messages WHERE contact_id = $1) AS message_count
         FROM contacts
         WHERE id = $1`,
        [contactId]
      );
      assert.deepEqual(duplicateState.rows[0], {
        mode: "ai",
        takeover_by: null,
        message_count: 1,
      });

      // A real portal owner must remain the owner if they also use the
      // WhatsApp Business app. The app echo resolves unread/attention state,
      // but does not replace the named staff owner with a generic label.
      await client.query(
        `UPDATE contacts
         SET mode = 'human', takeover_by = 'caden', takeover_at = NOW(),
             needs_attention = true, is_unread = true
         WHERE id = $1`,
        [contactId]
      );
      const namedOwnerEcho = await coexistenceRepo.persistStaffEchoIfNew(
        contactId,
        "Reply from phone while Caden owns chat",
        "wamid.business-app-2",
        "WhatsApp Business App",
        "AI handoff",
        client
      );
      assert.equal(namedOwnerEcho.isNew, true);
      assert.equal(namedOwnerEcho.contact.mode, "human");
      assert.equal(namedOwnerEcho.contact.takeover_by, "caden");
      assert.equal(namedOwnerEcho.contact.needs_attention, false);
      assert.equal(namedOwnerEcho.contact.is_unread, false);

      // A synthetic AI handoff is not a real staff owner. The first Business
      // App reply must claim that conversation as real human ownership and
      // durably cancel the previous AI follow-up anchor.
      // Keep these rows inside one millisecond but at distinct PostgreSQL
      // microseconds. node-postgres returns timestamptz as a JS Date, which
      // only has millisecond precision. The handoff cancellation query must
      // therefore compare against the persisted echo row inside PostgreSQL
      // instead of round-tripping its timestamp through JavaScript.
      const handoffInbound = await client.query(
        `INSERT INTO messages (contact_id, role, content, created_at)
         VALUES ($1, 'user', 'I need a person',
                 '2026-10-06T00:00:00.123100Z'::timestamptz)
         RETURNING id`,
        [contactId]
      );
      const handoffAnchor = await client.query(
        `INSERT INTO messages (contact_id, role, content, created_at)
         VALUES ($1, 'assistant', 'A staff member will help you shortly.',
                 '2026-10-06T00:00:00.123500Z'::timestamptz)
         RETURNING id`,
        [contactId]
      );
      await client.query(
        `ALTER TABLE messages ALTER COLUMN created_at
         SET DEFAULT '2026-10-06T00:00:00.123900Z'::timestamptz`
      );
      await client.query(
        `UPDATE contacts
         SET mode = 'human', takeover_by = 'AI handoff', takeover_at = NOW()
         WHERE id = $1`,
        [contactId]
      );
      const handoffEcho = await coexistenceRepo.persistStaffEchoIfNew(
        contactId,
        "Claim AI handoff from phone",
        "wamid.business-app-3",
        "WhatsApp Business App",
        "AI handoff",
        client
      );
      assert.equal(handoffEcho.isNew, true);
      assert.equal(handoffEcho.contact.mode, "human");
      assert.equal(handoffEcho.contact.takeover_by, "WhatsApp Business App");

      const cancelledSequence = await client.query(
        `SELECT action, trigger_message_id
         FROM follow_up_ai_decisions
         WHERE contact_id = $1 AND follow_up_step = 1`,
        [contactId]
      );
      assert.deepEqual(cancelledSequence.rows, [{
        action: "skip",
        trigger_message_id: handoffAnchor.rows[0].id,
      }]);
      assert.ok(handoffInbound.rows[0].id < handoffAnchor.rows[0].id);

      const state = await client.query(
        `SELECT mode, takeover_by,
                (SELECT COUNT(*)::int FROM messages WHERE contact_id = $1) AS message_count
         FROM contacts
         WHERE id = $1`,
        [contactId]
      );
      assert.deepEqual(state.rows[0], {
        mode: "human",
        takeover_by: "WhatsApp Business App",
        message_count: 5,
      });
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
