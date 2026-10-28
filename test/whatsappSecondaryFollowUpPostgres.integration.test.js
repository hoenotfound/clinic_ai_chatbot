"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const {CANDIDATES_SQL,RECHECK_SQL}=require("../src/services/whatsappSecondaryFollowUpService");

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
   assert.equal(loadMigrations().at(-1).version,106);
   await runMigrations(database,{quiet:true});
   assert.equal((await db.query(
     "SELECT COUNT(*)::int AS n FROM whatsapp_sender_followup_rules"
   )).rows[0].n,0,"No Ariel followup rules may be enabled by schema migration");
   await db.query(
     "PREPARE sender_followup_candidates(text,text,text,timestamptz,integer) AS "+CANDIDATES_SQL
   );
   await db.query(
     "PREPARE sender_followup_recheck(integer,integer,integer,text,text,text,timestamptz) AS "+RECHECK_SQL
   );
   const c=await db.query(
     "EXECUTE sender_followup_candidates('ariel','100000000000002','200000000000002',NOW(),10)"
   );
   assert.deepEqual(c.rows,[]);
   const status=await db.query(
     "EXECUTE sender_followup_recheck(1,1,2,'ariel','100000000000002','200000000000002',NOW())"
   );
   assert.equal(status.rows?.[0]?.allowed,false);
   await db.query("DEALLOCATE sender_followup_candidates");
   await db.query("DEALLOCATE sender_followup_recheck");
 }finally{
   await db.query("SET search_path TO public").catch(()=>{});
   await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
   await db.end();
 }
});
