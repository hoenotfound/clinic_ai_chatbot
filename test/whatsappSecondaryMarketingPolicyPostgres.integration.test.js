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
  assert.equal(loadMigrations().at(-1).version,111);
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
  // Two approved languages coexist in the SAME slot; one attempt is still
  // unique per sender+contact+inbound+slot regardless of language.
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary','100000000000002','200000000000002','Secondary','active') RETURNING id"
  )).rows[0].id;
  for(const [name,lang,hash] of [
    ["ns_48h_choice_v2","zh_CN","a".repeat(64)],
    ["ns_48h_choice_v2","en_US","b".repeat(64)],
    ["ns_66h_assessment_v2","zh_CN","c".repeat(64)],
    ["ns_66h_assessment_v2","en_US","d".repeat(64)],
  ])await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_rules "+
    "(sender_id,slot_hours,enabled,template_name,language_code,template_signature,operator_billing_approved) "+
    "VALUES($1,$2,TRUE,$3,$4,$5,TRUE)",
    [sender,name.startsWith("ns_48h")?48:72,name,lang,hash]
  );
  assert.equal((await db.query(
   "SELECT COUNT(*)::int n FROM whatsapp_sender_marketing_followup_rules WHERE sender_id=$1",
   [sender])).rows[0].n,4,"two language-specific rules per marketing slot");
  await assert.rejects(db.query(
   "INSERT INTO whatsapp_sender_marketing_followup_rules "+
   "(sender_id,slot_hours,template_name,language_code,template_signature) "+
   "VALUES($1,48,'duplicate','zh_CN',$2)",[sender,"f".repeat(64)]
  ),e=>e.code==="23505","same sender, slot and language cannot be duplicated");

 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
