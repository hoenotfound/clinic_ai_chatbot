"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const history=require("../src/services/whatsappCoexistenceHistoryService");
const mutations=require("../src/services/whatsappCoexistenceMutationService");
const echoMedia=require("../src/services/whatsappCoexistenceMediaService");
const policy=require("../src/services/whatsappSecondaryPolicyService");

const url=process.env.TEST_DATABASE_URL;
const env={
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
 WHATSAPP_WABA_ID:"200000000000001",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED:"true",
 WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
};
test("fresh v099 SQL isolates sender-owned coexistence history, media echoes and phone edits",{
 skip:!url,
},async()=>{
 const db=new Client({connectionString:url});
 const schema="coex_v099_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const database={
   query:(...args)=>db.query(...args),
   connect:async()=>{
    const c=new Client({connectionString:url});await c.connect();
    await c.query("SET search_path TO "+schema);
    return {query:(...args)=>c.query(...args),release:()=>c.end()};
   },
  };
  assert.equal(loadMigrations().at(-1).version,101);
  await runMigrations(database,{quiet:true});
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,"+
   "meta_account_id,display_name,state,coexistence_enabled) "+
   "VALUES('ariel','100000000000002','200000000000002','Ariel','active',TRUE) RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
   "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) "+
   "VALUES('60126662222',$1) RETURNING id",[sender])).rows[0].id;
  const conversation=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60126662222',$2,'bound') RETURNING id",[sender,contact])).rows[0].id;
  const echo=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,sent_by_username) "+
   "VALUES($1,'assistant','Old phone reply','wamid.app-old','WhatsApp Business App') RETURNING id",
   [contact])).rows[0].id;
  await db.query(
   "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) "+
   "VALUES($1,$2)",[echo,conversation]);
  assert.equal(await echoMedia.enqueue({
   contactId:contact,messageId:echo,wamid:"wamid.app-old",
   mediaId:"media-1",type:"image",
  },{database,env}),true);
  assert.equal((await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_media_jobs"
  )).rows[0].n,1);
  await assert.rejects(db.query(
   "INSERT INTO whatsapp_sender_coexistence_media_jobs "+
   "(message_id,sender_id,contact_id,provider_media_id,media_type) "+
   "VALUES($1,$2+999,$3,'media-2','image')",
   [echo,sender,contact]
  ),/duplicate key|foreign key/);

  const ev={field:"history",value:{
   metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
   history:[{threads:[{id:"60126662222",messages:[{
    id:"wamid.old-inbound",from:"60126662222",
    timestamp:String(Math.floor(Date.now()/1000)-7200),type:"text",
    text:{body:"Prior conversation only"},
   }]}]}],
  }};
  const staged=await history.acceptPassiveSync({
   entry:[{id:env.WHATSAPP_SECONDARY_WABA_ID,changes:[ev]}],
  },{database,env});
  assert.equal(staged.staged,1);
  assert.equal((await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs WHERE status='pending'"
  )).rows[0].n,1);
  const imported=await history.importPassiveChange({
   accountId:env.WHATSAPP_SECONDARY_WABA_ID,change:ev,
  },{database,env});
  assert.equal(imported.imported,1);
  const contactRow={id:contact,channel:"whatsapp",whatsapp_number:"60126662222"};
  const policyResult=await policy.secondaryPolicySnapshot(contactRow,{database,env});
  assert.equal(policyResult.row.latest_inbound_at,null,
   "Historical inbound must NEVER open a billable WhatsApp service window.");
  const edit=await mutations.record({
   id:"wamid.edit-one",originalMessageId:"wamid.app-old",type:"edit",
   text:"Corrected phone reply",
  },{id:contact,whatsapp_sender_id:sender,whatsapp_number:"60126662222"},
  {database,env});
  assert.equal(edit.isNew,true);
  assert.equal((await db.query(
   "SELECT content FROM messages WHERE id=$1",[echo]
  )).rows[0].content,"Corrected phone reply");
  const deletion=await mutations.record({
   id:"wamid.revoke-one",originalMessageId:"wamid.app-old",type:"revoke",
  },{id:contact,whatsapp_sender_id:sender,whatsapp_number:"60126662222"},
  {database,env});
  assert.equal(deletion.isNew,true);
  assert.match((await db.query(
   "SELECT content FROM messages WHERE id=$1",[echo]
  )).rows[0].content,/deleted from WhatsApp Business App/);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});

test("PostgreSQL v100 disconnect transaction suspends only secondary and is replay safe",{
 skip:!url,
},async()=>{
 const {extractSecondaryLifecycle,persistSecondaryLifecycle}=
   require("../src/services/whatsappCoexistenceAccountUpdateService");
 const db=new Client({connectionString:url});
 const schema="coex_disconnect_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
   await db.query("CREATE SCHEMA "+schema);
   await db.query("SET search_path TO "+schema);
   const database={
     query:(...args)=>db.query(...args),
     connect:async()=>{
       const c=new Client({connectionString:url}); await c.connect();
       await c.query("SET search_path TO "+schema);
       return{query:(...args)=>c.query(...args),release:()=>c.end()};
     }
   };
   await runMigrations(database,{quiet:true});
   await db.query(
     "INSERT INTO whatsapp_sender_accounts "+
     "(sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled) "+
     "VALUES('neutro','100000000000001','200000000000001','Neutro','active',TRUE),"+
     "('ariel','100000000000002','200000000000002','Second','active',TRUE)"
   );
   const settings={...env,WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336"};
   const makeBody=(event)=>({object:"whatsapp_business_account",entry:[{
     id:settings.WHATSAPP_SECONDARY_WABA_ID,
     changes:[{field:"account_update",value:{
       event,phone_number:"+60174831336"
     }}]
   }]});
   const removal=extractSecondaryLifecycle(makeBody("PARTNER_REMOVED"),settings);
   assert.equal(removal.length,1);
   assert.equal((await persistSecondaryLifecycle(removal,{database,env:settings})).count,1);
   assert.equal((await persistSecondaryLifecycle(removal,{database,env:settings})).count,0);
   const reconnect=extractSecondaryLifecycle(makeBody("ACCOUNT_RECONNECTED"),settings);
   assert.equal((await persistSecondaryLifecycle(reconnect,{database,env:settings})).count,1);
   // Simulate an operator verifying the second number and re-enabling it,
   // followed by a NEW PARTNER_REMOVED with identical payload (or replay).
   // It must be disabled again without ever touching Neutro.
   await db.query(
     "UPDATE whatsapp_sender_accounts SET state='active',coexistence_enabled=TRUE "+
     "WHERE sender_key='ariel'"
   );
   assert.equal((await persistSecondaryLifecycle(removal,{database,env:settings})).count,0);
   const rows=(await db.query(
     "SELECT sender_key,state,coexistence_enabled FROM whatsapp_sender_accounts ORDER BY sender_key"
   )).rows;
   assert.deepEqual(rows,[
     {sender_key:"ariel",state:"disabled",coexistence_enabled:false},
     {sender_key:"neutro",state:"active",coexistence_enabled:true},
   ]);
   const audit=(await db.query(
     "SELECT event_type,action FROM whatsapp_sender_coexistence_lifecycle_events ORDER BY recorded_at"
   )).rows;
   assert.equal(audit.length,2);
   assert.ok(audit.some(item=>item.event_type==="PARTNER_REMOVED"&&item.action==="disabled"));
   assert.ok(audit.some(item=>item.event_type==="ACCOUNT_RECONNECTED"&&item.action==="reconnect_review"));
 }finally{
   await db.query("SET search_path TO public").catch(()=>{});
   await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
   await db.end();
 }
});
