"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const {deferProvenUnsent,reclaimClause}=require(
 "../src/services/whatsappSecondaryPreSendDeferral");
const cs=process.env.TEST_DATABASE_URL;
const gate={success:false,policyBlocked:true,unknown:false,ambiguous:false,
 code:"secondary_billing_previous_send_unresolved",wamid:null};
test("Postgres: only provider-free, unbilled blocked follow-ups may be reclaimed",{
 skip:!cs,
},async()=>{
 const schema="secondary_defer_"+process.pid+"_"+Date.now();
 const admin=new Client({connectionString:cs});
 await admin.connect();
 try{
  await admin.query("CREATE SCHEMA "+schema);
  await admin.query("SET search_path TO "+schema);
  const db={
   query:(...args)=>admin.query(...args),
   async connect(){
    const client=new Client({connectionString:cs});
    await client.connect();
    await client.query("SET search_path TO "+schema);
    return{query:(...args)=>client.query(...args),release:()=>client.end()};
   },
  };
  await runMigrations(db,{quiet:true});
  const sender=(await admin.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('defer_test','100000000000005','200000000000005','test','active') RETURNING id"
  )).rows[0].id;
  const contact=(await admin.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
   "VALUES('whatsapp','60126667777',$1) RETURNING id",[sender]
  )).rows[0].id;
  const inbound=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Test query','wamid.inbound') RETURNING id",[contact]
  )).rows[0].id;
  for(const [table,slot] of [
   ["whatsapp_sender_followup_attempts",2],
   ["whatsapp_sender_marketing_followup_attempts",48],
  ]){
   const outgoing=(await admin.query(
    "INSERT INTO messages(contact_id,role,content,delivery_status) "+
    "VALUES($1,'assistant','Unsent follow-up','unknown') RETURNING id",[contact]
   )).rows[0].id;
   const attempt=(await admin.query(
    "INSERT INTO "+table+" (sender_id,contact_id,anchor_message_id,slot_hours,message_id) "+
    "VALUES($1,$2,$3,$4,$5) RETURNING id",
    [sender,contact,inbound,slot,outgoing]
   )).rows[0].id;
   assert.equal(await deferProvenUnsent({
    database:admin,table,attemptId:attempt,messageId:outgoing,contactId:contact,result:gate,
   }),true);
   const result=(await admin.query(
    "SELECT a.status,a.message_id,a.defer_count,a.retry_after,m.delivery_status "+
    "FROM "+table+" a JOIN messages m ON m.id=$2 WHERE a.id=$1",
    [attempt,outgoing]
   )).rows[0];
   assert.equal(result.status,"deferred");
   assert.equal(result.message_id,null);
   assert.equal(result.delivery_status,"cancelled");
   assert.equal(Number(result.defer_count),1);
   const claim="INSERT INTO "+table+
    " (sender_id,contact_id,anchor_message_id,slot_hours) VALUES($1,$2,$3,$4) "+
    reclaimClause(table);
   assert.equal((await admin.query(claim,[sender,contact,inbound,slot])).rowCount,0,
    "must honor durable backoff");
   await admin.query("UPDATE "+table+" SET retry_after=NOW()-INTERVAL '1 second' WHERE id=$1",[attempt]);
   assert.equal((await admin.query(claim,[sender,contact,inbound,slot])).rowCount,1,
    "can reclaim only once after backoff");
   assert.equal((await admin.query(claim,[sender,contact,inbound,slot])).rowCount,0,
    "concurrent or duplicate claim is never allowed");
  }
  const outgoing=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,delivery_status,whatsapp_message_id) "+
   "VALUES($1,'assistant','Already sent','unknown','wamid.accepted') RETURNING id",
   [contact]
  )).rows[0].id;
  const attempt=(await admin.query(
   "INSERT INTO whatsapp_sender_followup_attempts "+
   "(sender_id,contact_id,anchor_message_id,slot_hours,message_id) "+
   "VALUES($1,$2,$3,6,$4) RETURNING id",
   [sender,contact,inbound,outgoing]
  )).rows[0].id;
  assert.equal(await deferProvenUnsent({
   database:admin,table:"whatsapp_sender_followup_attempts",
   attemptId:attempt,messageId:outgoing,contactId:contact,result:gate,
  }),false,"never replay a stored Meta WAMID");
 }finally{
  await admin.query("RESET search_path").catch(()=>{});
  await admin.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await admin.end();
 }
});
