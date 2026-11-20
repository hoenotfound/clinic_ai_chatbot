"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const {CANDIDATES_SQL,RECHECK_SQL,POTENTIAL_DUE_SQL}=require("../src/services/whatsappSecondaryFollowUpService");
const {RECORD_SQL}=require("../src/db/whatsappSecondaryFollowUpTreatmentRepo");

const connectionString=process.env.TEST_DATABASE_URL;
test("PostgreSQL compiles both sender-specific followup queries against migrated production schema",{
  skip:!connectionString,
},async()=>{
 const db=new Client({connectionString});
 const schema="ariel_followups_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
   await db.query("CREATE SCHEMA "+schema);
   await db.query("SET search_path TO "+schema);
   const database={
     connect:async()=>{
       const c=new Client({connectionString});
       await c.connect();
       await c.query("SET search_path TO "+schema);
       return{query:(...args)=>c.query(...args),release:()=>c.end()};
     },
   };
   assert.ok(loadMigrations().at(-1).version>=118);
   await runMigrations(database,{quiet:true});
   assert.equal((await db.query(
     "SELECT COUNT(*)::int AS n FROM whatsapp_sender_followup_rules"
   )).rows[0].n,0,"No Ariel followup rules may be enabled by schema migration");
   await db.query(
     "PREPARE sender_followup_candidates(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz) AS "+CANDIDATES_SQL
   );
   await db.query(
     "PREPARE sender_followup_recheck(integer,integer,integer,text,text,text,text,timestamptz,text,timestamptz,timestamptz) AS "+RECHECK_SQL
   );
   await db.query(
     "PREPARE sender_followup_due(text,text,text,timestamptz,timestamptz,text,timestamptz,timestamptz) AS "+POTENTIAL_DUE_SQL
   );
   // Compile sender-bound verification and upsert without creating a message.
   await db.query(
     "PREPARE secondary_treatment_record(integer,integer,text,text,text) AS "+RECORD_SQL
   );
   assert.equal((await db.query(
     "EXECUTE secondary_treatment_record(1,1,'neutro_secondary','selected','骨盆调理')"
   )).rowCount,0);
   await db.query("DEALLOCATE secondary_treatment_record");
   const due=await db.query(
     "EXECUTE sender_followup_due('ariel','100000000000002','200000000000002',NOW(),NOW(),'ads_only',NOW(),NULL)"
   );
   assert.equal(due.rows?.[0]?.next_due_at,null);
   assert.equal(due.rows?.[0]?.has_overdue,false);
   const c=await db.query(
     "EXECUTE sender_followup_candidates('ariel','100000000000002','200000000000002',NOW(),10,NOW(),'ads_only',NOW(),NULL)"
   );
   assert.deepEqual(c.rows,[]);
   const status=await db.query(
     "EXECUTE sender_followup_recheck(1,1,2,'ariel','100000000000002','200000000000002',NOW(),NOW(),'ads_only',NOW(),NULL)"
   );
   assert.equal(status.rows?.[0]?.allowed,false);
   await db.query("DEALLOCATE sender_followup_due");
   await db.query("DEALLOCATE sender_followup_candidates");
   await db.query("DEALLOCATE sender_followup_recheck");
 }finally{
   await db.query("SET search_path TO public").catch(()=>{});
   await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
   await db.end();
 }
});


test("PostgreSQL compiles candidate, pre-send and due-hint SQL with staff-topic and booking nudge enabled",{
 skip:!connectionString,
},async()=>{
 const moduleId=require.resolve("../src/services/whatsappSecondaryFollowUpService");
 const oldFlag=process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED;
 const oldAfter=process.env.NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER;
 let active;
 try {
  process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED="true";
  process.env.NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER="2026-11-21T00:00:00Z";
  delete require.cache[moduleId];
  active=require(moduleId);
 } finally {
  if(oldFlag===undefined)delete process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED;
  else process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED=oldFlag;
  if(oldAfter===undefined)delete process.env.NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER;
  else process.env.NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER=oldAfter;
  delete require.cache[moduleId];
 }
 const quietWindowMarker="   AND EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur'))";
 assert.equal(active.CANDIDATES_SQL.split(quietWindowMarker).length-1,1,
  "Only the original quiet-hours clause may match the due-hint derivation marker");
 assert.match(active.CANDIDATES_SQL,/previous_nudge\.slot_hours=2/);
 assert.match(active.RECHECK_SQL,/previous_nudge\.slot_hours=2/);
 const db=new Client({connectionString});
 const schema="neutro_active_followup_"+process.pid+"_"+Date.now();
 await db.connect();
 try {
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const database={async connect(){
   const c=new Client({connectionString});
   await c.connect();
   await c.query("SET search_path TO "+schema);
   return {query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(database,{quiet:true});
  const statements=[
   ["active_candidates","(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz)",active.CANDIDATES_SQL],
   ["active_recheck","(integer,integer,integer,text,text,text,text,timestamptz,text,timestamptz,timestamptz)",active.RECHECK_SQL],
   ["active_due","(text,text,text,timestamptz,timestamptz,text,timestamptz,timestamptz)",active.POTENTIAL_DUE_SQL],
  ];
  for(const [name,types,sql] of statements){
   try{await db.query("PREPARE "+name+types+" AS "+sql);}
   catch(error){
    const pos=Number(error.position)||0;
    throw new Error(name+" SQL invalid: "+error.message+" at "+pos+
      " near "+JSON.stringify(sql.slice(Math.max(0,pos-180),pos+100)),{cause:error});
   }
  }
  const due=await db.query(
   "EXECUTE active_due('neutro_secondary','100000000000002','200000000000002',NOW(),NOW(),'all_contacts',NOW(),NULL)"
  );
  assert.equal(due.rows?.[0]?.next_due_at,null);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
