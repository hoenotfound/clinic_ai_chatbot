const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const {
  findWaitingStaffOwnedConversations,
} = require("../src/services/staffWaitingAlertService");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "Staff Waiting emits once per unanswered episode and resets after a real staff reply",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `staff_waiting_episode_${process.pid}_${Date.now()}`;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'ai',
          needs_attention BOOLEAN NOT NULL DEFAULT false
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL,
          sent_by_username TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          delivery_status TEXT,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE telegram_immediate_alerts (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          alert_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );

        INSERT INTO contacts (id, mode, needs_attention)
        VALUES (12, 'human', false);

        INSERT INTO messages (
          id, contact_id, role, sent_by_username,
          is_automated_follow_up, delivery_status, created_at
        ) VALUES
          (45, 12, 'user', NULL, false, NULL, now() - interval '40 minutes'),
          (46, 12, 'user', NULL, false, NULL, now() - interval '20 minutes');

        INSERT INTO telegram_immediate_alerts (
          id, contact_id, alert_type, status, created_at
        ) VALUES (
          80, 12, 'staff_waiting', 'sent', now() - interval '30 minutes'
        );
      `);

      // A second customer bubble is still part of the same unanswered episode.
      // The already-sent reminder suppresses another candidate.
      const sameEpisode = await findWaitingStaffOwnedConversations(
        { waitMinutes: 10, limit: 10 },
        client.query.bind(client)
      );
      assert.deepEqual(sameEpisode, []);

      await client.query(`
        INSERT INTO messages (
          id, contact_id, role, sent_by_username,
          is_automated_follow_up, delivery_status, created_at
        ) VALUES
          (47, 12, 'assistant', 'staff-a', false, 'delivered', now() - interval '15 minutes'),
          (48, 12, 'user', NULL, false, NULL, now() - interval '12 minutes');
      `);

      // The staff reply closes the old episode. A later unanswered customer
      // message can therefore become a fresh Staff Waiting reminder.
      const nextEpisode = await findWaitingStaffOwnedConversations(
        { waitMinutes: 10, limit: 10 },
        client.query.bind(client)
      );
      assert.equal(nextEpisode.length, 1);
      assert.equal(nextEpisode[0].contact_id, 12);
      assert.equal(nextEpisode[0].waiting_since_message_id, 48);
      assert.ok(Number(nextEpisode[0].waiting_minutes) >= 10);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
