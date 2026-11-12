"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const worker=require("../src/services/whatsappSecondaryFollowUpService");

const cs=process.env.TEST_DATABASE_URL;
test("migrated PostgreSQL permits neutral 131060 no-selection follow-ups only after accepted recovery and stops on reply or takeover",{
 skip:!cs
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="neutro_131060_silent_"+process.pid+"_"+Date.now();
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

  const senderName="neutro_secondary",phoneId="100000000001060",waba="200000000001060";
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES($1,$2,$3,'Secondary Test','active') RETURNING id",
    [senderName,phoneId,waba])).rows[0].id;
  await db.query(
    "INSERT INTO whatsapp_sender_followup_rules(sender_id,slot_hours,enabled,message_text) "+
    "VALUES($1,2,TRUE,'Do not send this generic text')",[sender]);

  const contact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
    "VALUES('whatsapp','60122201060',$1,NOW()-INTERVAL '2 years') RETURNING id",
    [sender])).rows[0].id;
  const conversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
    "VALUES($1,$2,'60122201060','bound') RETURNING id",
    [sender,contact])).rows[0].id;
  const inbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','📎 [Customer sent a WhatsApp message that could not be displayed]',"+
    " 'wamid.131060-silent',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '3 hours') RETURNING id",
    [contact])).rows[0].id;
  await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [inbound,conversation]);

  const activation=new Date(Date.now()-5*3600000).toISOString();
  const params=[senderName,phoneId,waba,new Date(),10,activation,"all_contacts",
    new Date(Date.now()-7*3600000).toISOString(),activation];
  const candidates=async()=> (await db.query(worker.CANDIDATES_SQL,params)).rows;
  assert.equal((await candidates()).length,0,
    "unreadable 131060 alone cannot schedule reminders");

  const menu=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at) "+
    "VALUES($1,'assistant',$2,'wamid.131060-menu',NOW()-INTERVAL '2 hours 58 minutes') RETURNING id",
    [contact,"Hi～欢迎来到 Neutro Sense 😊\n想了解哪方面的护理呢？\n可以点下面的选项"]
  )).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [menu,conversation]);
  assert.equal((await candidates()).length,0,"a menu without accepted provider evidence is not enough");
  await db.query(
    "INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) "+
    "VALUES($1,$2,'whatsapp','system_fallback',TRUE,'wamid.131060-menu',NOW()-INTERVAL '2 hours 58 minutes')",
    [menu,contact]);
  const ready=await candidates();
  assert.equal(ready.length,1,"accepted recovery menu activates the 2h silent service slot");
  assert.equal(ready[0].recovery_no_selection,true);
  assert.equal(Number(ready[0].slot_hours),2);

  const claimed=(await db.query(
    "INSERT INTO whatsapp_sender_followup_attempts(sender_id,contact_id,anchor_message_id,slot_hours) "+
    "VALUES($1,$2,$3,2) RETURNING id",[sender,contact,inbound])).rows[0].id;
  const recheck=()=>db.query(worker.RECHECK_SQL,[
    contact,inbound,2,senderName,phoneId,waba,
    ready[0].rule_version,activation,"all_contacts",
    new Date(Date.now()-7*3600000).toISOString(),activation]);
  assert.equal((await recheck()).rows[0].allowed,true,
    "the final pre-send check authorizes the same accepted recovery proof");
  await db.query(
    "UPDATE contacts SET whatsapp_opt_out_at=NOW() WHERE id=$1",[contact]);
  assert.equal((await recheck()).rows[0].allowed,false,"opt-out blocks pre-send");
  await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL WHERE id=$1",[contact]);

  await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','3D 小颜术','wamid.131060-choice',NOW(),NOW())",[contact]);
  assert.equal((await recheck()).rows[0].allowed,false,
    "a customer reply cancels the old no-selection reminder");
  await db.query("DELETE FROM whatsapp_sender_followup_attempts WHERE id=$1",[claimed]);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
