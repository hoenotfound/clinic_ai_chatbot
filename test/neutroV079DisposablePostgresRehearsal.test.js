"use strict";
// CI-only ephemeral PostgreSQL 16 rehearsal; NEVER connects to Neon.
// Builds schema 001..077, then upgrades to 079 and checks rollback compatibility.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client, Pool } = require("pg");
const {
  loadMigrations,runMigrations,validateAppliedMigrations
} = require("../src/db/migrationRunner");

const ciConnection=process.env.TEST_DATABASE_URL;
test("CI PostgreSQL rehearses Neutro v077 -> v079 with immutable rollback history", {
  skip:!ciConnection,timeout:120000
},async()=>{
  const adminUrl=new URL(ciConnection);
  if (!["localhost","127.0.0.1"].includes(adminUrl.hostname) ||
      adminUrl.protocol !== "postgresql:" && adminUrl.protocol !== "postgres:") {
    throw Error("Refusing migration rehearsal outside local CI PostgreSQL");
  }
  const name="neutro_ci_rehearsal_"+crypto.randomBytes(7).toString("hex");
  const admin=new Client({connectionString:ciConnection});
  let created=false;
  let pool;
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE "+name);
    created=true;
    const rehearsalUrl=new URL(ciConnection);
    rehearsalUrl.pathname="/"+name;
    pool=new Pool({connectionString:rehearsalUrl.toString(),max:1});
    const all=loadMigrations().filter(m=>m.version<=79);
    assert.equal(all.at(-1).version,79,
      "Production rollback candidate only supports migration 079");
    assert.equal(all[77].name,"sales_follow_up_tasks");
    assert.equal(all[78].name,"sales_follow_up_corrections");

    const first=await runMigrations(pool,{migrations:all.slice(0,77),quiet:true});
    assert.equal(first.currentVersion,77);
    assert.equal(first.appliedCount,77);
    let at77=await pool.query("SELECT MAX(version)::integer AS v FROM schema_migrations");
    assert.equal(at77.rows[0].v,77);

    const upgrade=await runMigrations(pool,{migrations:all,quiet:true});
    assert.equal(upgrade.appliedCount,2);
    assert.equal(upgrade.currentVersion,79);
    const schema=await pool.query(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_schema='public' AND table_name='sales_follow_up_events' " +
      "AND column_name IN ('previous_state','undone_at','undone_by')"
    );
    assert.deepEqual(schema.rows.map(r=>r.column_name).sort(),
      ["previous_state","undone_at","undone_by"]);

    const applied=await pool.query(
      "SELECT version,name,checksum FROM schema_migrations ORDER BY version"
    );
    assert.equal(applied.rows.length,79);
    assert.doesNotThrow(()=>validateAppliedMigrations(applied.rows,all));
    assert.deepEqual(applied.rows.slice(-2).map(r=>r.name),
      ["sales_follow_up_tasks","sales_follow_up_corrections"]);

    const compatibleRollback=await runMigrations(pool,{migrations:all,quiet:true});
    assert.equal(compatibleRollback.appliedCount,0);
    assert.equal(compatibleRollback.skippedCount,79);
    await assert.rejects(
      runMigrations(pool,{migrations:all.slice(0,77),quiet:true}),
      /database is newer than the running code/i,
      "Never roll back to an old binary missing migration 078 and 079"
    );
  } finally {
    if(pool) await pool.end().catch(()=>{});
    if(created) await admin.query("DROP DATABASE "+name+" WITH (FORCE)");
    await admin.end();
  }
});
