"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const cs=process.env.TEST_DATABASE_URL;

test("PostgreSQL: a provably unsent Day4 does not block Day6, but uncertain sends do",{
 skip:!cs,
},async()=>{
 const admin=new Client({connectionString:cs});
 const schema="day4_day6_verified_cancel_"+process.pid+"_"+Date.now();
 await admin.connect();
 try{
  await admin.query("CREATE SCHEMA "+schema);
  await admin.query("SET search_path TO "+schema);
  const database={
   query:(...args)=>admin.query(...args),
   async connect(){
    const c=new Client({connectionString:cs});
    await c.connect();
    await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   },
  };
  await runMigrations(database,{quiet:true});
  // Compile every real production selector against migrated PostgreSQL.
  const args=["neutro_secondary","100000000000002","200000000000002",
   new Date(),100,"2026-11-11T00:00:00Z","ads_only","2026-10-30T00:00:00Z"];
  for(const sql of [marketing.EXTENDED_CANDIDATES_SQL,
                    marketing.EXTENDED_RECHECK_SQL]){
   await admin.query("EXPLAIN "+sql,args);
  }
  const sender=(await admin.query(
   "INSERT INTO whatsapp_sender_accounts "+
   "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary','100000000000002','200000000000002','Neutro','active') RETURNING id"
  )).rows[0].id;
  const contact=(await admin.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
   "VALUES('whatsapp','60129993333',$1) RETURNING id",[sender])).rows[0].id;
  const inbound=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Interested in facial care','wamid.inbound') RETURNING id",
   [contact])).rows[0].id;
  const cancelled=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,delivery_status) "+
   "VALUES($1,'assistant','Cancelled before Meta','cancelled') RETURNING id",
   [contact])).rows[0].id;
  const reservation=crypto.randomUUID();
  await admin.query(
   "INSERT INTO whatsapp_sender_billing_attempts "+
   "(reservation_id,sender_id,contact_id,message_id,state,billable_authorized) "+
   "VALUES($1,$2,$3,$4,'rejected',TRUE)",
   [reservation,sender,contact,cancelled]);
  await admin.query(
   "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
   "(sender_id,contact_id,anchor_message_id,slot_hours,message_id,status,error_code) "+
   "VALUES($1,$2,$3,96,$4,'blocked','secondary_pre_provider_cancelled')",
   [sender,contact,inbound,cancelled]);
  // This is the exact production proof expression used by the extended
  // discovery and final recheck, not a reimplementation of the rule.
  const blockerSql="SELECT COUNT(*)::int AS n FROM whatsapp_sender_marketing_followup_attempts bad "+
    "WHERE bad.sender_id=$1 AND bad.contact_id=$2 "+
    "AND bad.anchor_message_id IS NOT NULL "+
    "AND bad.status IN ('unknown','blocked') "+
    "AND NOT ("+marketing.PROVEN_CANCELLED_MARKETING_ATTEMPT_SQL+")";
  assert.ok(marketing.EXTENDED_CANDIDATES_SQL.includes(
   marketing.PROVEN_CANCELLED_MARKETING_ATTEMPT_SQL));
  assert.ok(marketing.EXTENDED_RECHECK_SQL.includes(
   marketing.PROVEN_CANCELLED_MARKETING_ATTEMPT_SQL));
  const count=async()=>Number((await admin.query(blockerSql,[sender,contact])).rows[0].n);
  assert.equal(await count(),0,"verified cancelled Day4 must not block Day6");
  await admin.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",[cancelled]);
  assert.equal(await count(),1,"unknown message still blocks");
  await admin.query("UPDATE messages SET delivery_status='cancelled' WHERE id=$1",[cancelled]);
  await admin.query("UPDATE whatsapp_sender_billing_attempts SET state='unknown' WHERE reservation_id=$1",[reservation]);
  assert.equal(await count(),1,"unsettled billing still blocks");
  await admin.query("UPDATE whatsapp_sender_billing_attempts SET state='rejected' WHERE reservation_id=$1",[reservation]);
  await admin.query("UPDATE whatsapp_sender_marketing_followup_attempts SET error_code='unverified' WHERE message_id=$1",[cancelled]);
  assert.equal(await count(),1,"unreviewed blocked attempt still blocks");
  await admin.query("UPDATE whatsapp_sender_marketing_followup_attempts SET error_code='secondary_pre_provider_cancelled' WHERE message_id=$1",[cancelled]);
  assert.equal(await count(),0);
  await admin.query(
   "INSERT INTO whatsapp_sender_status_receipts "+
   "(fingerprint,sender_id,reservation_id,wamid,wamid_hash,delivery_status,meta_phone_number_id,meta_account_id,matched) "+
   "VALUES('synthetic-receipt',$1,$2,'wamid.synthetic.provider',$3,'sent','100000000000002','200000000000002',TRUE)",
   [sender,reservation,"f".repeat(64)]);
  assert.equal(await count(),1,"a provider receipt forbids cancellation proof");
  await admin.query("DELETE FROM whatsapp_sender_status_receipts WHERE fingerprint='synthetic-receipt'");
  assert.equal(await count(),0);
  // The historical Day4 slot remains one-shot. Only the *different* Day6
  // slot may proceed; this test never calls the network/provider.
  assert.match(marketing.EXTENDED_CANDIDATES_SQL,
   /other\.slot_hours=rule\.slot_hours[\s\S]*?other\.status IN\('accepted','unknown','blocked'\)/);
  await admin.query(
   "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
   "(sender_id,contact_id,anchor_message_id,slot_hours,status,error_code) "+
   "VALUES($1,$2,$3,144,'unknown','meta_outcome_unconfirmed')",
   [sender,contact,inbound]);
  assert.equal(await count(),1,"genuine unknown Day6 still blocks new sends");
 }finally{
  await admin.query("RESET search_path").catch(()=>{});
  await admin.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await admin.end();
 }
});

test("PostgreSQL: definitely rejected marketing send is cancelled atomically",{
 skip:!cs,
},async()=>{
 const admin=new Client({connectionString:cs});
 const schema="marketing_finalizer_"+process.pid+"_"+Date.now();
 await admin.connect();
 try{
  await admin.query("CREATE SCHEMA "+schema);
  await admin.query("SET search_path TO "+schema);
  const database={
   query:(...args)=>admin.query(...args),
   async connect(){
    const c=new Client({connectionString:cs});await c.connect();
    await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   },
  };
  await runMigrations(database,{quiet:true});
  const sender=(await admin.query(
   "INSERT INTO whatsapp_sender_accounts "+
   "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary','100000000000002','200000000000002','Neutro','active') RETURNING id"
  )).rows[0].id;
  const contact=(await admin.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
   "VALUES('whatsapp','60129994444',$1) RETURNING id",[sender])).rows[0].id;
  const inbound=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Interested in care','wamid.inbound') RETURNING id",[contact])).rows[0].id;
  const outgoing=(await admin.query(
   "INSERT INTO messages(contact_id,role,content,delivery_status) "+
   "VALUES($1,'assistant','Unsent','unknown') RETURNING id",[contact])).rows[0].id;
  const attempt=(await admin.query(
   "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
   "(sender_id,contact_id,anchor_message_id,slot_hours,message_id,status) "+
   "VALUES($1,$2,$3,144,$4,'claimed') RETURNING id",
   [sender,contact,inbound,outgoing])).rows[0].id;
  const reservation=crypto.randomUUID();
  await admin.query(
   "INSERT INTO whatsapp_sender_billing_attempts "+
   "(reservation_id,sender_id,contact_id,message_id,state) "+
   "VALUES($1,$2,$3,$4,'rejected')",[reservation,sender,contact,outgoing]);
  const result={success:false,wamid:null,preProviderCancelled:true};
  const opts={database,attemptId:attempt,messageId:outgoing,contactId:contact,result};
  assert.equal(await marketing.finishProvenMarketingPreProviderCancellation(opts),true);
  assert.equal(await marketing.finishProvenMarketingPreProviderCancellation(opts),false,
   "terminal row cannot be replayed or finalized twice");
  const saved=(await admin.query(
   "SELECT a.status,a.error_code,m.delivery_status FROM whatsapp_sender_marketing_followup_attempts a "+
   "JOIN messages m ON m.id=a.message_id WHERE a.id=$1",[attempt])).rows[0];
  assert.deepEqual(saved,{status:"blocked",error_code:"secondary_pre_provider_cancelled",
   delivery_status:"cancelled"});
  assert.equal(await marketing.finishProvenMarketingPreProviderCancellation({
   ...opts,result:{...result,unknown:true}}),false);
 }finally{
  await admin.query("RESET search_path").catch(()=>{});
  await admin.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await admin.end();
 }
});
