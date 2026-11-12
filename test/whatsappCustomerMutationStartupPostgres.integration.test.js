"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const mutations=require("../src/services/whatsappCustomerMutationService");
const cs=process.env.TEST_DATABASE_URL;
test("startup reconciliation accepts nullable user ID for edit and targetless edit notices",{
 skip:!cs
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="neutro_mutation_restart_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const migrations={async connect(){
   const c=new Client({connectionString:cs});await c.connect();
   await c.query("SET search_path TO "+schema);
   return {query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(migrations,{quiet:true});
  const phone="100000000001062",waba="200000000001062";
  const sid=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary',$1,$2,'Test secondary','active') RETURNING id",
   [phone,waba])).rows[0].id;
  const contact=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
   "VALUES('whatsapp','60123401062',$1) RETURNING id",[sid])).rows[0].id;
  const original=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Original customer question','wamid.original-mutation-131060') RETURNING id",
   [contact])).rows[0].id;
  const now=Math.floor(Date.now()/1000);
  await db.query(
   "INSERT INTO whatsapp_customer_message_mutations "+
   "(event_wamid,target_wamid,business_phone_number_id,business_account_id,"+
   "customer_address,customer_user_id,action,replacement_text,provider_timestamp) "+
   "VALUES('wamid.edited-test','wamid.original-mutation-131060',$1,$2,'60123401062',NULL,'edit','Corrected customer question',$3)",
   [phone,waba,now]);
  await db.query(
   "INSERT INTO whatsapp_customer_message_mutations "+
   "(event_wamid,target_wamid,business_phone_number_id,business_account_id,"+
   "customer_address,customer_user_id,action,replacement_text,provider_timestamp) "+
   "VALUES('wamid.targetless-test',NULL,$1,$2,'60123401062',NULL,'unavailable_edit',NULL,$3)",
   [phone,waba,now]);
  const env={
   WHATSAPP_WABA_ID:"999999999991062",
   WHATSAPP_PHONE_NUMBER_ID:"888888888881062",
   WHATSAPP_SECONDARY_WABA_ID:waba,
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:phone,
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  };
  const database={
   query:(...args)=>db.query(...args),
   connect:async()=>({query:(...args)=>db.query(...args),release(){}}),
  };
  const result=await mutations.reconcilePendingOnStartup({database,env,limit:40});
  assert.equal(result.scanned,2);
  assert.equal(result.repaired,2);
  const changes=(await db.query(
   "SELECT event_wamid,status,notice_contact_id FROM whatsapp_customer_message_mutations ORDER BY event_wamid"
  )).rows;
  assert.deepEqual(changes.map(x=>x.status),["applied","applied"]);
  assert.equal((await db.query("SELECT content FROM messages WHERE id=$1",[original])).rows[0].content,
   "Corrected customer question");
  assert.equal(changes.find(x=>x.event_wamid==="wamid.targetless-test").notice_contact_id,contact);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
