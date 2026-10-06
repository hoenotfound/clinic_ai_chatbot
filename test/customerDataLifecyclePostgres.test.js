const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const lifecycleRepo = require("../src/db/customerDataLifecycleRepo");
const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");
const metaCommentAutomationRepo = require("../src/db/metaCommentAutomationRepo");

const connectionString = process.env.TEST_DATABASE_URL;
const migration040Sql = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/040_customer_data_lifecycle.sql"),
  "utf8"
);
const migration042Sql = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/042_customer_data_referral_replay_guard.sql"),
  "utf8"
);

async function createLifecycleSchema(client) {
  await client.query(`
    CREATE TABLE contacts (
      id SERIAL PRIMARY KEY,
      whatsapp_number TEXT UNIQUE NOT NULL,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      channel_user_id TEXT,
      mode TEXT NOT NULL DEFAULT 'ai',
      needs_attention BOOLEAN NOT NULL DEFAULT false,
      needs_follow_up BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE messages (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      whatsapp_message_id TEXT,
      media_key TEXT,
      automated_follow_up_for_message_id INTEGER REFERENCES messages(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE leads (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      is_closed BOOLEAN NOT NULL DEFAULT false,
      next_follow_up_at TIMESTAMPTZ,
      appointment_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE contact_notes (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE scheduled_messages (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );

    CREATE TABLE inbound_processing_jobs (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      terminal_at TIMESTAMPTZ
    );

    CREATE TABLE whatsapp_outbound_retries (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );

    CREATE TABLE follow_up_ai_generation_claims (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE pending_lead_attributions (
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      PRIMARY KEY (channel, external_user_id)
    );

    CREATE TABLE meta_comment_automation_jobs (
      id BIGSERIAL PRIMARY KEY,
      channel TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_text TEXT NOT NULL,
      post_id TEXT,
      media_id TEXT,
      parent_comment_id TEXT,
      source_created_at TIMESTAMPTZ,
      raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      public_reply_id TEXT,
      private_reply_message_id TEXT,
      private_reply_recipient_id TEXT,
      private_reply_pending_text TEXT,
      private_reply_pending_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (channel, comment_id)
    );
  `);
  await client.query(migration040Sql);
  await client.query(migration042Sql);
}

test(
  "customer purge deletes the database graph atomically and leaves durable R2 cleanup work",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `customer_purge_${process.pid}_${Date.now()}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await createLifecycleSchema(client);

      const contact = await client.query(
        `INSERT INTO contacts (
           whatsapp_number, channel, channel_user_id, created_at, updated_at
         )
         VALUES ('social-1', 'facebook', 'psid-1', NOW() - INTERVAL '100 days', NOW() - INTERVAL '100 days')
         RETURNING id`
      );
      const contactId = contact.rows[0].id;

      const parent = await client.query(
        `INSERT INTO messages (
           contact_id, role, content, whatsapp_message_id, media_key, created_at
         )
         VALUES (
           $1, 'user', 'hello', 'facebook:mid-deleted-1',
           'clients/demo/messages/1/photo.jpg', NOW() - INTERVAL '100 days'
         )
         RETURNING id`,
        [contactId]
      );
      await client.query(
        `INSERT INTO messages (
           contact_id, role, content, automated_follow_up_for_message_id, created_at
         )
         VALUES ($1, 'assistant', 'follow up', $2, NOW() - INTERVAL '99 days')`,
        [contactId, parent.rows[0].id]
      );
      await client.query(
        `INSERT INTO leads (contact_id, updated_at)
         VALUES ($1, NOW() - INTERVAL '99 days')`,
        [contactId]
      );
      await client.query(
        `INSERT INTO contact_notes (contact_id, content, created_at)
         VALUES ($1, 'private note', NOW() - INTERVAL '99 days')`,
        [contactId]
      );
      await client.query(
        `INSERT INTO pending_lead_attributions (channel, external_user_id, event_id)
         VALUES ('facebook', 'psid-1', 'facebook:referral:deleted-event-1')`
      );
      await client.query(
        `INSERT INTO meta_comment_automation_jobs (
           channel, comment_id, author_id, private_reply_recipient_id
         )
         VALUES ('facebook', 'comment-deleted-1', 'psid-1', 'psid-1')`
      );

      const result = await lifecycleRepo.purgeContactData({
        contactId,
        reason: "manual",
        requestedBy: "admin",
        mediaPrefixes: [`clients/demo/messages/${contactId}/`],
      }, client);

      assert.equal(result.status, "purged");
      assert.deepEqual(result.deletedCounts, {
        messages: 2,
        leads: 1,
        notes: 1,
        pendingAttributions: 1,
        commentJobs: 1,
        providerMessageTombstones: 1,
        providerReferralTombstones: 1,
        providerCommentTombstones: 1,
      });

      for (const table of ["contacts", "messages", "leads", "contact_notes"]) {
        const rows = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        assert.equal(rows.rows[0].count, 0, table);
      }
      assert.equal(
        (await client.query("SELECT COUNT(*)::int AS count FROM pending_lead_attributions")).rows[0].count,
        0
      );
      assert.equal(
        (await client.query("SELECT COUNT(*)::int AS count FROM meta_comment_automation_jobs")).rows[0].count,
        0
      );

      const job = await client.query(
        "SELECT * FROM customer_data_purge_jobs WHERE contact_id = $1",
        [contactId]
      );
      assert.equal(job.rows.length, 1);
      assert.equal(job.rows[0].status, "pending");
      assert.deepEqual(job.rows[0].media_keys, ["clients/demo/messages/1/photo.jpg"]);
      assert.deepEqual(job.rows[0].media_prefixes, [`clients/demo/messages/${contactId}/`]);

      const tombstones = await client.query(
        "SELECT provider_message_id FROM customer_data_deleted_message_ids"
      );
      assert.deepEqual(
        tombstones.rows.map((row) => row.provider_message_id).sort(),
        [
          "facebook:mid-deleted-1",
          "facebook:referral:deleted-event-1",
        ].sort()
      );

      const commentTombstones = await client.query(
        "SELECT channel, comment_id FROM customer_data_deleted_comment_ids"
      );
      assert.deepEqual(commentTombstones.rows, [{
        channel: "facebook",
        comment_id: "comment-deleted-1",
      }]);

      assert.equal(
        await inboundProcessingRepo.isDeletedProviderMessageId(
          "facebook:mid-deleted-1",
          client
        ),
        true
      );
      assert.equal(
        await inboundProcessingRepo.isDeletedProviderMessageId(
          "facebook:referral:deleted-event-1",
          client
        ),
        true
      );
      const replayedComment = await metaCommentAutomationRepo.storeIncomingComment({
        channel: "facebook",
        commentId: "comment-deleted-1",
        entryId: "page-1",
        authorId: "psid-1",
        authorName: "Deleted Customer",
        text: "old retry",
        postId: "post-1",
        mediaId: null,
        parentCommentId: null,
        createdAt: new Date().toISOString(),
        rawEvent: {},
      }, client);
      assert.equal(replayedComment, null);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);

test(
  "retention only selects inactive contacts without scheduled or in-flight customer work",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `customer_retention_${process.pid}_${Date.now()}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await createLifecycleSchema(client);

      const old = await client.query(
        `INSERT INTO contacts (whatsapp_number, created_at, updated_at)
         VALUES ('old-1', NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days')
         RETURNING id`
      );
      const activeWork = await client.query(
        `INSERT INTO contacts (whatsapp_number, created_at, updated_at)
         VALUES ('old-2', NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days')
         RETURNING id`
      );

      await client.query(
        `INSERT INTO scheduled_messages (contact_id, status)
         VALUES ($1, 'scheduled')`,
        [activeWork.rows[0].id]
      );

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const candidates = await lifecycleRepo.listRetentionCandidates({
        cutoff,
        database: client,
      });
      assert.deepEqual(candidates.map((row) => Number(row.id)), [old.rows[0].id]);

      const skipped = await lifecycleRepo.purgeContactData({
        contactId: activeWork.rows[0].id,
        reason: "retention",
        requestedBy: "Retention policy",
        retentionCutoff: cutoff,
      }, client);
      assert.equal(skipped.status, "ineligible");

      await client.query(
        "UPDATE scheduled_messages SET status = 'cancelled' WHERE contact_id = $1",
        [activeWork.rows[0].id]
      );
      const purged = await lifecycleRepo.purgeContactData({
        contactId: activeWork.rows[0].id,
        reason: "retention",
        requestedBy: "Retention policy",
        retentionCutoff: cutoff,
      }, client);
      assert.equal(purged.status, "purged");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
