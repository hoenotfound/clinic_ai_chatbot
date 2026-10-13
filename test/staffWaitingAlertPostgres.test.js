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
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT
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

        CREATE TABLE contact_notes (
          id BIGSERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          author TEXT NOT NULL,
          content TEXT NOT NULL,
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

test(
  "Postgres: old AI-answered and historical CRM flags never cause restart Telegram alerts",
  { skip: !connectionString },
  async () => {
    const { isStillWaitingForStaff } = require("../src/services/staffWaitingAlertService");
    const { shouldSendImmediateAlert } = require("../src/services/telegramImmediateAlertService");
    const client = new Client({ connectionString });
    const schemaName = `staff_waiting_old_${process.pid}_${Date.now()}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'ai',
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT
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
        CREATE TABLE contact_notes (
          id BIGSERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          author TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE telegram_immediate_alerts (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          alert_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO contacts(id,mode,needs_attention,attention_reason) VALUES
          (58, 'ai', true, 'Historical CRM appointment missing date: staff verification required.'),
          (59, 'ai', true, 'Staff follow-up required'),
          (60, 'ai', true, 'Staff follow-up required'),
          (61, 'human', false, NULL),
          (62, 'ai', true, 'Staff follow-up required'),
          (63, 'ai', true, 'Staff follow-up required'),
          (64, 'ai', true, 'Staff follow-up required'),
          (65, 'ai', true, 'AI review requested: awaiting extra information'),
          (66, 'ai', true, 'Historical appointment needs verification'),
          (67, 'human', false, NULL),
          (68, 'ai', true, 'Historical CRM appointment missing date'),
          (69, 'ai', true, 'Historical CRM appointment missing date'),
          (70, 'ai', true, 'Staff follow-up required'),
          (71, 'ai', true, 'Staff follow-up required');
        INSERT INTO messages(id,contact_id,role,sent_by_username,is_automated_follow_up,delivery_status,created_at) VALUES
          (111,58,'user',NULL,false,NULL,now()-interval '12 days'),
          (112,58,'assistant',NULL,false,'delivered',now()-interval '12 days'+interval '15 seconds'),
          (121,59,'user',NULL,false,NULL,now()-interval '20 minutes'),
          (122,59,'assistant',NULL,false,'read',now()-interval '19 minutes'),
          (131,60,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (141,61,'user',NULL,false,NULL,now()-interval '12 days'),
          (151,62,'user',NULL,false,NULL,now()-interval '3 days'),
          (161,63,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (162,63,'assistant',NULL,true,'delivered',now()-interval '11 minutes'),
          (171,64,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (172,64,'assistant',NULL,false,'failed',now()-interval '11 minutes'),
          (181,65,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (191,66,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (201,67,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (202,67,'assistant',NULL,false,'delivered',now()-interval '12 minutes'),
          (211,68,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (221,69,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (222,69,'assistant',NULL,false,'delivered',now()-interval '12 minutes'),
          (231,70,'user',NULL,false,NULL,now()-interval '3 days'),
          (241,71,'user',NULL,false,NULL,now()-interval '13 minutes'),
          (242,71,'assistant',NULL,false,'delivered',now()-interval '12 minutes');
        INSERT INTO contact_notes(contact_id,author,content,created_at) VALUES
          (58,'System audit','Historical booking consistency review',now()-interval '1 day'),
          (66,'System audit','Historical booking outcome review',now()-interval '2 minutes'),
          (68,'System audit','Historical booking outcome review',now()-interval '1 day'),
          (69,'System audit','Historical booking consistency review',now()-interval '1 day');
      `);
      const query = client.query.bind(client);
      const pending = await findWaitingStaffOwnedConversations(
        { waitMinutes: 10, limit: 20 }, query
      );
      assert.deepEqual(
        pending.map((row) => Number(row.contact_id)).sort((a, b) => a - b),
        [59,60,61,62,63,64,67,68,70,71],
        "staff takeover remains eligible, while an AI reply or historical review does not create an alert"
      );
      for (const [contactId, messageId, expected] of [
        [58,111,false], [59,121,true], [60,131,true], [61,141,true],
        [62,151,true], [63,161,true], [64,171,true],
        [65,181,false], [66,191,false], [67,201,true],
        [68,211,true], [69,221,false], [70,231,true], [71,241,true],
      ]) {
        assert.equal(await isStillWaitingForStaff(contactId,messageId,query), expected,
          `queue revalidation for ${contactId}`);
        assert.equal(await shouldSendImmediateAlert({
          contact_id: contactId, event_key: `staff_waiting:${contactId}:${messageId}`,
          alert_type: "staff_waiting",
        }, query), expected, `Telegram send-time guard for ${contactId}`);
      }

      // An AI acknowledgement is not a staff resolution. Actionable attention
      // remains active until staff resolves the underlying request.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,sent_by_username,is_automated_follow_up,delivery_status,created_at)
        VALUES (132,60,'assistant',NULL,false,'delivered',now()-interval '1 minute');
      `);
      assert.equal(await isStillWaitingForStaff(60,131,query),true);
      assert.equal(await shouldSendImmediateAlert({
        contact_id:60,event_key:"staff_waiting:60:131",alert_type:"staff_waiting"
      },query),true);

      // A subsequent customer message is actionable despite a prior
      // historical booking audit; a normal AI reply closes only that new
      // admin-flagged enquiry, without clearing the administrative flag.
      assert.equal(await isStillWaitingForStaff(68,211,query),true);
      assert.equal(await isStillWaitingForStaff(69,221,query),false);
      // No blanket 48-hour expiry is permitted for unresolved staff tasks.
      assert.equal(await isStillWaitingForStaff(70,231,query),true);
      // The explicit staff resolution stops future waiting alerts.
      await client.query("UPDATE contacts SET needs_attention=false WHERE id=60");
      assert.equal(await isStillWaitingForStaff(60,131,query),false);
      assert.equal(await shouldSendImmediateAlert({
        contact_id:60,event_key:"staff_waiting:60:131",alert_type:"staff_waiting"
      },query),false);

      // A genuine human takeover is resolved by an actual staff reply, not
      // by the bot's automated output.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,sent_by_username,is_automated_follow_up,delivery_status,created_at)
        VALUES (203,67,'assistant','real-staff',false,'delivered',now()-interval '1 minute');
      `);
      assert.equal(await isStillWaitingForStaff(67,201,query),false);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
