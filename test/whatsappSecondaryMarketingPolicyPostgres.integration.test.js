"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const {CANDIDATES_SQL,RECHECK_SQL}=
 require("../src/services/whatsappSecondaryMarketingFollowUpService");
const cs=process.env.TEST_DATABASE_URL;
test("migration 109 compiles second-account 48/72h consent, history, staff and one-shot candidate queries",{
 skip:!cs,
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="secondary_marketing_policy_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const pool={async connect(){
   const c=new Client({connectionString:cs});await c.connect();
   await c.query("SET search_path TO "+schema);
   return{query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  assert.equal(loadMigrations().at(-1).version,110);
  await runMigrations(pool,{quiet:true});
  assert.equal((await db.query("SELECT count(*)::int n FROM whatsapp_sender_marketing_followup_rules")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM whatsapp_sender_marketing_followup_attempts")).rows[0].n,0);
  await db.query("PREPARE secondary_marketing_candidates(text,text,text,timestamptz,integer,timestamptz) AS "+CANDIDATES_SQL);
  await db.query("PREPARE secondary_marketing_recheck(text,text,text,timestamptz,integer,timestamptz) AS "+RECHECK_SQL);
  const candidates=await db.query(
   "EXECUTE secondary_marketing_candidates('ariel','100000000000002','200000000000002',NOW(),10,NOW())");
  assert.deepEqual(candidates.rows,[]);
  const checks=await db.query(
   "EXECUTE secondary_marketing_recheck('ariel','100000000000002','200000000000002',NOW(),10,NOW())");
  assert.deepEqual(checks.rows,[]);
  await db.query("DEALLOCATE secondary_marketing_candidates");
  await db.query("DEALLOCATE secondary_marketing_recheck");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
