"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {Client} = require("pg");
const {runMigrations} = require("../src/db/migrationRunner");
const retry = require("../src/db/whatsappOutboundRetryRepo");
const {PRE_PROVIDER_CODE} = require("../src/services/whatsappSecondaryPreSendDeferral");
const {secondaryRetryFresh,SECONDARY_RETRY_MAX_AGE_MS} =
  require("../src/services/whatsappOutboundRetryService");

const connectionString=process.env.TEST_DATABASE_URL;
const LOCALIZED_FAILURE="Pending prior send confirmation, localized text v2.";

async function withIsolatedDatabase(fn){
  const db=new Client({connectionString});
  const schema="secondary_retry_"+process.pid+"_"+Date.now();
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const database={
      async connect(){
        const client=new Client({connectionString});
        await client.connect();
        await client.query("SET search_path TO "+schema);
        return {query:(...args)=>client.query(...args),release:()=>client.end()};
      },
      query:(...args)=>db.query(...args),
    };
    await runMigrations(database,{quiet:true});
    await fn({db,database});
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
}

async function seedRetry(db){
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts " +
    "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES('neutro_secondary','5550001','6660001','Secondary','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
    "INSERT INTO contacts (channel,whatsapp_number,whatsapp_sender_id,mode) "+
    "VALUES('whatsapp','60125550501',$1,'ai') RETURNING id",[sender]
  )).rows[0].id;
  const inbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
    "VALUES($1,'user','interested','wamid.test-incoming') RETURNING id",[contact]
  )).rows[0].id;
  const outbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,delivery_status,delivery_error) "+
    "VALUES($1,'assistant','Natural AI reply','failed',$2) RETURNING id",
    [contact,LOCALIZED_FAILURE]
  )).rows[0].id;
  const job=(await db.query(
    "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
    "VALUES($1,$2,'whatsapp','{}'::jsonb,'completed') RETURNING id",
    [inbound,contact]
  )).rows[0].id;
  await db.query(
    "INSERT INTO inbound_outbound_attempts "+
    "(processing_job_id,inbound_message_id,assistant_message_id,contact_id,origin,outcome,error_text) "+
    "VALUES($1,$2,$3,$4,'ai_reply','rejected',$5)",
    [job,inbound,outbound,contact,LOCALIZED_FAILURE]
  );
  const row=(await db.query(
    "INSERT INTO whatsapp_outbound_retries "+
    "(message_id,contact_id,recipient,origin,status,processing_kind,attempts,lease_token,last_error) "+
    "VALUES($1,$2,'60125550501','ai_reply','processing','send_pending',1,'lease-test',$3) RETURNING id",
    [outbound,contact,PRE_PROVIDER_CODE]
  )).rows[0];
  return {sender,contact,inbound,outbound,retryId:row.id};
}

async function proven(db,ids){
  return retry.secondaryPreProviderRetrySafe({
    id:ids.retryId,leaseToken:"lease-test",messageId:ids.outbound,
    contactId:ids.contact,failureCode:PRE_PROVIDER_CODE,
  },db);
}
async function eligible(db,ids,allowSecondaryStarted=false){
  return retry.checkSendEligibility({
    id:ids.retryId,leaseToken:"lease-test",messageId:ids.outbound,
    contactId:ids.contact,allowSecondaryStarted,
  },db);
}

test("real PostgreSQL: stable code proves only genuinely unsent secondary AI text",{
  skip:!connectionString,
},async()=>{
  await withIsolatedDatabase(async({db})=>{
    const ids=await seedRetry(db);
    assert.equal(await proven(db,ids),true,
      "localized display text is not used to identify the retry");
    assert.ok(await eligible(db,ids));
    await db.query(
      "UPDATE whatsapp_outbound_retries SET processing_kind='send_started' WHERE id=$1",
      [ids.retryId]
    );
    assert.equal(await eligible(db,ids),null,
      "primary/default eligibility must reject send_started");
    assert.ok(await eligible(db,ids,true),
      "secondary code permits a final recheck during its reserved send");

    await db.query(
      "INSERT INTO outbound_message_evidence "+
      "(message_id,contact_id,channel,origin,accepted,provider_message_id) "+
      "VALUES($1,$2,'whatsapp','ai_reply',TRUE,'wamid.proven-accepted')",
      [ids.outbound,ids.contact]
    );
    assert.equal(await proven(db,ids),false,
      "accepted provider evidence must stop resend");
    await db.query("DELETE FROM outbound_message_evidence WHERE message_id=$1",[ids.outbound]);
    assert.equal(await proven(db,ids),true);

    await db.query(
      "INSERT INTO whatsapp_sender_billing_attempts "+
      "(reservation_id,sender_id,contact_id,message_id,state) "+
      "VALUES($1,$2,$3,$4,'reserved')",
      [crypto.randomUUID(),ids.sender,ids.contact,ids.outbound]
    );
    assert.equal(await proven(db,ids),false,
      "any billing reservation must stop resend");
    await db.query("DELETE FROM whatsapp_sender_billing_attempts WHERE message_id=$1",[ids.outbound]);

    await db.query(
      "UPDATE messages SET whatsapp_message_id='wamid.racing-receipt' WHERE id=$1",
      [ids.outbound]
    );
    assert.equal(await proven(db,ids),false,
      "a racing provider ID must stop resend");
    await db.query("UPDATE messages SET whatsapp_message_id=NULL WHERE id=$1",[ids.outbound]);

    await db.query("UPDATE inbound_outbound_attempts SET outcome='ambiguous' WHERE assistant_message_id=$1",
      [ids.outbound]);
    assert.equal(await proven(db,ids),false,
      "uncertain original outbound cannot be retried");
  });
});

test("real PostgreSQL: secondary started exception excludes primary, wrong codes, staff and new customer turns",{
  skip:!connectionString,
},async()=>{
  await withIsolatedDatabase(async({db})=>{
    const ids=await seedRetry(db);
    await db.query(
      "UPDATE whatsapp_outbound_retries SET processing_kind='send_started' WHERE id=$1",
      [ids.retryId]
    );
    assert.ok(await eligible(db,ids,true));
    await db.query(
      "UPDATE whatsapp_outbound_retries SET last_error='ordinary provider error' WHERE id=$1",
      [ids.retryId]
    );
    assert.equal(await eligible(db,ids,true),null,
      "secondary started bypass requires the stable code");
    await db.query("UPDATE whatsapp_outbound_retries SET last_error=$2 WHERE id=$1",
      [ids.retryId,PRE_PROVIDER_CODE]);
    await db.query("UPDATE whatsapp_sender_accounts SET sender_key='neutro' WHERE id=$1",
      [ids.sender]);
    assert.equal(await eligible(db,ids,true),null,
      "primary sender cannot use secondary started bypass");
    await db.query("UPDATE whatsapp_sender_accounts SET sender_key='neutro_secondary' WHERE id=$1",
      [ids.sender]);

    await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
      "VALUES($1,'user','new question','wamid.new-question')",
      [ids.contact]
    );
    assert.equal((await eligible(db,ids,true)).has_newer_customer_message,true);
    await db.query(
      "INSERT INTO messages(contact_id,role,content,sent_by_username,delivery_status) "+
      "VALUES($1,'assistant','Staff took over','staff','sent')",
      [ids.contact]
    );
    assert.equal((await eligible(db,ids,true)).has_newer_staff_message,true);
    await db.query(
      "UPDATE messages SET created_at=NOW()-INTERVAL '11 minutes' WHERE id=$1",
      [ids.outbound]
    );
    assert.equal(secondaryRetryFresh(await eligible(db,ids,true)),false,
      "stale messages cannot use a wider service window");
    assert.equal(SECONDARY_RETRY_MAX_AGE_MS,600000);
  });
});
