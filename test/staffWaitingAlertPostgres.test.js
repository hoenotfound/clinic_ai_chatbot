const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const {
  findWaitingStaffOwnedConversations,
  findStaffWaitingAndNextDue,
  findNextStaffWaitingDueAt,
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
      const idle=await findStaffWaitingAndNextDue({},client.query.bind(client));
      assert.deepEqual(idle,{candidates:[],nextDueAt:null});

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
      // Add 2,000 unrelated chats, a genuinely waiting contact not yet due,
      // and already-alerted historical staff episodes.
      await client.query(`
        INSERT INTO contacts(id,mode,needs_attention)
        SELECT i,CASE WHEN i<1500 THEN 'ai' ELSE 'human' END,false
        FROM generate_series(1000,2999) i;
        INSERT INTO messages(id,contact_id,role,created_at)
        SELECT 10000+i,i,'user',now()-interval '2 days'
        FROM generate_series(1000,2999) i;
        INSERT INTO telegram_immediate_alerts(id,contact_id,alert_type,status,created_at)
        SELECT 20000+i,i,'staff_waiting','sent',now()-interval '1 day'
        FROM generate_series(1500,2999) i;
        INSERT INTO contacts(id,mode) VALUES(3001,'human');
        INSERT INTO messages(id,contact_id,role,created_at)
        VALUES(13001,3001,'user',now()-interval '2 minutes');
        CREATE INDEX ON messages(contact_id,created_at DESC,id DESC);
        CREATE INDEX ON telegram_immediate_alerts(contact_id,alert_type,status,created_at);
        ANALYZE contacts;
        ANALYZE messages;
        ANALYZE telegram_immediate_alerts;
      `);
      const options={waitMinutes:10,limit:10};
      const query=client.query.bind(client);
      const comparable=rows=>rows.map(row=>({...row,waiting_since:new Date(row.waiting_since).toISOString()}));
      await client.query("BEGIN");
      try{
        const legacy=await findWaitingStaffOwnedConversations(options,query);
        const due=await findNextStaffWaitingDueAt(options,query);
        const combined=await findStaffWaitingAndNextDue(options,query);
        assert.deepEqual(comparable(combined.candidates),comparable(legacy));
        assert.equal(Date.parse(combined.nextDueAt),Date.parse(due));
        assert.equal(legacy.length,1);
        // Compare real PostgreSQL plans, not timing-based assertions.
        const plans={};
        for(const [label,fn] of [["oldCandidates",findWaitingStaffOwnedConversations],
          ["oldDeadline",findNextStaffWaitingDueAt],["combined",findStaffWaitingAndNextDue]]){
          await fn(options,async(sql,bindings)=>{
            const result=await query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sql,bindings);
            const plan=result.rows[0]["QUERY PLAN"][0];
            plans[label]={ms:plan["Execution Time"],blocks:plan.Plan["Shared Hit Blocks"]+plan.Plan["Shared Read Blocks"]};
            return query(sql,bindings);
          });
        }
        console.log("staff waiting synthetic benchmark",JSON.stringify(plans));
        // When nothing is due, the next future deadline still survives.
        await client.query("INSERT INTO telegram_immediate_alerts(id,contact_id,alert_type,status,created_at) VALUES(81,12,'staff_waiting','sent',now())");
        const future=await findStaffWaitingAndNextDue(options,query);
        assert.deepEqual(future.candidates,[]);
        assert.equal(Date.parse(future.nextDueAt),Date.parse(await findNextStaffWaitingDueAt(options,query)));
        assert.ok(Date.parse(future.nextDueAt)>Date.now());
      }finally{await client.query("ROLLBACK");}

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
      // A separately failed video must not turn a successfully delivered AI
      // answer into a fake 12-hour staff-waiting episode (Cassey #9063).
      await client.query(`
        INSERT INTO contacts(id,mode,needs_attention,attention_reason) VALUES
        (72,'ai',true,'Delivery failed: Signed Meta failure left a secondary WhatsApp billing hold.'),
        (73,'ai',true,'Delivery failed: Meta delivery was rejected.');
        INSERT INTO messages(id,contact_id,role,sent_by_username,is_automated_follow_up,delivery_status,created_at) VALUES
        (251,72,'user',NULL,false,NULL,now()-interval '20 minutes'),
        (252,72,'assistant',NULL,false,'delivered',now()-interval '19 minutes'),
        (253,72,'assistant',NULL,true,'failed',now()-interval '2 minutes'),
        (261,73,'user',NULL,false,NULL,now()-interval '20 minutes'),
        (262,73,'assistant',NULL,false,'failed',now()-interval '19 minutes');
      `);
      assert.equal(await isStillWaitingForStaff(72,251,query),false,
        "delivery-only attention must not count an already answered chat");
      assert.equal(await shouldSendImmediateAlert({
        contact_id:72,event_key:"staff_waiting:72:251",alert_type:"staff_waiting",
      },query),false);
      assert.equal(await isStillWaitingForStaff(73,261,query),true,
        "an actual unanswered customer remains eligible for staff attention");
      const afterMediaFailure=await findWaitingStaffOwnedConversations(
        {waitMinutes:10,limit:40},query);
      assert.equal(afterMediaFailure.some(x=>Number(x.contact_id)===72),false);
      assert.equal(afterMediaFailure.some(x=>Number(x.contact_id)===73),true);
      // A *new* customer question after the earlier delivered AI answer
      // remains actionable when no new confirmed AI answer exists.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,sent_by_username,is_automated_follow_up,delivery_status,created_at)
        VALUES(254,72,'user',NULL,false,NULL,now()-interval '12 minutes')
      `);
      assert.equal(await isStillWaitingForStaff(72,254,query),true);
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
