"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { runMigrations } = require("../src/db/migrationRunner");
const { approveSecondaryManualAi } = require("../src/db/contactsRepo");
const {
  isSecondaryAiReplyEligible,
  eligibleSecondaryAiReplyContactIds,
  isSecondaryAutomationEligible,
} = require("../src/services/whatsappSecondaryAdsOnlyEligibility");

const connectionString = process.env.TEST_DATABASE_URL;
test("migrated PostgreSQL: secondary manual AI approval never replays old messages", {
  skip: !connectionString,
}, async () => {
  const db = new Client({ connectionString });
  const schema = "secondary_ai_manual_" + process.pid + "_" + Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA " + schema);
    await db.query("SET search_path TO " + schema);
    const migrator = { async connect() {
      const client = new Client({ connectionString });
      await client.connect();
      await client.query("SET search_path TO " + schema);
      return { query: (...args) => client.query(...args), release: () => client.end() };
    }};
    await runMigrations(migrator, { quiet: true });
    const senderPhone = "100000000001098", waba = "200000000001098";
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled) " +
      "VALUES('neutro_secondary',$1,$2,'Secondary','active',TRUE) RETURNING id",
      [senderPhone,waba]
    )).rows[0].id;
    const customerNumber = "60123123098";
    const contactId = (await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) " +
      "VALUES('whatsapp',$1,$2,NOW()-INTERVAL '2 years') RETURNING id",
      [customerNumber,sender]
    )).rows[0].id;
    const conv=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
      "VALUES($1,$2,$3,'bound') RETURNING id",
      [sender,customerNumber,contactId]
    )).rows[0].id;
    const cutoff=new Date(Date.now()-120000).toISOString();
    const env={
      WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
      WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:cutoff,
      WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:new Date(Date.now()-3600000).toISOString(),
      WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:cutoff,
      WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:new Date(Date.now()-3600000).toISOString(),
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_SECONDARY_PHONE_NUMBER_ID:senderPhone,
      WHATSAPP_SECONDARY_WABA_ID:waba,
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
    };
    let counter=0;
    async function inbound(text,when="NOW()"){
      counter++;
      const id=(await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) " +
        "VALUES($1,'user',$2,$3,"+when+","+when+") RETURNING id",
        [contactId,text,"wamid.manual-"+counter]
      )).rows[0].id;
      await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [id,conv]);
      return id;
    }
    const oldInbound=await inbound("Old customer question","NOW()-INTERVAL '30 minutes'");
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:oldInbound,
    }),false);
    assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([contactId],{database:db,env})],[]);
    const snapshot=(await db.query("SELECT updated_at FROM contacts WHERE id=$1",[contactId])).rows[0];
    const approved=await approveSecondaryManualAi(contactId,"admin",
      snapshot.updated_at.toISOString(),env,db);
    assert.ok(approved?.whatsapp_secondary_manual_ai_approved_until,
      "a verified, unrestricted AI-owned contact is approved");
    assert.equal(approved.whatsapp_secondary_manual_ai_approved_by,"admin");
    assert.equal(await approveSecondaryManualAi(contactId,"admin",
      snapshot.updated_at.toISOString(),env,db),null,"duplicate or stale approval blocked");
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:oldInbound,
    }),false,"previous customer turns cannot be replayed");
    assert.equal(await isSecondaryAutomationEligible(contactId,{
      database:db,env,inboundMessageId:oldInbound,
    }),false,"previous turns cannot start follow-up jobs");
    assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([contactId],{database:db,env})],
      [Number(contactId)],"Inbox accurately shows AI as eligible");
    await db.query("SELECT pg_sleep(0.02)");
    const fresh=await inbound("New customer question");
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:fresh,
    }),true,"fresh provider-bound inbound now enables AI replies");
    assert.equal(await isSecondaryAutomationEligible(contactId,{
      database:db,env,inboundMessageId:fresh,
    }),true,"fresh inbound can start eligible follow-ups");
    await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[contactId]);
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:fresh,
    }),false,"manual takeover overrides approval");
    await db.query("UPDATE contacts SET mode='ai',whatsapp_opt_out_at=NOW() WHERE id=$1",[contactId]);
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:fresh,
    }),false,"opt-out overrides approval");
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL, " +
      "whatsapp_secondary_manual_ai_approved_until=NOW()-INTERVAL '1 second' WHERE id=$1",[contactId]);
    assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([contactId],{database:db,env})],[],
      "expired approvals show paused again");
    assert.equal(await isSecondaryAiReplyEligible(contactId,{
      database:db,env,inboundMessageId:fresh,
    }),false,"expired approval denies subsequent AI replies");
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
