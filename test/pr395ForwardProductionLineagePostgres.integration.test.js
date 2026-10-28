"use strict";
// Strictly disposable PostgreSQL rehearsal. This file NEVER targets Neutro,
// the existing PR395 QA Neon database or an external DATABASE_URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
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
      "SELECT c.name,m.content,c.whatsapp_sender_id FROM contacts c JOIN messages m ON m.contact_id=c.id WHERE c.id=$1",
      [contactId]
    );
    assert.equal(data.rows.length,1);
    assert.equal(data.rows[0].name,"Existing Neutro contact");
    assert.equal(data.rows[0].content,"Existing Neutro chat stays intact");
    assert.equal(data.rows[0].whatsapp_sender_id,null);
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
    console.log("PASS disposable v079 -> v106; original chat and migration checksums preserved;");
    console.log("PASS sender isolation, no automatic activation, idempotence and rollback guard.");
  } finally {
    await admin.query("SET search_path TO public").catch(()=>{});
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(()=>{});
    await admin.end();
  }
});
