const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { pool } = require("../src/db/db");
const followUpRepo = require("../src/db/followUpRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "a delayed earlier follow-up shifts the next step instead of sending both together",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString, ssl: false });
    const schemaName = `follow_up_spacing_${process.pid}_${Date.now()}`;
    const originalQuery = pool.query;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          channel TEXT NOT NULL,
          whatsapp_number TEXT,
          channel_user_id TEXT,
          needs_attention BOOLEAN NOT NULL DEFAULT false
        );

        CREATE TABLE pipeline_stages (
          id INTEGER PRIMARY KEY,
          stage_type TEXT,
          system_key TEXT
        );

        CREATE TABLE leads (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          stage_id INTEGER REFERENCES pipeline_stages(id),
          treatment_interest TEXT,
          is_closed BOOLEAN NOT NULL DEFAULT false,
          appointment_status TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          whatsapp_message_id TEXT,
          sent_by_username TEXT,
          media_url TEXT,
          media_mime_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          automated_follow_up_for_message_id INTEGER,
          automated_follow_up_step INTEGER,
          automated_follow_up_target_service TEXT,
          automated_follow_up_targeting_recorded BOOLEAN NOT NULL DEFAULT false,
          automated_follow_up_message_mode TEXT,
          UNIQUE (automated_follow_up_for_message_id, automated_follow_up_step)
        );

        CREATE TABLE follow_up_ai_decisions (
          id BIGSERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          trigger_message_id INTEGER,
          follow_up_step INTEGER NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          topic TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (trigger_message_id, follow_up_step)
        );

        INSERT INTO contacts (
          id, channel, whatsapp_number, needs_attention
        ) VALUES (
          1, 'whatsapp', '60123456789', false
        );

        INSERT INTO messages (
          id, contact_id, role, content, created_at, is_automated_follow_up
        ) VALUES
          (
            10, 1, 'user', 'I am interested',
            now() - interval '10 hours',
            false
          ),
          (
            11, 1, 'assistant', 'Sure, here are the details',
            now() - interval '9 hours',
            false
          );

        -- Step 1 was originally due 2 hours after the anchor, but quiet hours
        -- delayed the actual send until only one hour ago.
        INSERT INTO messages (
          id,
          contact_id,
          role,
          content,
          whatsapp_message_id,
          sent_by_username,
          created_at,
          delivery_status,
          is_automated_follow_up,
          automated_follow_up_for_message_id,
          automated_follow_up_step,
          automated_follow_up_targeting_recorded
        ) VALUES (
          12,
          1,
          'assistant',
          'First follow-up',
          'wamid.step1',
          'Follow-up automation',
          now() - interval '1 hour',
          'sent',
          true,
          11,
          1,
          true
        );
      `);

      pool.query = client.query.bind(client);

      const activatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const delays = [120, 480];

      const candidates = await followUpRepo.findCandidates({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
        limit: 25,
      });
      assert.deepEqual(candidates, []);

      const dueAt = await followUpRepo.getNextCandidateDueAt({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(dueAt);
      const dueInHours =
        (new Date(dueAt).getTime() - Date.now()) / (60 * 60 * 1000);
      assert.ok(
        dueInHours > 4.9 && dueInHours < 5.1,
        `expected Step 2 about 5 hours from now, got ${dueInHours}`
      );

      const prematureClaim = await followUpRepo.saveIfStillEligible({
        contactId: 1,
        triggerMessageId: 11,
        content: "Second follow-up",
        mediaUrl: "",
        stepIndex: 2,
        delayMinutes: 480,
        previousDelayMinutes: 120,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(prematureClaim, null);

      // Once the same 6-hour Step 1 -> Step 2 gap has elapsed, Step 2 can be
      // claimed normally.
      await client.query(
        "UPDATE messages SET created_at = now() - interval '7 hours' WHERE id = 12"
      );

      const dueCandidates = await followUpRepo.findCandidates({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
        limit: 25,
      });
      assert.equal(dueCandidates.length, 1);
      assert.equal(Number(dueCandidates[0].next_follow_up_step), 2);

      const claim = await followUpRepo.saveIfStillEligible({
        contactId: 1,
        triggerMessageId: 11,
        content: "Second follow-up",
        mediaUrl: "",
        stepIndex: 2,
        delayMinutes: 480,
        previousDelayMinutes: 120,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(claim);
      assert.equal(Number(claim.automated_follow_up_step), 2);
    } finally {
      pool.query = originalQuery;
      await client.query("SET search_path TO public").catch(() => {});
      await client
        .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
        .catch(() => {});
      await client.end();
    }
  }
);
