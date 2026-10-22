"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const { sendSecondaryStaffText } = require("../src/services/whatsappSecondaryStaffDispatch");

const connectionString = process.env.TEST_DATABASE_URL;
const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
  WHATSAPP_WABA_ID:"200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
};

test("real PostgreSQL sender-qualified Ariel staff send never borrows Neutro windows or permits same-message resend",
  {skip:!connectionString},async()=>{
  const db=new Client({connectionString});
  const schema="secondary_staff_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const database={
      async connect(){
        const c=new Client({connectionString});
        await c.connect(); await c.query("SET search_path TO "+schema);
        return {query:(...args)=>c.query(...args),release:()=>c.end()};
      },
      query:(...args)=>db.query(...args),
    };
    assert.equal(loadMigrations().at(-1).version,92);
    await runMigrations(database,{quiet:true});
    const senders=(await db.query(
      "INSERT INTO whatsapp_sender_accounts " +
      "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) VALUES " +
      "('neutro','100000000000001','200000000000001','Neutro','active')," +
      "('ariel','100000000000002','200000000000002','Ariel','active') " +
      "RETURNING id,sender_key"
    )).rows;
    const ids=Object.fromEntries(senders.map(x=>[x.sender_key,x.id]));
    const contacts=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) " +
      "VALUES('whatsapp','60125550000',$1),('whatsapp','60125550000',$2) RETURNING id",
      [ids.neutro,ids.ariel]
    )).rows;
    const conversations=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
      "VALUES($1,'60125550000',$3,'bound'),($2,'60125550000',$4,'bound') RETURNING id",
      [ids.neutro,ids.ariel,contacts[0].id,contacts[1].id]
    )).rows;
    const inboundNeutro=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) " +
      "VALUES($1,'user','Neutro inbound','wamid.neutro-inbound') RETURNING id",
      [contacts[0].id]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [inboundNeutro,conversations[0].id]
    );
    const ariel={id:contacts[1].id,channel:"whatsapp",
      whatsapp_number:"60125550000",whatsapp_sender_id:ids.ariel};
    const makeDraft=async(text)=>{
      return (await db.query(
        "INSERT INTO messages(contact_id,role,content) " +
        "VALUES($1,'assistant',$2) RETURNING id",
        [contacts[1].id,text]
      )).rows[0].id;
    };
    let apiCalls=0;
    const deps={
      env,database,
      now:()=>new Date(),
      createTransport:async()=>({
        sendText:async()=>{
          apiCalls++;
          return {success:true,wamid:"wamid.ariel-sent"};
        },
      }),
    };
    const first=await sendSecondaryStaffText({
      contact:ariel,messageId:await makeDraft("before Ariel inbound"),
      text:"before Ariel inbound",
    },deps);
    assert.equal(first.code,"secondary_no_verified_inbound");
    assert.equal(apiCalls,0);
    const inboundAriel=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) " +
      "VALUES($1,'user','Ariel inbound','wamid.ariel-inbound') RETURNING id",
      [contacts[1].id]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [inboundAriel,conversations[1].id]
    );
    const messageId=await makeDraft("Ariel staff reply");
    const accepted=await sendSecondaryStaffText({
      contact:ariel,messageId,text:"Ariel staff reply",
    },deps);
    assert.equal(accepted.success,true);
    assert.equal(accepted.wamid,"wamid.ariel-sent");
    assert.equal(apiCalls,1);
    const persisted=(await db.query(
      "SELECT a.sender_id,a.message_id,a.state FROM whatsapp_sender_billing_attempts a"
    )).rows;
    assert.equal(persisted.length,1);
    assert.equal(String(persisted[0].sender_id),String(ids.ariel));
    assert.equal(persisted[0].message_id,messageId);
    assert.equal(persisted[0].state,"awaiting_pricing");
    const duplicate=await sendSecondaryStaffText({
      contact:ariel,messageId,text:"Ariel staff reply",
    },deps);
    assert.equal(duplicate.success,false);
    assert.equal(apiCalls,1);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS total FROM whatsapp_free_only_send_gate"
    )).rows[0].total,0,"Neutro gate unchanged");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS total FROM whatsapp_outbound_retries"
    )).rows[0].total,0,"Neutro queue unchanged");
  } finally {
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
