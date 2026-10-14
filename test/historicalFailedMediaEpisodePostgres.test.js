"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");
const { unresolvedFailedOutboundSql } = require("../src/utils/deliveryReplyAttentionSql");

test("historical media SQL keeps explicit delivery tasks but ignores older media in new routine turns", () => {
  const sql = unresolvedFailedOutboundSql("failed", "c");
  assert.match(sql, /later_customer\.role = 'user'/);
  assert.match(sql, /later_customer\.created_at, later_customer\.id/);
  assert.match(sql, /c\.needs_attention IS TRUE/);
  assert.match(sql, /c\.attention_reason LIKE 'Delivery failed:%'/);
  assert.match(sql, /c\.delivery_attention_dismissed_at IS NULL/);
  assert.throws(() => unresolvedFailedOutboundSql("bad;drop", "c"), TypeError);
});

test("contact 433 historical failed Before & After cannot poison a new staff reply", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: false,
  });
  const schema = `historical_photo_episode_${process.pid}_${Date.now()}`;
  const originalQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer PRIMARY KEY,
        mode text NOT NULL DEFAULT 'ai',
        takeover_by text, takeover_at timestamptz,
        needs_attention boolean DEFAULT false,
        attention_reason text,
        delivery_attention_dismissed_at timestamptz,
        is_unread boolean DEFAULT false,
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE messages (
        id integer PRIMARY KEY, contact_id integer NOT NULL REFERENCES contacts(id),
        role text NOT NULL, created_at timestamptz NOT NULL,
        sent_by_username text, is_automated_follow_up boolean DEFAULT false,
        delivery_status text, whatsapp_message_id text,
        whatsapp_template jsonb, pricing_reminder_anchor_id integer,
        automated_follow_up_for_message_id integer,
        automated_follow_up_parent_message_id integer,
        media_key text, media_url text, media_base64 text, media_mime_type text
      );
      CREATE TABLE scheduled_messages(message_id integer);
      CREATE TABLE ai_review_items (
        id serial PRIMARY KEY, contact_id integer,
        inbound_message_id integer, summary text, status text,
        created_at timestamptz DEFAULT now()
      );

      INSERT INTO contacts (id,mode,needs_attention,is_unread)
      VALUES (433,'ai',false,true);
      INSERT INTO messages (id,contact_id,role,created_at)
      VALUES (1486,433,'user',now()-interval '3 hours');
      INSERT INTO messages (id,contact_id,role,created_at,delivery_status,media_url)
      VALUES (1488,433,'assistant',now()-interval '2 hours',
              'failed','https://example.invalid/failed-before-after.jpg');
      -- A newer customer turn makes the old failure historical.
      INSERT INTO messages (id,contact_id,role,created_at)
      VALUES (1502,433,'user',now()-interval '1 hour');
    `);

    pool.query = client.query.bind(client);

    const draftSnapshot = (await client.query(
      "SELECT * FROM contacts WHERE id=433"
    )).rows[0];
    const afterDraft = await contacts.clearStaffAssistStateIfUnchanged(draftSnapshot);
    assert.equal(afterDraft.needs_attention, false,
      "an old failed image cannot be promoted into a fresh delivery alarm");
    assert.equal(afterDraft.is_unread, false);

    await client.query(`
      UPDATE contacts SET mode='human',takeover_by='staff',
        needs_attention=true,
        attention_reason='New message — conversation is staff-owned.'
      WHERE id=433;
      INSERT INTO messages (id,contact_id,role,created_at,delivery_status,sent_by_username)
      VALUES (1508,433,'assistant',now()-interval '59 minutes','pending','staff');
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(433), null,
      "a locally saved draft is not proof the newer customer was answered");

    await client.query(`
      UPDATE messages SET whatsapp_message_id='wamid.staff1508',
        delivery_status='read' WHERE id=1508;
    `);
    const cleared = await contacts.clearDeliveryAttentionIfNoFailedMessages(433);
    assert.equal(cleared.needs_attention, false,
      "accepted direct staff reply resolves routine waiting despite historical photo");
    assert.equal(cleared.attention_reason, null);
    assert.equal(cleared.delivery_attention_dismissed_at, null,
      "replying to a newer turn does not falsely assert that staff dismissed the photo");
    assert.equal((await client.query(
      "SELECT delivery_status FROM messages WHERE id=1488"
    )).rows[0].delivery_status, "failed",
    "the earlier failed-image audit must remain unchanged");

    // An explicitly open delivery-failure reason is NOT a routine waiting
    // flag: even after a newer inbound, the outstanding image stays protected.
    await client.query(`
      UPDATE contacts SET needs_attention=true,
        attention_reason='Delivery failed: Before & After image still needs review'
      WHERE id=433;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(433), null,
      "staff must explicitly resolve an open historical delivery warning");
    const openFailure = (await client.query(
      "SELECT needs_attention,attention_reason FROM contacts WHERE id=433"
    )).rows[0];
    assert.equal(openFailure.needs_attention, true);
    assert.match(openFailure.attention_reason, /^Delivery failed:/);

    // A genuinely new failed image in the current customer episode cannot
    // be hidden by a later accepted text response.
    await client.query(`
      INSERT INTO messages (id,contact_id,role,created_at)
      VALUES (1510,433,'user',now()+interval '1 minute');
      INSERT INTO messages (id,contact_id,role,created_at,delivery_status,media_url)
      VALUES (1511,433,'assistant',now()+interval '2 minutes','failed',
              'https://example.invalid/new-failed-photo.jpg');
      INSERT INTO messages (id,contact_id,role,created_at,delivery_status,
                            whatsapp_message_id,sent_by_username)
      VALUES (1512,433,'assistant',now()+interval '3 minutes','read',
              'wamid.staff1512','staff');
      UPDATE contacts SET needs_attention=true,
        attention_reason='New message — conversation is staff-owned.'
      WHERE id=433;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(433), null,
      "new failed media in the latest customer episode remains actionable");
    await client.query(`
      UPDATE messages SET delivery_status='read',
        whatsapp_message_id='wamid.retried1511' WHERE id=1511;
    `);
    const recovered = await contacts.clearDeliveryAttentionIfNoFailedMessages(433);
    assert.equal(recovered.needs_attention, false,
      "successful retry of the current image permits routine attention cleanup");

    // A pending clinical question always outranks a valid staff response.
    await client.query(`
      INSERT INTO ai_review_items
        (contact_id,inbound_message_id,summary,status)
      VALUES (433,1510,'Clinical review still pending','pending');
      UPDATE contacts SET needs_attention=true,
        attention_reason='New message — conversation is staff-owned.'
      WHERE id=433;
    `);
    const reviewPending = await contacts.clearDeliveryAttentionIfNoFailedMessages(433);
    assert.equal(reviewPending.needs_attention, true);
    assert.match(reviewPending.attention_reason, /^AI review requested:/);
  } finally {
    pool.query = originalQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
