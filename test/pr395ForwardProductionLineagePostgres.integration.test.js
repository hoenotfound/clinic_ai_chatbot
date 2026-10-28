"use strict";
// Strictly disposable PostgreSQL rehearsal. This file NEVER targets Neutro,
// the existing PR395 QA Neon database or an external DATABASE_URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, Pool } = require("pg");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const qaCapture = require("../src/services/whatsappSecondaryQaCapture");
const handoff = require("../src/services/whatsappSecondaryCaptureHandoff");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");

const enabled = process.env.PR395_DISPOSABLE_MIGRATION_REHEARSAL === "true";
const url = process.env.TEST_DATABASE_URL || "";
test("Neutro v079 -> isolated multi-number v106 preserves legacy chats and sender ownership", {
  skip: !enabled,
  timeout: 120000,
}, async () => {
  assert.match(url, /^postgresql:\/\/postgres:postgres@(?:127\.0\.0\.1|localhost):5432\/clinic_ai_test$/,
    "Only the disposable GitHub Actions Postgres service is permitted");
  const admin = new Client({ connectionString: url });
  const schema = "pr395_forward_" + process.pid + "_" + Date.now();
  const captureSchema = "pr395_capture_" + process.pid + "_" + Date.now();
  await admin.connect();
  try {
    await admin.query("CREATE SCHEMA " + schema);
    await admin.query("SET search_path TO " + schema);
    const pool = { connect: async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      await c.query("SET search_path TO " + schema);
      return { query: (...args) => c.query(...args), release: () => c.end() };
    }};
    const migrations = loadMigrations();
    assert.equal(migrations.length, 106);
    assert.deepEqual(migrations.slice(77, 81).map(m => [m.version, m.name]), [
      [78, "sales_follow_up_tasks"],
      [79, "sales_follow_up_corrections"],
      [80, "whatsapp_sender_foundation"],
      [81, "whatsapp_sender_conversation_identity"],
    ]);
    // Independently read from Neutro production schema_migrations on
    // 2026-10-28. Compare schema fingerprints, never customer data.
    const expectedAppliedChecksums = [
      [77, "pricing_decision_audit", "6cc9ddfc8c83493b81d18a8a60ed0754bf7875acfaecef0cf285b53a023c9ead"],
      [78, "sales_follow_up_tasks", "a1db084e690209564d1fd0a9bb0242bf8afb26cdbd72b835da7d368faa8d9bb9"],
      [79, "sales_follow_up_corrections", "70e9341c731e9f8cf17a781247285bef15c3ed5f8779e00b9074c810f72d562b"],
    ];
    assert.deepEqual(migrations.slice(76,79).map(m=>[m.version,m.name,m.checksum]),
      expectedAppliedChecksums, "source SQL must match Neutro's immutable applied migration ledger");
    const old = await runMigrations(pool, {
      quiet: true, migrations: migrations.slice(0, 79),
    });
    assert.equal(old.currentVersion, 79);
    const row = await admin.query(
      "INSERT INTO contacts(whatsapp_number, name) VALUES($1,$2) RETURNING id",
      ["60120000001","Existing Neutro contact"]
    );
    const contactId = row.rows[0].id;
    await admin.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) VALUES($1,'user',$2,$3)",
      [contactId, "Existing Neutro chat stays intact", "wamid.legacy-retained"]
    );
    // Read-only production inventory showed 233 contacts/2,985 messages,
    // including 13 Messenger contacts. Rehearse a near-identical, fully
    // synthetic load: 230 contacts, 2,936 messages and 230 lead references.
    // No real phone numbers, names, or customer text are exported.
    await admin.query(`
      INSERT INTO contacts(whatsapp_number,name,channel,channel_user_id)
      SELECT '6019' || lpad(n::text,8,'0'), 'Synthetic QA contact',
             CASE WHEN n <= 216 THEN 'whatsapp' ELSE 'facebook' END,
             CASE WHEN n > 216 THEN 'qa-fb-' || n::text ELSE NULL END
      FROM generate_series(1,229) AS n
    `);
    await admin.query(`
      INSERT INTO leads(contact_id)
      SELECT id FROM contacts
    `);
    await admin.query(`
      INSERT INTO messages(contact_id,role,content,whatsapp_message_id)
      SELECT c.id,
             CASE WHEN g.n % 2 = 0 THEN 'assistant' ELSE 'user' END,
             'Synthetic historical item ' || g.n::text,
             CASE WHEN c.channel='whatsapp'
               THEN 'wamid.synthetic-' || g.n::text ELSE NULL END
      FROM generate_series(1,2935) AS g(n)
      JOIN (
        SELECT id, channel, row_number() OVER(ORDER BY id) AS seq
        FROM contacts
      ) c ON ((g.n - 1) % 230) + 1 = c.seq
    `);
    const beforeCounts=(await admin.query(`
      SELECT
        (SELECT count(*)::int FROM contacts) AS contacts,
        (SELECT count(*)::int FROM messages) AS messages,
        (SELECT count(*)::int FROM leads) AS leads,
        (SELECT count(*)::int FROM contacts WHERE channel='facebook') AS messenger,
        (SELECT count(*)::int FROM contacts WHERE channel='whatsapp') AS whatsapp,
        (SELECT count(*)::int FROM messages WHERE whatsapp_message_id IS NOT NULL) AS provider_ids
    `)).rows[0];
    assert.deepEqual(beforeCounts, {
      contacts:230,messages:2936,leads:230,messenger:13,whatsapp:217,
      provider_ids:2780,
    });
    const original = await admin.query(
      "SELECT version,name,checksum FROM schema_migrations WHERE version IN (78,79) ORDER BY version"
    );
    const forward = await runMigrations(pool, { quiet: true });
    assert.equal(forward.currentVersion, 106);
    assert.equal(forward.appliedCount, 27);
    const after = await admin.query(
      "SELECT version,name,checksum FROM schema_migrations WHERE version IN (78,79) ORDER BY version"
    );
    assert.deepEqual(after.rows, original.rows, "already applied sales migrations are immutable");
    const data = await admin.query(
      "SELECT c.name,m.content,c.whatsapp_sender_id FROM contacts c JOIN messages m ON m.contact_id=c.id WHERE c.id=$1 AND m.whatsapp_message_id='wamid.legacy-retained'",
      [contactId]
    );
    assert.equal(data.rows.length,1);
    assert.equal(data.rows[0].name,"Existing Neutro contact");
    assert.equal(data.rows[0].content,"Existing Neutro chat stays intact");
    assert.equal(data.rows[0].whatsapp_sender_id,null);
    const afterCounts=(await admin.query(`
      SELECT
        (SELECT count(*)::int FROM contacts) AS contacts,
        (SELECT count(*)::int FROM messages) AS messages,
        (SELECT count(*)::int FROM leads) AS leads,
        (SELECT count(*)::int FROM contacts WHERE channel='facebook') AS messenger,
        (SELECT count(*)::int FROM contacts WHERE channel='whatsapp') AS whatsapp,
        (SELECT count(*)::int FROM messages WHERE whatsapp_message_id IS NOT NULL) AS provider_ids
    `)).rows[0];
    assert.deepEqual(afterCounts,beforeCounts,
      "legacy WhatsApp, Messenger, leads and message IDs must survive");
    const referential=(await admin.query(`
      SELECT (SELECT count(*)::int FROM messages m LEFT JOIN contacts c
                ON c.id=m.contact_id WHERE c.id IS NULL) AS orphan_messages,
             (SELECT count(*)::int FROM leads l LEFT JOIN contacts c
                ON c.id=l.contact_id WHERE c.id IS NULL) AS orphan_leads,
             (SELECT count(*)::int FROM contacts
                WHERE whatsapp_sender_id IS NOT NULL) AS unexpected_sender_bindings
    `)).rows[0];
    assert.deepEqual(referential,
      {orphan_messages:0,orphan_leads:0,unexpected_sender_bindings:0});

    const protectedTables = await admin.query(
      "SELECT to_regclass('whatsapp_sender_accounts') AS sender, " +
      "to_regclass('whatsapp_sender_coexistence_import_jobs') AS imports, " +
      "to_regclass('sales_follow_up_events') AS sales"
    );
    assert.ok(Object.values(protectedTables.rows[0]).every(Boolean));
    const state = await admin.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name) " +
      "VALUES('candidate_test','100000000000009','200000000000009','QA only') RETURNING id,state,coexistence_enabled"
    );
    assert.equal(state.rows[0].state,"disabled");
    assert.equal(state.rows[0].coexistence_enabled,false);
    const senderId = state.rows[0].id;
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM contacts WHERE channel='facebook'"
    )).rows[0].n,13,"existing Messenger contacts remain isolated");

    await admin.query(
      "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) VALUES($1,$2)",
      ["60120000001",senderId]
    );
    await assert.rejects(
      admin.query("INSERT INTO contacts(whatsapp_number) VALUES($1)",["60120000001"]),
      /duplicate key/
    );
    await assert.rejects(
      admin.query("INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
        "VALUES($1,$2,$3,'bound')",[senderId,"60120000001",contactId]),
      /foreign key/
    );
    const repeat = await runMigrations(pool,{quiet:true});
    assert.equal(repeat.appliedCount,0,"restarts must not reapply migrations");
    await assert.rejects(
      runMigrations(pool,{quiet:true,migrations:migrations.slice(0,79)}),
      /newer than|version|history/i,
      "old rollback binary must fail closed on v106 database"
    );

    // Real PostgreSQL proof of the entire encrypted capture -> passive
    // Inbox handoff. Both schemas are disposable in LOCAL CI PostgreSQL.
    // This NEVER reads or writes an external Neon database.
    await admin.query("CREATE SCHEMA " + captureSchema);
    const sourcePool = new Pool({
      connectionString: url, max:2, options:"-c search_path=" + captureSchema
    });
    const inboxPool = new Pool({
      connectionString: url, max:2, options:"-c search_path=" + schema
    });
    try {
      await sourcePool.query("CREATE TABLE schema_migrations(version int PRIMARY KEY,name text NOT NULL)");
      await sourcePool.query(
        "INSERT INTO schema_migrations(version,name) VALUES " +
        "(102,'whatsapp_coexistence_preidentity_events')," +
        "(103,'whatsapp_legacy_lifecycle_relay_audit')," +
        "(104,'whatsapp_coexistence_once_only_and_lifecycle_alerts')"
      );
      await sourcePool.query(
        "CREATE TABLE whatsapp_sender_accounts (" +
        "id BIGSERIAL PRIMARY KEY, sender_key text UNIQUE NOT NULL," +
        "meta_account_id text NOT NULL,meta_phone_number_id text NOT NULL," +
        "state text NOT NULL,coexistence_enabled boolean NOT NULL)"
      );
      const encryptedSchemaSql=fs.readFileSync(path.join(__dirname,
        "../ops/qa-only/001_secondary_encrypted_capture.sql"),"utf8");
      const checkpointSchemaSql=fs.readFileSync(path.join(__dirname,
        "../ops/qa-only/002_secondary_capture_history_handoff.sql"),"utf8");
      await sourcePool.query(encryptedSchemaSql);
      await sourcePool.query(checkpointSchemaSql);
      await sourcePool.query(
        "INSERT INTO whatsapp_sender_accounts(" +
        "sender_key,meta_account_id,meta_phone_number_id,state,coexistence_enabled)" +
        "VALUES ('coexistence_qa','889900','112233','testing',TRUE)"
      );
      // The target is independently VERIFIED and active only in disposable
      // CI. The QA source remains testing, and the live primary remains OFF.
      const second = await inboxPool.query(
        "INSERT INTO whatsapp_sender_accounts(" +
        "sender_key,meta_account_id,meta_phone_number_id,display_name,state,coexistence_enabled)" +
        "VALUES ('coexistence_qa','889900','112233','Synthetic second number','active',TRUE)" +
        "RETURNING id"
      );
      const secondId = second.rows[0].id;
      const syntheticEnv = {
        WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
        WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
        WHATSAPP_APP_SECRET:"synthetic-key-".repeat(3),
        META_APP_SECRET:"synthetic-key-".repeat(3),
        WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"synthetic-verify-".repeat(3),
        WHATSAPP_WABA_ID:"1593376338308612",
        WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
        WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
        WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60174831336",
        WHATSAPP_PAID_REAL_CLINIC_REHEARSAL_ENABLED:"true",
        WHATSAPP_PAID_REAL_CLINIC_OPERATOR_APPROVED:"true",
        WHATSAPP_PAID_REAL_CLINIC_E164_PIN:"+60174831336",
        DATABASE_URL:"postgresql://synthetic:synthetic@ep-disposable-target.neon.tech/qa_inbox",
        WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
          "postgresql://synthetic:synthetic@ep-disposable-source.neon.tech/capture",
        WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-disposable-source.neon.tech",
        WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
        WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
        WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60174831336",
        WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
        WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
        WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
        WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:Buffer.alloc(32,13).toString("base64"),
        WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED:"true",
        WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED:"true",
        WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST:"ep-disposable-target.neon.tech",
        WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE:"qa_inbox",
        WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE:"capture",
        PR395_STAGING_MODE:"true"
      };
      const now=String(Math.floor(Date.now()/1000)-3600);
      const oldHistory={object:"whatsapp_business_account",entry:[{
        id:"889900",time:Number(now),changes:[{field:"history",value:{
          metadata:{phone_number_id:"112233"},
          history:[{metadata:{phase:1,progress:100},threads:[{
            id:"60126662222",messages:[{
              id:"wamid.real-pg-history-in",from:"60126662222",timestamp:now,
              type:"text",text:{body:"Synthetic customer message"}
            },{
              id:"wamid.real-pg-history-out",from:"60174831336",
              to:"60126662222",timestamp:now,
              type:"text",text:{body:"Synthetic business reply"}
            }]}]}]
        }}]
      }]};
      const captured=await qaCapture.captureSignedSecondaryBatch(oldHistory,{
        env:syntheticEnv,database:sourcePool,signatureVerified:true
      });
      assert.equal(captured.inserted,1);
      const replay=await qaCapture.captureSignedSecondaryBatch(oldHistory,{
        env:syntheticEnv,database:sourcePool,signatureVerified:true
      });
      assert.equal(replay.inserted,0,"Meta retries are encrypted only once");
      const handed=await handoff.handoffOnce({
        env:syntheticEnv,sourceDatabase:sourcePool,
        targetDatabase:inboxPool,processInboxJobs:true
      });
      assert.equal(handed.transferred,1);
      assert.equal(handed.importer.processed,1);
      const actual=await inboxPool.query(
        "SELECT m.whatsapp_message_id,m.role,m.content,m.source_created_at," +
        "c.whatsapp_sender_id,x.conversation_id " +
        "FROM messages m JOIN contacts c ON c.id=m.contact_id " +
        "JOIN whatsapp_sender_message_context x ON x.message_id=m.id " +
        "WHERE m.whatsapp_message_id IN ($1,$2) ORDER BY m.whatsapp_message_id",
        ["wamid.real-pg-history-in","wamid.real-pg-history-out"]
      );
      assert.equal(actual.rows.length,2);
      assert.deepEqual(actual.rows.map(r=>r.role),["user","assistant"]);
      assert.ok(actual.rows.every(r=>String(r.whatsapp_sender_id)===String(secondId)));
      assert.equal(new Date(actual.rows[0].source_created_at).getTime(),
        Number(now)*1000);
      const afterMessages=await inboxPool.query(
        "SELECT count(*)::int AS n FROM whatsapp_sender_coexistence_history_messages " +
        "WHERE sender_id=$1",[secondId]
      );
      assert.equal(afterMessages.rows[0].n,2);
      const checkpoint=await sourcePool.query(
        "SELECT count(*)::int AS n FROM whatsapp_secondary_qa_capture_events " +
        "WHERE handoff_completed_at IS NOT NULL"
      );
      assert.equal(checkpoint.rows[0].n,1);
      const again=await handoff.handoffOnce({
        env:syntheticEnv,sourceDatabase:sourcePool,
        targetDatabase:inboxPool,processInboxJobs:true
      });
      assert.equal(again.transferred,0);
      assert.equal((await inboxPool.query(
        "SELECT count(*)::int AS n FROM messages WHERE whatsapp_message_id " +
        "IN ('wamid.real-pg-history-in','wamid.real-pg-history-out')"
      )).rows[0].n,2,"Replay must not create new Inbox messages");
      assert.equal((await inboxPool.query(
        "SELECT count(*)::int AS n FROM contacts WHERE channel='facebook'"
      )).rows[0].n,13,"Messenger history stays unchanged");
      assert.equal((await inboxPool.query(
        "SELECT content FROM messages WHERE whatsapp_message_id='wamid.legacy-retained'"
      )).rows[0].content,"Existing Neutro chat stays intact");
      console.log("PASS synthetic encrypted QA capture -> sender-specific Inbox -> replay safe.");
    } finally {
      await sourcePool.end();
      await inboxPool.end();
    }

    console.log("PASS disposable v079 -> v106; original chat and migration checksums preserved;");
    console.log("PASS sender isolation, no automatic activation, idempotence and rollback guard.");
  } finally {
    await admin.query("SET search_path TO public").catch(()=>{});
    await admin.query("DROP SCHEMA IF EXISTS " + captureSchema + " CASCADE").catch(()=>{});
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(()=>{});
    await admin.end();
  }
});
