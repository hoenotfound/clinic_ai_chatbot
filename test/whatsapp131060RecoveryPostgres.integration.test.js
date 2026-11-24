"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { runMigrations } = require("../src/db/migrationRunner");
const {
  canSend131060Recovery, build131060RecoveryReply,
  getVerifiedRecoveryHistoryProof, readableHistoryForRecoverySelection, recoveryTreatmentGroups, RECOVERY_SECOND_TEXT,
} = require("../src/services/whatsapp131060Recovery");
const {
  recordVerifiedFirstAd, getVerifiedFirstAdMessage,
} = require("../src/db/whatsapp131060FirstAdRepo");

const {reserveOutboundAttempt}=require("../src/db/inboundProcessingRepo");
const {runOnce}=require("../src/services/whatsapp131060ContinuationQueue");
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
    const [firstButtons,secondButtons]=recoveryTreatmentGroups();
    const reserved=await reserveOutboundAttempt({processingJobId:job,contactId:contact,
      content:build131060RecoveryReply({unsupportedType:"unsupported"},{},true),
      origin:"system_fallback",interactiveButtons:firstButtons,recoveryContinuationButtons:secondButtons},db);
    const recoveryMessage=reserved.message.id;
    await db.query("UPDATE messages SET whatsapp_message_id='wamid.recovery-out' WHERE id=$1",[recoveryMessage]);
    await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[recoveryMessage,conv]);
    await db.query("UPDATE inbound_outbound_attempts SET outcome='accepted',provider_message_id='wamid.recovery-out' WHERE processing_job_id=$1",[job]);
    assert.equal(await eligible(),false,"a reserved outbound must be explicitly excluded at last send check");
    assert.equal(await canSend131060Recovery({
      contactId:contact,inboundMessageId:initial,ignoreOutboundMessageId:recoveryMessage,
      database:db,env,
    }),true);
    // Pending work survives a process restart; no provider call while the
    // prior send has no settled billing gate. Simulate the later receipt.
    let sends=0;
    const deps={database:db,env,contacts:{getContactById:async()=>({id:contact,channel:"whatsapp",whatsapp_number:phone,whatsapp_sender_key:"neutro_secondary"}),
      setDeliveryAttention:async()=>{throw Error("must not flag a successful continuation");}},
      send:async(input)=>{
        assert.deepEqual(input.interactiveButtons,secondButtons);
        assert.equal(input.text,RECOVERY_SECOND_TEXT);
        assert.equal(await input.preSendCheck(),true);
        sends++;
        await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[input.messageId,conv]);
        return {success:true,wamid:"wamid.recovery-second"};
      },
      messages:{setWhatsappMessageId:async(mid,wamid)=>db.query("UPDATE messages SET whatsapp_message_id=$2,delivery_status='delivered' WHERE id=$1",[mid,wamid])}
    };
    await runOnce(deps);
    assert.equal(sends,0);
    assert.equal((await db.query("SELECT state FROM whatsapp_131060_continuations WHERE first_message_id=$1",[recoveryMessage])).rows[0].state,"pending");
    await db.query("INSERT INTO whatsapp_sender_billing_gates(sender_id,owner_contact_id) VALUES($1,$2)",[sender,contact]);
    await db.query("INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) VALUES($1,$2,'whatsapp','system_fallback',TRUE,'wamid.recovery-out',NOW())",[recoveryMessage,contact]);
    await runOnce(deps);
    await runOnce(deps);
    assert.equal(sends,1,"second message is sent once only");
    const continuation=(await db.query("SELECT state,second_message_id FROM whatsapp_131060_continuations WHERE first_message_id=$1",[recoveryMessage])).rows[0];
    assert.equal(continuation.state,"sent");
    assert.ok(continuation.second_message_id);
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
    // A provider WAMID without a sent/delivered receipt must not be
    // interpreted as a visible recovery menu in the model's prompt.
    await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",
      [recoveryMessage]);
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

    // The normal inbound worker eventually prunes the original 131060 job
    // and its outbound-attempt marker. Independent accepted-send evidence
    // must still support prompt-only cleanup, never inferred ad attribution.
    await db.query(
      "INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) " +
      "VALUES($1,$2,'whatsapp','system_fallback',TRUE,'wamid.recovery-out',NOW()) ON CONFLICT(message_id) DO NOTHING",
      [recoveryMessage,contact]
    );
    await db.query(
      "DELETE FROM inbound_processing_jobs WHERE message_id IN ($1,$2)",[initial,ad]
    );
    const retainedProof=await getVerifiedRecoveryHistoryProof({
      contactId:contact,inboundMessageId:ad,database:db,
    });
    assert.equal(Number(retainedProof?.unavailable_message_id),Number(initial),
      "accepted send evidence survives normal inbound job pruning");
    assert.deepEqual(readableHistoryForRecoverySelection(savedHistory,retainedProof),
      savedHistory.slice(1));
    assert.equal(await getVerifiedFirstAdMessage(contact,ad,db).then(Boolean),true,
      "durable verified first-ad proof must also survive pruning");
    await db.query(
      "UPDATE outbound_message_evidence SET accepted=FALSE,accepted_at=NULL WHERE message_id=$1",
      [recoveryMessage]
    );
    assert.equal(await getVerifiedRecoveryHistoryProof({
      contactId:contact,inboundMessageId:ad,database:db,
    }),null,"expired job without independently verified send must fail closed");
  } finally {
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
