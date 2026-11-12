"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");

// Load the production SQL with the exact old-contact and 131060 policy flags
// enabled. The ordinary CI environment has these flags OFF and previously
// failed to compile the query branch used by the live Neutro scheduler.
for(const [key,value] of Object.entries({
 WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
 WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
 WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
}))process.env[key]=value;
const svc=require("../src/services/whatsappSecondaryMarketingFollowUpService");

test("production legacy 131060 marketing selectors expose inbound.content",()=>{
 assert.match(svc.CANDIDATES_SQL,/m\.content,m\.content AS last_customer_text/);
 for(const sql of [svc.CANDIDATES_SQL,svc.RECHECK_SQL,svc.POTENTIAL_DUE_SQL]){
   assert.match(sql,/inbound\.content/);
   assert.match(sql,/secondary|marketing|treatment|lead/i);
 }
});

const cs=process.env.TEST_DATABASE_URL;
test("production legacy 131060 48h/66h query compiles in migrated PostgreSQL",{
 skip:!cs
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="neutro_131060_marketing_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const migrator={async connect(){
   const c=new Client({connectionString:cs});
   await c.connect();
   await c.query("SET search_path TO "+schema);
   return{query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(migrator,{quiet:true});
  await db.query("PREPARE old_contact_marketing_candidates(text,text,text,timestamptz,integer,timestamptz,text,timestamptz) AS "+svc.CANDIDATES_SQL);
  await db.query("PREPARE old_contact_marketing_recheck(text,text,text,timestamptz,integer,timestamptz,text,timestamptz) AS "+svc.RECHECK_SQL);
  await db.query("PREPARE old_contact_marketing_due(text,text,text,timestamptz,timestamptz,text,timestamptz) AS "+svc.POTENTIAL_DUE_SQL);
  assert.deepEqual((await db.query(
    "EXECUTE old_contact_marketing_candidates('neutro_secondary','123','456',NOW(),5,NOW(),'all_contacts',NOW())")).rows,[]);
  const due=(await db.query(
    "EXECUTE old_contact_marketing_due('neutro_secondary','123','456',NOW(),NOW(),'all_contacts',NOW())")).rows[0];
  assert.equal(due.next_due_at,null);
  await db.query("DEALLOCATE old_contact_marketing_candidates");
  await db.query("DEALLOCATE old_contact_marketing_recheck");
  await db.query("DEALLOCATE old_contact_marketing_due");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
