const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");

test("PostgreSQL Inbox Unreplied requires provider evidence and Staff Assist preserves Booking Ready", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `inbox_reply_attention_${process.pid}_${Date.now()}`;
  const originalQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer PRIMARY KEY, whatsapp_number text, name text,
        whatsapp_profile_name text, channel text DEFAULT 'whatsapp',
        channel_user_id text, photo_url text, mode text DEFAULT 'ai',
        takeover_by text, takeover_at timestamptz,
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
        needs_attention boolean DEFAULT false, attention_reason text,
        delivery_attention_dismissed_at timestamptz,
        delivery_attention_message_id integer,
        is_unread boolean DEFAULT false, needs_follow_up boolean DEFAULT false,
        whatsapp_opt_in_at timestamptz, whatsapp_opt_in_source text,
        whatsapp_opt_out_at timestamptz, whatsapp_opt_out_source text,
        whatsapp_marketing_opt_out_at timestamptz,
        whatsapp_marketing_opt_out_source text
      );
      CREATE TABLE messages (
        id integer PRIMARY KEY, contact_id integer REFERENCES contacts(id),
        role text, content text, media_url text,
        created_at timestamptz DEFAULT now(), source_created_at timestamptz,
        whatsapp_message_id text, delivery_status text,
        is_automated_follow_up boolean DEFAULT false,
        whatsapp_template jsonb, pricing_reminder_anchor_id integer,
        automated_follow_up_for_message_id integer,
        automated_follow_up_parent_message_id integer,
        media_key text,media_base64 text,media_mime_type text
      );
      CREATE TABLE scheduled_messages(message_id integer);
      CREATE TABLE ai_review_items (
        id serial PRIMARY KEY, contact_id integer,
        inbound_message_id integer, summary text, category text,
        status text, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE leads (
        id integer PRIMARY KEY, contact_id integer, owner_username text,
        temperature text, is_closed boolean DEFAULT false,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE users (username text PRIMARY KEY, display_name text);
      INSERT INTO contacts (id, whatsapp_number)
      SELECT id, '6012000' || id::text FROM generate_series(1,10) AS id;
      INSERT INTO messages (id, contact_id, role, content, created_at)
      SELECT id, id, 'user', 'Any update?', now()-interval '1 hour'
      FROM generate_series(1,10) AS id;
      -- Tests cover unsubmitted, failed, accepted pending and accepted
      -- NULL-status provider echoes. A local saved "sent" without a
      -- provider ID still is not evidence the customer received a reply.
      INSERT INTO messages
        (id, contact_id, role, content, created_at, delivery_status, whatsapp_message_id)
      VALUES
        (101,1,'assistant','Saved draft',now()-interval '50 minutes',NULL,NULL),
        (102,2,'assistant','Queued draft',now()-interval '50 minutes','pending',NULL),
        (103,3,'assistant','Unknown send',now()-interval '50 minutes','unknown','wamid.103'),
        (104,4,'assistant','Accepted pending',now()-interval '50 minutes','pending','wamid.104'),
        (105,5,'assistant','Delivered reply',now()-interval '50 minutes','sent','wamid.105'),
        (106,6,'assistant','Business App echo',now()-interval '50 minutes',NULL,'wamid.106'),
        (107,7,'assistant','Delivery failed',now()-interval '50 minutes','failed','wamid.107'),
        (108,8,'assistant','Accepted earlier',now()-interval '50 minutes','read','wamid.108'),
        (109,9,'assistant','Legacy no provider ID',now()-interval '50 minutes','sent',NULL);
      INSERT INTO messages
        (id, contact_id, role, content, created_at, delivery_status)
      VALUES (118,8,'assistant','Later unconfirmed draft',now()-interval '40 minutes','pending');
    `);
    pool.query = client.query.bind(client);
    const conversations = await contactsRepo.listConversations();
    const byId = new Map(conversations.map(row => [Number(row.contact_id), row]));
    const unreplied = [1,2,3,7,9,10];
    const replied = [4,5,6,8];
    for (const id of unreplied) {
      assert.equal(byId.get(id)?.has_unreplied, true,
        `Contact ${id} must remain in Unreplied`);
    }
    for (const id of replied) {
      assert.equal(byId.get(id)?.has_unreplied, false,
        `Contact ${id} has a Meta-accepted reply`);
    }

    // Booking-ready state remains staff-visible even after a staff-authored
    // message is saved; unread state still clears for normal Inbox UX.
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason='Booking ready: staff should confirm availability.',
      is_unread=true WHERE id=10`);
    const booking = (await client.query('SELECT * FROM contacts WHERE id=10')).rows[0];
    const afterBookingAssist = await contactsRepo.clearStaffAssistStateIfUnchanged(booking);
    assert.equal(afterBookingAssist.needs_attention, true);
    assert.equal(afterBookingAssist.attention_reason,
      'Booking ready: staff should confirm availability.');
    assert.equal(afterBookingAssist.is_unread, false);

    // An unrelated historical failure must not replace the unresolved
    // appointment reminder when a staff member sends a new message.
    // The failed outbound row stays available for Inbox delivery review.
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,delivery_status)
      VALUES (210,10,'assistant','Older failed photo',now()-interval '3 hours','failed')`);
    await client.query("UPDATE contacts SET is_unread=true WHERE id=10");
    let bookingSnapshot = (await client.query(
      "SELECT * FROM contacts WHERE id=10"
    )).rows[0];
    const bookingWithOldFailure = await contactsRepo.clearStaffAssistStateIfUnchanged(
      bookingSnapshot
    );
    assert.equal(bookingWithOldFailure.needs_attention,true);
    assert.equal(bookingWithOldFailure.attention_reason,
      "Booking ready: staff should confirm availability.");
    assert.equal(bookingWithOldFailure.is_unread,false);
    assert.equal((await client.query(
      "SELECT delivery_status FROM messages WHERE id=210"
    )).rows[0].delivery_status, "failed",
    "do not conceal or rewrite the failed message's delivery evidence");

    // Unknown delivery also stays independently visible without erasing the
    // booking reason. A concurrent clinical review remains pending as well.
    await client.query("UPDATE messages SET delivery_status='unknown' WHERE id=210");
    await client.query(`INSERT INTO ai_review_items
      (contact_id,inbound_message_id,summary,category,status)
      VALUES (10,10,'Staff must assess treatment safety','clinical','pending')`);
    await client.query("UPDATE contacts SET is_unread=true WHERE id=10");
    bookingSnapshot = (await client.query(
      "SELECT * FROM contacts WHERE id=10"
    )).rows[0];
    const bookingWithUnknownAndClinical = await contactsRepo.clearStaffAssistStateIfUnchanged(
      bookingSnapshot
    );
    assert.equal(bookingWithUnknownAndClinical.needs_attention,true);
    assert.equal(bookingWithUnknownAndClinical.attention_reason,
      "Booking ready: staff should confirm availability.");
    assert.equal(bookingWithUnknownAndClinical.is_unread,false);
    assert.equal((await client.query(
      "SELECT COUNT(*)::int AS n FROM ai_review_items WHERE contact_id=10 AND status='pending'"
    )).rows[0].n, 1, "the pending clinical review must not be auto-resolved");

    // Existing delivery-error priority remains intact for all non-booking
    // reasons, even when the failure predates the latest inbound message.
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,delivery_status)
      VALUES (211,7,'assistant','Old unknown reply',now()-interval '3 hours','unknown')`);
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason='Needs review',is_unread=true WHERE id=7`);
    const ordinaryWithFailure = (await client.query(
      "SELECT * FROM contacts WHERE id=7"
    )).rows[0];
    const failedPriority = await contactsRepo.clearStaffAssistStateIfUnchanged(
      ordinaryWithFailure
    );
    assert.equal(failedPriority.needs_attention,true);
    assert.equal(failedPriority.attention_reason,
      "Delivery failed: One or more outbound messages need staff review.");
    assert.equal(failedPriority.is_unread,false);

    // Keep prior behavior for routine manual-review cleanup, independently
    // of the new persistent booking-ready category.
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason='Needs review',is_unread=true WHERE id=9`);
    const ordinary = (await client.query('SELECT * FROM contacts WHERE id=9')).rows[0];
    const cleared = await contactsRepo.clearStaffAssistStateIfUnchanged(ordinary);
    assert.equal(cleared.needs_attention, false);
    assert.equal(cleared.attention_reason, null);
    assert.equal(cleared.is_unread, false);

    // Pending per-message clinical reviews stay pending under Staff Assist.
    await client.query(`INSERT INTO ai_review_items
      (contact_id,inbound_message_id,summary,category,status)
      VALUES (2,2,'Clinical suitability question','clinical','pending')`);
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason='AI review requested: clinical question',
      is_unread=true WHERE id=2`);
    const clinical = (await client.query('SELECT * FROM contacts WHERE id=2')).rows[0];
    const afterClinical = await contactsRepo.clearStaffAssistStateIfUnchanged(clinical);
    assert.equal(afterClinical.needs_attention, true);
    assert.match(afterClinical.attention_reason, /AI review requested/);

    // Genuine human-owned handoffs must keep their existing protection.
    await client.query(`UPDATE contacts SET mode='human',needs_attention=true,
      attention_reason='AI handed off this conversation.',is_unread=true WHERE id=3`);
    const handoff = (await client.query('SELECT * FROM contacts WHERE id=3')).rows[0];
    assert.equal(await contactsRepo.clearStaffAssistStateIfUnchanged(handoff), null);

    // A newer state change wins against an obsolete staff cleanup snapshot.
    const obsolete = (await client.query('SELECT * FROM contacts WHERE id=4')).rows[0];
    await client.query(`UPDATE contacts SET updated_at=now()+interval '1 minute'
      WHERE id=4`);
    assert.equal(await contactsRepo.clearStaffAssistStateIfUnchanged(obsolete), null);
  } finally {
    pool.query = originalQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
