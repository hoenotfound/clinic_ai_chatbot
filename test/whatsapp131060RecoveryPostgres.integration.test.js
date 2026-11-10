"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { runMigrations } = require("../src/db/migrationRunner");
const {
  canSend131060Recovery, build131060RecoveryReply,
  getVerifiedRecoveryHistoryProof, readableHistoryForRecoverySelection,
} = require("../src/services/whatsapp131060Recovery");
const {
  recordVerifiedFirstAd, getVerifiedFirstAdMessage,
} = require("../src/db/whatsapp131060FirstAdRepo");

const cs = process.env.TEST_DATABASE_URL;
test("131060 recovery remains one-shot and keeps subsequent verified ad attribution", { skip: !cs }, async () => {
  const db = new Client({connectionString:cs});
  const schema = "secondary_131060_recovery_" + process.pid + "_" + Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA " + schema);
    await db.query("SET search_path TO " + schema);
    const migrator = { async connect() {
      const client = new Client({connectionString:cs});
      await client.connect();
      await client.query("SET search_path TO " + schema);
      return {query:(...args)=>client.query(...args),release:()=>client.end()};
    }};
    await runMigrations(migrator,{quiet:true});
    const phoneId = "1318355951360575", accountId = "1852014482431209";
    const sender = (await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
      "VALUES('neutro_secondary',$1,$2,'Test Coexistence','active') RETURNING id",
      [phoneId,accountId]
    )).rows[0].id;
    const phone = "60121100077";
    const contact = (await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,mode) " +
      "VALUES('whatsapp',$1,$2,'ai') RETURNING id", [phone,sender]
    )).rows[0].id;
    const conv = (await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) " +
      "VALUES($1,$2,$3,'bound') RETURNING id",[sender,contact,phone]
    )).rows[0].id;
    const initial = (await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,source_created_at) " +
      "VALUES($1,'user','📎 [Customer sent a WhatsApp message that could not be displayed]','wamid.recov-unread',NOW()) RETURNING id",
      [contact]
    )).rows[0].id;
    await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[initial,conv]);
    const job = (await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) " +
      "VALUES($1,$2,'whatsapp',$3::jsonb,'processing') RETURNING id",
      [initial,contact,JSON.stringify({
        unsupportedType:"unsupported",unsupportedErrors:[{code:131060}],
        businessPhoneNumberId:phoneId,businessAccountId:accountId,
      })]
    )).rows[0].id;
    await db.query(
      "INSERT INTO ai_review_items(contact_id,inbound_message_id,category,summary,status) " +
      "VALUES($1,$2,'information','WhatsApp message unavailable (Meta 131060). Meta did not provide the content.','pending')",
      [contact,initial]);
    await db.query("UPDATE contacts SET needs_attention=TRUE,attention_reason=$2 WHERE id=$1",
      [contact,"AI review requested: [#"+initial+"] WhatsApp message unavailable (Meta 131060)"]);
    const earlier = new Date(Date.now()-120000).toISOString();
    const env = {
      WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
      WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:earlier,
      WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:earlier,
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_SECONDARY_PHONE_NUMBER_ID:phoneId,WHATSAPP_SECONDARY_WABA_ID:accountId,
    };
    const eligible = () => canSend131060Recovery({
      contactId:contact,inboundMessageId:initial,database:db,env,
    });
    assert.equal(await eligible(),true);
    const recoveryMessage=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) " +
      "VALUES($1,'assistant',$2,'wamid.recovery-out') RETURNING id",
      [contact,build131060RecoveryReply({unsupportedType:"unsupported"})]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [recoveryMessage,conv]
    );
    await db.query(
      "INSERT INTO inbound_outbound_attempts(processing_job_id,inbound_message_id,assistant_message_id,contact_id,origin,outcome,provider_message_id) " +
      "VALUES($1,$2,$3,$4,'system_fallback','accepted','wamid.recovery-out')",
      [job,initial,recoveryMessage,contact]
    );
    assert.equal(await eligible(),false,"a reserved outbound must be explicitly excluded at last send check");
    assert.equal(await canSend131060Recovery({
      contactId:contact,inboundMessageId:initial,ignoreOutboundMessageId:recoveryMessage,
      database:db,env,
    }),true);
    const adId="120123456789012345";
    const ad=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,source_created_at) " +
      "VALUES($1,'user','Hi, I would like to know about this','wamid.recovery-verified-ad',NOW()) RETURNING id",
      [contact]
    )).rows[0].id;
    await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[ad,conv]);
    await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload) " +
      "VALUES($1,$2,'whatsapp',$3::jsonb)",
      [ad,contact,JSON.stringify({text:"Hi, I would like to know about this",
        attribution:{source:"meta_ads",sourceType:"ad",adId}})]
    );
    await db.query(
      "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) " +
      "VALUES($1,$2,$3,'ad')",[ad,contact,adId]
    );
    assert.equal(await eligible(),false,"readable customer reply stops duplicate recovery");
    const cleanupProof=await getVerifiedRecoveryHistoryProof({
      contactId:contact,inboundMessageId:ad,database:db,
    });
    assert.equal(Number(cleanupProof?.unavailable_message_id),Number(initial));
    assert.equal(Number(cleanupProof?.recovery_message_id),Number(recoveryMessage));
    const savedHistory=[
      {role:"user",content:"📎 [Customer sent a WhatsApp message that could not be displayed]"},
      {role:"assistant",content:build131060RecoveryReply({unsupportedType:"unsupported"})},
      {role:"user",content:"Hi, I would like to know about this"},
    ];
    assert.deepEqual(readableHistoryForRecoverySelection(savedHistory,cleanupProof),
      savedHistory.slice(1),"the model sees only the menu and readable customer enquiry");
    await db.query(
      "UPDATE inbound_outbound_attempts SET outcome='ambiguous' WHERE processing_job_id=$1",[job]
    );
    assert.equal(await getVerifiedRecoveryHistoryProof({
      contactId:contact,inboundMessageId:ad,database:db,
    }),null,"an unconfirmed menu must not change the model's history");
    await db.query(
      "UPDATE inbound_outbound_attempts SET outcome='accepted' WHERE processing_job_id=$1",[job]
    );
    const proof=await recordVerifiedFirstAd({contactId:contact,inboundMessageId:ad,adId},db);
    assert.equal(Number(proof.first_ad_message_id),Number(ad),
      "a single tracked system fallback must not erase a provider-verified first ad");
    const read=await getVerifiedFirstAdMessage(contact,ad,db);
    assert.equal(Number(read?.first_ad_message_id),Number(ad));
    await db.query("INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','Human staff response')",[contact]);
    assert.equal(await getVerifiedFirstAdMessage(contact,ad,db).then(Boolean),true,
      "later staff responses cannot invalidate the already-verified first ad");
  } finally {
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
