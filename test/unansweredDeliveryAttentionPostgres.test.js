"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");

test("staff takeover retains unresolved delivery attention rather than clearing it with a draft", async (t) => {
  const originalQuery = pool.query;
  t.after(() => { pool.query = originalQuery; });
  pool.query = async (sql, params) => {
    assert.match(sql, /needs_attention = c\.needs_attention OR EXISTS/);
    assert.match(sql, /WHEN c\.needs_attention THEN COALESCE\(c\.attention_reason/);
    assert.match(sql, /is_unread = false/);
    assert.deepEqual(params, ["admin", 397]);
    return { rows: [{ id: 397, mode: "human", needs_attention: true,
      attention_reason: "Delivery failed: Strict RM0 blocked response." }] };
  };
  const taken = await contacts.takeOver(397, "admin");
  assert.equal(taken.needs_attention, true);
  assert.match(taken.attention_reason, /^Delivery failed:/);
});

test("reply cleanup requires a newer Meta-accepted direct reply; old failures do not poison future episodes", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `unanswered_delivery_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer PRIMARY KEY, channel text DEFAULT 'whatsapp',
        mode text NOT NULL DEFAULT 'ai',
        takeover_by text, takeover_at timestamptz,
        needs_attention boolean DEFAULT false, attention_reason text,
        delivery_attention_dismissed_at timestamptz,
        is_unread boolean DEFAULT false, updated_at timestamptz DEFAULT now()
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
        id bigserial PRIMARY KEY, contact_id integer, inbound_message_id integer,
        summary text, status text, created_at timestamptz DEFAULT now(),
        resolved_at timestamptz
      );
      CREATE TABLE follow_up_ai_decisions (
        id bigserial PRIMARY KEY, contact_id integer, trigger_message_id integer,
        follow_up_step integer, action text, reason text, topic text,
        UNIQUE(trigger_message_id, follow_up_step)
      );
      INSERT INTO contacts(id, channel, mode, needs_attention, attention_reason, is_unread)
      VALUES (397, 'whatsapp', 'ai', true, 'Delivery failed: strict free-entry', true);
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status)
      VALUES (1531,397,'user',now()-interval '5 minutes',NULL),
             (1532,397,'assistant',now()-interval '4 minutes','failed'),
             (1543,397,'assistant',now()-interval '3 minutes','failed');
    `);
    pool.query = client.query.bind(client);
    const claimed = await contacts.takeOver(397, "admin");
    assert.equal(claimed.mode, "human");
    assert.equal(claimed.is_unread, false);
    assert.equal(claimed.needs_attention, true,
      "taking ownership does not mean staff delivered a response");
    assert.match(claimed.attention_reason, /^Delivery failed:/);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "both replies are still failed");
    assert.equal(await contacts.clearStaffAssistStateIfUnchanged(claimed), null,
      "saved staff draft must not clear an open delivery task");

    // No provider ID: even a locally pending staff draft cannot clear attention.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status)
      VALUES (1544,397,'assistant',now()-interval '2 minutes','pending');
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null);

    // The later direct staff reply was accepted by Meta (NOT proven delivered).
    await client.query(`
      UPDATE messages SET whatsapp_message_id='wamid.staff1544'
      WHERE id=1544
    `);
    const resolved = await contacts.clearDeliveryAttentionIfNoFailedMessages(397);
    assert.equal(resolved.needs_attention, false);
    assert.equal(resolved.attention_reason, null);
    const failures = await client.query(`
      SELECT id FROM messages WHERE delivery_status='failed' ORDER BY id
    `);
    assert.deepEqual(failures.rows.map((row) => row.id), [1532,1543],
      "historical send evidence must remain intact");

    // A new customer turn with a new failure is not resolved by an older reply.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status)
      VALUES (1545,397,'user',now()-interval '1 minute',NULL),
             (1546,397,'assistant',now()-interval '30 seconds','failed');
      UPDATE contacts SET mode='ai',takeover_by=NULL,takeover_at=NULL,
        needs_attention=true,attention_reason='Delivery failed: new reply rejected'
      WHERE id=397;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "the older accepted staff reply cannot resolve the newer customer turn");
    const reclaimed = await contacts.takeOver(397, "admin");
    assert.equal(reclaimed.needs_attention, true);
    assert.match(reclaimed.attention_reason, /^Delivery failed: new reply rejected/);

    // A new accepted, non-follow-up reply clears the delivery-only attention.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,is_automated_follow_up)
      VALUES (1547,397,'assistant',now(),'pending','wamid.new1547',false);
    `);
    const answered = await contacts.clearDeliveryAttentionIfNoFailedMessages(397);
    assert.equal(answered.needs_attention, false);

    // A new inbound without a failed send can still be unanswered. A late
    // cleanup callback for an older retry, or an automated follow-up, must not
    // make that new customer enquiry disappear from the staff attention list.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status)
      VALUES (1548,397,'user',now()+interval '1 second',NULL);
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,is_automated_follow_up)
      VALUES (1549,397,'assistant',now()+interval '2 seconds','pending',
              'wamid.followup1549',true);
      UPDATE contacts SET needs_attention=true,
        attention_reason='Delivery failed: latest customer still unanswered'
      WHERE id=397;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "a previous accepted reply or automated follow-up does not answer the new customer");

    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,is_automated_follow_up)
      VALUES (1550,397,'assistant',now()+interval '3 seconds','pending',
              'wamid.staff1550',false);
    `);
    assert.equal((await contacts.clearDeliveryAttentionIfNoFailedMessages(397)).needs_attention,
      false, "a newer directly accepted staff reply closes the current episode");

    // Provider echoes from the WhatsApp Business App can carry a real
    // provider ID with NULL delivery status. Inbox Unreplied treats these as
    // accepted, so the delivery-attention cleanup must use the same rule.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status)
      VALUES (1551,397,'user',now()+interval '4 seconds',NULL);
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,is_automated_follow_up)
      VALUES (1552,397,'assistant',now()+interval '5 seconds',NULL,
              'wamid.business-app1552',false);
      UPDATE contacts SET needs_attention=true,
        attention_reason='Delivery failed: previous reply'
      WHERE id=397;
    `);
    assert.equal((await contacts.clearDeliveryAttentionIfNoFailedMessages(397)).needs_attention,
      false, "a genuine provider echo may resolve delivery attention");

    // Failed media remains an actionable attachment task, even when a
    // staff member later replies with plain text. Retrying the *same*
    // failed media row and getting provider acceptance resolves that task.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES (1553,397,'user',now()+interval '6 seconds');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_mime_type,media_key)
      VALUES (1554,397,'assistant',now()+interval '7 seconds','failed','image/png','asset-failed');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,sent_by_username)
      VALUES (1555,397,'assistant',now()+interval '8 seconds','read',
              'wamid.staff1555','admin');
      UPDATE contacts SET needs_attention=true,
        attention_reason='Delivery failed: image could not be sent'
      WHERE id=397;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "a later text reply cannot silently dismiss a failed image");
    await client.query(`
      UPDATE messages SET delivery_status='read',whatsapp_message_id='wamid.retried1554'
      WHERE id=1554;
    `);
    assert.equal((await contacts.clearDeliveryAttentionIfNoFailedMessages(397)).needs_attention,
      false, "successfully retrying the failed photo resolves delivery-only attention");

    // Opening a staff-owned conversation is not enough to resolve its
    // routine waiting reason, and AI acknowledgements do not clear it.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES (1556,397,'user',now()+interval '9 seconds');
      UPDATE contacts SET mode='human', takeover_by='admin', needs_attention=true,
        attention_reason='New message — conversation is staff-owned.'
      WHERE id=397;
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,sent_by_username)
      VALUES (1557,397,'assistant',now()+interval '10 seconds','pending',
              'wamid.ai1557',NULL);
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "a prior AI acknowledgement cannot resolve staff-owned waiting");
    // Marketing and scheduled messages must not count as replies.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,sent_by_username,whatsapp_template)
      VALUES (1558,397,'assistant',now()+interval '11 seconds','pending',
              'wamid.template1558','admin','{"name":"marketing"}'::jsonb);
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,sent_by_username)
      VALUES (1559,397,'assistant',now()+interval '12 seconds','pending',
              'wamid.schedule1559','admin');
      INSERT INTO scheduled_messages(message_id) VALUES (1559);
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null,
      "marketing templates and scheduled messages do not resolve waiting");
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                           whatsapp_message_id,sent_by_username)
      VALUES (1560,397,'assistant',now()+interval '13 seconds','pending',
              'wamid.staff1560','admin');
    `);
    assert.equal((await contacts.clearDeliveryAttentionIfNoFailedMessages(397)).needs_attention,
      false, "an accepted personal staff reply resolves routine staff waiting");

    // Preserve safety/booking tasks even when a staff reply is accepted.
    await client.query(`
      UPDATE contacts SET needs_attention=true, attention_reason='Urgent clinical review'
      WHERE id=397;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null);

    // Explicit staff dismissal acknowledges historical failed media without
    // rewriting its provider delivery status. A new inbound + accepted staff
    // reply must no longer inherit that old photo warning.
    await client.query(`
      INSERT INTO contacts(id,channel,mode,needs_attention,attention_reason,is_unread)
      VALUES (398,'whatsapp','human',true,'Delivery failed: old photo',true);
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES (1601,398,'user',now()-interval '2 hours');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_key,media_mime_type)
      VALUES (1602,398,'assistant',now()-interval '90 minutes','failed','old-image','image/jpeg');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,whatsapp_message_id,
                           sent_by_username)
      VALUES (1603,398,'assistant',now()-interval '80 minutes','read','wamid.oldtext','admin');
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(398), null,
      "an undismissed failed photo remains actionable even after staff text");
    const dismissed = await contacts.dismissAttentionAndReviews(398);
    assert.equal(dismissed.needs_attention, false);
    assert.ok(dismissed.delivery_attention_dismissed_at,
      "explicit dismissal must leave a durable per-contact timestamp");
    assert.equal((await client.query(
      "SELECT delivery_status FROM messages WHERE id=1602"
    )).rows[0].delivery_status, "failed",
    "dismissal must preserve the old provider-failure audit");

    // Opening a newer customer turn can no longer resurrect dismissed media.
    await client.query(`
      UPDATE contacts SET mode='ai', needs_attention=false, is_unread=true,
        updated_at=date_trunc('milliseconds',now()) WHERE id=398;
    `);
    const newStaffSnapshot = (await client.query(
      "SELECT * FROM contacts WHERE id=398"
    )).rows[0];
    const safeAssist = await contacts.clearStaffAssistStateIfUnchanged(newStaffSnapshot);
    assert.equal(safeAssist.needs_attention, false,
      "saved staff draft cleanup cannot resurrect dismissed historical media");
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES (1604,398,'user',clock_timestamp()+interval '1 second');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,whatsapp_message_id,
                           sent_by_username)
      VALUES (1605,398,'assistant',clock_timestamp()+interval '2 seconds',
              'pending','wamid.newstaff','admin');
      UPDATE contacts SET mode='human', takeover_by='admin',
        needs_attention=true, attention_reason='New message — conversation is staff-owned.'
      WHERE id=398;
    `);
    assert.equal((await contacts.clearDeliveryAttentionIfNoFailedMessages(398)).needs_attention,
      false, "accepted manual reply clears routine waiting after historical dismissal");

    // The cutoff is not a blanket waiver. A newly failed attachment is still
    // unresolved and cannot be hidden by a subsequent accepted text.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_key,media_mime_type)
      VALUES (1606,398,'assistant',clock_timestamp()+interval '3 seconds',
              'failed','new-image','image/png');
      INSERT INTO messages(id,contact_id,role,created_at,delivery_status,whatsapp_message_id,
                           sent_by_username)
      VALUES (1607,398,'assistant',clock_timestamp()+interval '4 seconds',
              'read','wamid.freshtext','admin');
      UPDATE contacts SET needs_attention=true,
        attention_reason='Delivery failed: new photo still outstanding' WHERE id=398;
    `);
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(398), null,
      "dismissal of an older photo does not waive a newer failed image");
    const reDismissed = await contacts.dismissAttentionAndReviews(398);
    assert.equal(reDismissed.needs_attention,false);
    assert.ok(new Date(reDismissed.delivery_attention_dismissed_at) >=
      new Date(dismissed.delivery_attention_dismissed_at));
    
    // An unrelated earlier failure must never replace a booking-ready warning.
    await client.query(`
      UPDATE contacts SET needs_attention=true,
        attention_reason='Booking ready: confirm appointment' WHERE id=397;
    `);
    const booking = await contacts.takeOver(397, "admin");
    assert.equal(booking.needs_attention, true);
    assert.equal(booking.attention_reason, 'Booking ready: confirm appointment');
    assert.equal(await contacts.clearDeliveryAttentionIfNoFailedMessages(397), null);
  } finally {
    pool.query = oldQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
