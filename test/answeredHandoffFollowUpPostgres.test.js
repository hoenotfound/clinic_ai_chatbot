const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");
const followUps = require("../src/db/followUpRepo");
const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

test("Postgres resumes an answered staff-handoff cycle without bypassing review or reply windows", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `handoff_followup_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer PRIMARY KEY, channel text NOT NULL, whatsapp_number text,
        channel_user_id text, mode text NOT NULL DEFAULT 'ai',
        takeover_by text, takeover_at timestamptz,
        needs_attention boolean NOT NULL DEFAULT false, attention_reason text,
        is_unread boolean DEFAULT false, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE messages (
        id integer PRIMARY KEY, contact_id integer NOT NULL REFERENCES contacts(id),
        role text NOT NULL, content text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), sent_by_username text,
        delivery_status text, whatsapp_message_id text,
        is_automated_follow_up boolean NOT NULL DEFAULT false,
        automated_follow_up_for_message_id integer, automated_follow_up_step integer
      );
      CREATE TABLE ai_review_items (
        id bigserial PRIMARY KEY, contact_id integer, inbound_message_id integer,
        summary text, category text, status text, created_at timestamptz DEFAULT now(),
        resolved_at timestamptz
      );
      CREATE TABLE pipeline_stages (
        id integer PRIMARY KEY, stage_type text, system_key text
      );
      CREATE TABLE leads (
        id integer PRIMARY KEY, contact_id integer NOT NULL REFERENCES contacts(id),
        stage_id integer, treatment_interest text, is_closed boolean DEFAULT false,
        appointment_status text, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE outbound_message_evidence (
        message_id integer PRIMARY KEY, contact_id integer, channel text, origin text,
        accepted boolean NOT NULL
      );
      CREATE TABLE follow_up_ai_decisions (
        id bigserial PRIMARY KEY, contact_id integer,
        trigger_message_id integer, follow_up_step integer, action text,
        reason text, topic text
      );
      INSERT INTO contacts (
        id, channel, whatsapp_number, mode, takeover_by, takeover_at,
        needs_attention, attention_reason
      ) VALUES (
        330, 'whatsapp', '60122253333', 'human', 'staff',
        now() - interval '3 hours 5 minutes',
        true, 'AI handed off this conversation.'
      );
      INSERT INTO messages (id,contact_id,role,content,created_at,sent_by_username,delivery_status)
      VALUES
        (1100,330,'user','Can I arrange a visit?',now() - interval '5 hours',NULL,NULL),
        (1101,330,'assistant','Let me check',now() - interval '4 hours',NULL,'read'),
        (1102,330,'assistant','You can arrange a trial appointment',
          now() - interval '3 hours','staff','read');
      UPDATE messages SET whatsapp_message_id='wamid.staff.1102' WHERE id=1102;
      INSERT INTO follow_up_ai_decisions
        (contact_id, trigger_message_id, follow_up_step, action, reason)
      VALUES (330,1101,1,'skip','Cancelled because clinic staff took over');
    `);
    pool.query = client.query.bind(client);

    const settings = {
      delayMinutes: [120, 360, 1200],
      triggerMode: "all",
      activatedAt: new Date(Date.now() - 48 * 3600000).toISOString(),
      limit: 25,
    };
    const candidateIds = async () =>
      (await followUps.findCandidates(settings)).map((row) => row.trigger_message_id);
    assert.deepEqual(await candidateIds(), [],
      "an actual staff-owned chat must not generate follow-ups");

    const restored = await contacts.returnToAi(330);
    assert.equal(restored.mode, "ai");
    assert.equal(restored.needs_attention, false);
    assert.deepEqual(await candidateIds(), [1102],
      "FU1 should qualify from the confirmed staff response, not the cancelled AI anchor");

    // Simulate a legacy AI-owned contact with an unresolved handoff flag.
    // Without a reliable original handoff boundary it must fail closed until
    // staff explicitly reviews and dismisses the attention warning.
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason='AI handed off this conversation.' WHERE id=330`);
    assert.deepEqual(await candidateIds(), [],
      "AI mode alone is not permission to ignore unresolved attention");
    const dismissed = await contacts.dismissAttentionAndReviews(330);
    assert.equal(dismissed.needs_attention, false);
    assert.deepEqual(await candidateIds(), [1102]);

    // Pending clinical reviews must stop the sequence independently of the
    // single contact-level attention flag, including after it gets cleared.
    await client.query(`INSERT INTO ai_review_items
      (contact_id,inbound_message_id,summary,category,status)
      VALUES (330,1100,'Need a treatment suitability review','clinical','pending')`);
    await client.query(`UPDATE contacts SET needs_attention=false,
      attention_reason=NULL WHERE id=330`);
    assert.deepEqual(await candidateIds(), []);
    const decision = await client.query(`SELECT ${followUpAttentionAllowedSql("c")}
      AS allowed FROM contacts c WHERE id=330`);
    assert.equal(decision.rows[0].allowed,false);
    await client.query(`UPDATE ai_review_items SET status='resolved' WHERE contact_id=330`);
    assert.deepEqual(await candidateIds(), [1102]);

    // A full 24-hour expiry still blocks normal free-form follow-ups. Any
    // extended template follows its separate consent and billing checks.
    await client.query(`UPDATE messages SET created_at=now() - interval '25 hours'
      WHERE id=1100`);
    assert.deepEqual(await candidateIds(), []);
  } finally {
    pool.query = oldQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
