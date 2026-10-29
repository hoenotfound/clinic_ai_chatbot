"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {loadMigrations,runMigrations}=require("../src/db/migrationRunner");
const cs=process.env.TEST_DATABASE_URL;
test("migration 095 sender AI image queue enforces business identity and privacy-safe erasure",
 {skip:!cs},async()=>{
 const db=new Client({connectionString:cs});
 const schema="ariel_media_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const pool={async connect(){
   const c=new Client({connectionString:cs});await c.connect();
   await c.query("SET search_path TO "+schema);
   return{query:(...a)=>c.query(...a),release:()=>c.end()};
  }};
  assert.equal(loadMigrations().at(-1).version,107);
  await runMigrations(pool,{quiet:true});
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
   "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) VALUES('60125554444',$1) RETURNING id",
   [sender])).rows[0].id;
  const conversation=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60125554444',$2,'bound') RETURNING id",[sender,contact])).rows[0].id;
  const inbound=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Can I see 9D BA?','wamid.qa-inbound') RETURNING id",
   [contact])).rows[0].id;
  await db.query(
   "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
   [inbound,conversation]);
  await assert.rejects(db.query(
   `INSERT INTO whatsapp_sender_ai_media_jobs
      (sender_id,contact_id,inbound_message_id,sequence_no,media_kind,image_url,expires_at)
    VALUES($1+999,$2,$3,0,'result','https://example.com/result.jpg',NOW()+INTERVAL '1 hour')`,
   [sender,contact,inbound]
  ),/foreign key constraint/);
  await db.query(
   `INSERT INTO whatsapp_sender_ai_media_jobs
      (sender_id,contact_id,inbound_message_id,sequence_no,media_kind,image_url,expires_at)
    VALUES($1,$2,$3,0,'result','https://example.com/result.jpg',NOW()+INTERVAL '1 hour')`,
   [sender,contact,inbound]);
  assert.equal((await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_sender_ai_media_jobs"
  )).rows[0].n,1);
  await db.query("DELETE FROM messages WHERE id=$1",[inbound]);
  assert.equal((await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_sender_ai_media_jobs"
  )).rows[0].n,0);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
