"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const billing=require("../src/db/whatsappSenderBillingGateRepo");
const {reviewedDeliveryAttentionSql}=require("../src/utils/whatsappSecondaryReviewedUnknownSend");
const connectionString=process.env.TEST_DATABASE_URL;
const env={
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
  WHATSAPP_WABA_ID:"200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"true",
};

async function withSchema(callback){
  const db=new Client({connectionString});
  const schema="unknown_new_send_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const database={
      async connect(){
        const c=new Client({connectionString});
        await c.connect();
        await c.query("SET search_path TO "+schema);
        return {query:(...a)=>c.query(...a),release:()=>c.end()};
      },
      query:(...a)=>db.query(...a),
    };
    await runMigrations(database,{quiet:true});
    await callback({db,database});
  } finally {
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
}
async function seed({db,database}){
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts "+
    "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES('neutro_secondary','100000000000002','200000000000002','Secondary','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
    "VALUES('whatsapp','60125550000',$1) RETURNING id",[sender]
  )).rows[0].id;
  const conversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
    "VALUES($1,'60125550000',$2,'bound') RETURNING id",[sender,contact]
  )).rows[0].id;
  const messages=(await db.query(
    "INSERT INTO messages(contact_id,role,content) "+
    "VALUES($1,'assistant','old media'),($1,'assistant','new media') RETURNING id",
    [contact]
  )).rows.map(row=>row.id);
  await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) "+
    "VALUES($1,$3),($2,$3)",[...messages,conversation]
  );
  const original=await billing.reserveSecondaryBillingAttempt({
    contactId:contact,messageId:messages[0],
  },{database,env});
  assert.equal(original.reserved,true);
  return {sender,contact,messages,original};
}
test("new message can bypass only an aged no-WAMID UNKNOWN hold with a durable audit",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    const outcome=await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,
    },{database,env});
    assert.equal(outcome.state,"unknown");
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",
      [s.messages[0]]);
    await db.query(
      "UPDATE whatsapp_sender_billing_gates "+
      "SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]
    );
    const disabled=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{...env,WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"false"}});
    assert.equal(disabled.code,"secondary_billing_previous_send_unresolved");
    const repeat=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[0],
    },{database,env});
    assert.equal(repeat.code,"secondary_billing_previous_send_unresolved");
    // Even a failed/unconfirmed message cannot bypass an UNKNOWN hold
    // without an exact operator-reviewed reservation.
    const unreviewed=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env});
    assert.equal(unreviewed.code,"secondary_billing_unknown_hold_not_reviewed");
    const next=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId}});
    assert.equal(next.reserved,true);
    assert.notEqual(next.reservationId,s.original.reservationId);
    const original=(await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [s.original.reservationId])).rows[0];
    assert.equal(original.state,"unknown");
    const audit=(await db.query(
      "SELECT old_message_id,new_message_id,basis FROM "+
      "whatsapp_sender_unknown_gate_new_sends WHERE old_reservation_id=$1",
      [s.original.reservationId])).rows[0];
    assert.deepEqual(audit,{old_message_id:s.messages[0],
      new_message_id:s.messages[1],basis:"unconfirmed_no_wamid"});
    const gate=(await db.query(
      "SELECT state,reservation_id,message_id FROM whatsapp_sender_billing_gates "+
      "WHERE sender_id=$1 AND owner_contact_id=$2",[s.sender,s.contact])).rows[0];
    assert.equal(gate.state,"reserved");
    assert.equal(gate.reservation_id,next.reservationId);
    assert.equal(gate.message_id,s.messages[1]);
  });
});
test("new-send bypass never ignores fresh, accepted, contradictory or globally-alarmed gates",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,
    },{database,env});
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",
      [s.messages[0]]);
    const request=()=>billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId}});
    assert.equal((await request()).code,"secondary_billing_previous_send_unresolved",
      "new unknown hold must not be bypassed immediately");
    await db.query("UPDATE whatsapp_sender_billing_gates "+
      "SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]);
    await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",
      [s.messages[0]]);
    assert.equal((await request()).code,"secondary_billing_previous_send_unresolved",
      "historically delivered old message must remain blocked");
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",
      [s.messages[0]]);
    await db.query("UPDATE whatsapp_sender_billing_attempts SET wamid='wamid.abc' "+
      "WHERE reservation_id=$1",[s.original.reservationId]);
    assert.equal((await request()).code,"secondary_billing_previous_send_unresolved",
      "old WAMID without verified failed receipt must remain blocked");
    await db.query("UPDATE whatsapp_sender_billing_attempts SET wamid=NULL "+
      "WHERE reservation_id=$1",[s.original.reservationId]);
    // The sender-wide alarm is an absolute stop even if this contact's
    // former unknown hold is otherwise eligible for a new message.
    await db.query(
      "INSERT INTO whatsapp_sender_billing_alarms(sender_id,reason,latest_wamid_hash) "+
      "VALUES($1,'provider_delivery_failed',$2)",
      [s.sender,"a".repeat(64)]);
    assert.equal((await request()).code,"secondary_billing_sender_alarm");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS count FROM whatsapp_sender_unknown_gate_new_sends"
    )).rows[0].count,0);
  });
});

test("signed failed original video can be bypassed for one fresh media message",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    const wamid="wamid.verifiedFailureABC";
    const accepted=await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,acceptedWamid:wamid,
    },{database,env});
    assert.equal(accepted.state,"awaiting_pricing");
    await db.query(
      "UPDATE messages SET whatsapp_message_id=$2,delivery_status='failed' "+
      "WHERE id=$1",[s.messages[0],wamid]
    );
    await db.query(
      "UPDATE whatsapp_sender_billing_attempts SET state='unknown' "+
      "WHERE reservation_id=$1",[s.original.reservationId]
    );
    await db.query(
      "UPDATE whatsapp_sender_billing_gates SET state='unknown',"+
      "updated_at=NOW()-INTERVAL '40 minutes' "+
      "WHERE sender_id=$1",[s.sender]
    );
    await db.query(
      "INSERT INTO whatsapp_sender_status_receipts("+
      "fingerprint,sender_id,reservation_id,wamid,wamid_hash,"+
      "delivery_status,meta_phone_number_id,meta_account_id,matched) "+
      "VALUES($1,$2,$3,$4,$5,'failed',$6,$7,TRUE)",
      ["a".repeat(64),s.sender,s.original.reservationId,wamid,
        "b".repeat(64),env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
    );
    const fresh=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId}});
    assert.equal(fresh.reserved,true);
    const audit=(await db.query(
      "SELECT basis FROM whatsapp_sender_unknown_gate_new_sends "+
      "WHERE old_reservation_id=$1",[s.original.reservationId]
    )).rows[0];
    assert.equal(audit.basis,"signed_failed");
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [s.original.reservationId]
    )).rows[0].state,"unknown");
  });
});

test("a second UNKNOWN attempt cannot get another bypass in the same 30-day period",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,
    },{database,env});
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",
      [s.messages[0]]);
    await db.query("UPDATE whatsapp_sender_billing_gates "+
      "SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]);
    const first=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId}});
    assert.equal(first.reserved,true);
    await billing.recordSecondaryProviderOutcome({reservationId:first.reservationId},
      {database,env});
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",
      [s.messages[1]]);
    await db.query("UPDATE whatsapp_sender_billing_gates "+
      "SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]);
    const third=(await db.query(
      "INSERT INTO messages(contact_id,role,content) "+
      "VALUES($1,'assistant','new distinct follow-up') RETURNING id",
      [s.contact])).rows[0].id;
    const conversation=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations "+
      "WHERE sender_id=$1 AND contact_id=$2",[s.sender,s.contact])).rows[0].id;
    await db.query("INSERT INTO whatsapp_sender_message_context "+
      "(message_id,conversation_id) VALUES($1,$2)",[third,conversation]);
    const repeat=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:third,
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:first.reservationId}});
    assert.equal(repeat.code,"secondary_billing_previous_send_unresolved");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_unknown_gate_new_sends "+
      "WHERE sender_id=$1 AND contact_id=$2",[s.sender,s.contact])).rows[0].n,1);
  });
});

test("verified customer return can resume AI only for exactly reviewed old delivery attention",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,
    },{database,env});
    await db.query("UPDATE messages SET delivery_status='unknown',"+
      "created_at=NOW()-INTERVAL '2 days' WHERE id=$1",[s.messages[0]]);
    await db.query("UPDATE whatsapp_sender_billing_gates "+
      "SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]);
    await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE,"+
      "attention_reason='Delivery unconfirmed: review original video',"+
      "delivery_attention_message_id=$2 WHERE id=$1",
      [s.contact,s.messages[0]]);
    const authorized={...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId};
    const clause=reviewedDeliveryAttentionSql("c",authorized);
    const check=async()=> (await db.query(
      "SELECT "+clause+" AS ok FROM contacts c WHERE c.id=$1",
      [s.contact])).rows[0].ok;
    assert.equal(await check(),false,"a stale alert is not automatically ignored");
    const inbound=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,"+
      "source_created_at) VALUES($1,'user','想了解新的疗程',"+
      "'wamid.fresh-customer',NOW()) RETURNING id",
      [s.contact])).rows[0].id;
    const conversation=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations WHERE sender_id=$1"+
      " AND contact_id=$2",[s.sender,s.contact])).rows[0].id;
    await db.query("INSERT INTO whatsapp_sender_message_context "+
      "(message_id,conversation_id) VALUES($1,$2)",
      [inbound,conversation]);
    assert.equal(await check(),true,
      "a new signed same-sender enquiry may continue with staff alert retained");
    await db.query("UPDATE contacts SET attention_reason='AI review requested: pending' "+
      "WHERE id=$1",[s.contact]);
    assert.equal(await check(),false,
      "an unrelated clinical or staff review is never bypassed");
    assert.equal(reviewedDeliveryAttentionSql("c",env),"FALSE",
      "unreviewed production configuration must fail closed");
  });
});
