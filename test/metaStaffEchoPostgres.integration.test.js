const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const messagesRepo = require("../src/db/messagesRepo");
const metaStaffEchoRepo = require("../src/db/metaStaffEchoRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "Meta staff echo persistence dedupes multipart outbound ids and preserves ownership rules",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName =
      `meta_staff_echo_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

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
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          reply_to_provider_message_id TEXT,
          is_forwarded BOOLEAN NOT NULL DEFAULT false
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

      const migrationSql = fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "src",
          "db",
          "migrations",
          "018_social_provider_message_ids.sql"
        ),
        "utf8"
      );
      await client.query(migrationSql);

      const contactInsert = await client.query(
        "INSERT INTO contacts (needs_attention, is_unread) VALUES (true, true) RETURNING id"
      );
      const contactId = contactInsert.rows[0].id;

      const outboundInsert = await client.query(
        `INSERT INTO messages (contact_id, role, content)
         VALUES ($1, 'assistant', 'Promo caption and image')
         RETURNING id`,
        [contactId]
      );
      const outboundMessageId = outboundInsert.rows[0].id;

      await messagesRepo.registerSocialProviderMessageAlias(
        outboundMessageId,
        "instagram:ig-caption-1",
        client
      );
      await messagesRepo.registerSocialProviderMessageAlias(
        outboundMessageId,
        "instagram:ig-image-1",
        client
      );

      const aliasLookup = await messagesRepo.getMessageByAnyProviderIdForContact(
        contactId,
        "instagram:ig-caption-1",
        client
      );
      assert.equal(aliasLookup.id, outboundMessageId);

      const ownCaptionEcho = await metaStaffEchoRepo.persistStaffEchoIfNew(
        contactId,
        "Promo caption and image",
        "instagram:ig-caption-1",
        "Instagram",
        "AI handoff",
        client
      );
      assert.equal(ownCaptionEcho.isNew, false);
      assert.equal(ownCaptionEcho.isOutbound, true);
      assert.equal(ownCaptionEcho.message.id, outboundMessageId);

      const afterOwnEcho = await client.query(
        `SELECT mode, takeover_by,
                (SELECT COUNT(*)::int FROM messages WHERE contact_id = $1) AS message_count
         FROM contacts
         WHERE id = $1`,
        [contactId]
      );
      assert.deepEqual(afterOwnEcho.rows[0], {
        mode: "ai",
        takeover_by: null,
        message_count: 1,
      });

      const manual = await metaStaffEchoRepo.persistStaffEchoIfNew(
        contactId,
        "Manual Instagram reply",
        "instagram:ig-manual-1",
        "Instagram",
        "AI handoff",
        client
      );
      assert.equal(manual.isNew, true);
      assert.equal(manual.contact.mode, "ai");
      assert.equal(manual.contact.takeover_by, null);
      assert.equal(manual.contact.needs_attention, false);
      assert.equal(manual.contact.is_unread, false);

      await client.query(
        `UPDATE contacts
         SET mode = 'ai', takeover_by = NULL, takeover_at = NULL
         WHERE id = $1`,
        [contactId]
      );
      const duplicate = await metaStaffEchoRepo.persistStaffEchoIfNew(
        contactId,
        "Manual Instagram reply",
        "instagram:ig-manual-1",
        "Instagram",
        "AI handoff",
        client
      );
      assert.equal(duplicate.isNew, false);

      const afterDuplicate = await client.query(
        "SELECT mode, takeover_by FROM contacts WHERE id = $1",
        [contactId]
      );
      assert.deepEqual(afterDuplicate.rows[0], {
        mode: "ai",
        takeover_by: null,
      });

      await client.query(
        `UPDATE contacts
         SET mode = 'human', takeover_by = 'caden', takeover_at = NOW(),
             needs_attention = true, is_unread = true
         WHERE id = $1`,
        [contactId]
      );
      const namedOwner = await metaStaffEchoRepo.persistStaffEchoIfNew(
        contactId,
        "Reply from Facebook while portal staff owns chat",
        "facebook:fb-manual-2",
        "Facebook",
        "AI handoff",
        client
      );
      assert.equal(namedOwner.isNew, true);
      assert.equal(namedOwner.contact.takeover_by, "caden");
      assert.equal(namedOwner.contact.needs_attention, false);
      assert.equal(namedOwner.contact.is_unread, false);

      const handoffInbound = await client.query(
        `INSERT INTO messages (contact_id, role, content)
         VALUES ($1, 'user', 'Please let me speak to staff')
         RETURNING id`,
        [contactId]
      );
      const handoffAnchor = await client.query(
        `INSERT INTO messages (contact_id, role, content)
         VALUES ($1, 'assistant', 'A staff member will help you shortly.')
         RETURNING id`,
        [contactId]
      );
      await client.query(
        `UPDATE contacts
         SET mode = 'human', takeover_by = 'AI handoff', takeover_at = NOW()
         WHERE id = $1`,
        [contactId]
      );
      const syntheticOwner = await metaStaffEchoRepo.persistStaffEchoIfNew(
        contactId,
        "Claim synthetic handoff",
        "instagram:ig-manual-3",
        "Instagram",
        "AI handoff",
        client
      );
      assert.equal(syntheticOwner.isNew, true);
      assert.equal(syntheticOwner.contact.mode, "human");
      assert.equal(syntheticOwner.contact.takeover_by, "Instagram");

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
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client
        .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
        .catch(() => {});
      await client.end();
    }
  }
);
