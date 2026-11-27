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
    },{database,env:{...env,
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:s.original.reservationId}});
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
    // A signed, sender-matched FAILED delivery is already sufficient proof
    // to permit a different new message. No manual reviewer UUID is needed.
    const fresh=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:{
      ...env,WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"false",
      WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:"",
    }});
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

test("verified failed delivery does not permit replay or contradictory proof",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    const wamid="wamid.signedFailedAutoGuard";
    await billing.recordSecondaryProviderOutcome({
      reservationId:s.original.reservationId,acceptedWamid:wamid,
    },{database,env});
    await db.query("UPDATE messages SET whatsapp_message_id=$2,delivery_status='failed' WHERE id=$1",
      [s.messages[0],wamid]);
    await db.query(
      "UPDATE whatsapp_sender_billing_attempts SET state='unknown' WHERE reservation_id=$1",
      [s.original.reservationId]);
    await db.query(
      "UPDATE whatsapp_sender_billing_gates SET state='unknown',updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",
      [s.sender]);
    const noReviewEnv={...env,WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"false"};
    const request=(messageId)=>billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId,
    },{database,env:noReviewEnv});
    assert.equal((await request(s.messages[1])).code,
      "secondary_billing_previous_send_unresolved",
      "no signed failure receipt must deny even when message says failed");
    await db.query(
      "INSERT INTO whatsapp_sender_status_receipts("+
      "fingerprint,sender_id,reservation_id,wamid,wamid_hash,"+
      "delivery_status,meta_phone_number_id,meta_account_id,matched) "+
      "VALUES($1,$2,$3,$4,$5,'failed',$6,$7,TRUE)",
      ["c".repeat(64),s.sender,s.original.reservationId,wamid,
        "d".repeat(64),env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]);
    assert.equal((await request(s.messages[0])).code,
      "secondary_billing_sender_mismatch",
      "old failed provider send never replays itself because WAMID is already set");
    await db.query(
      "UPDATE whatsapp_sender_status_receipts SET pricing_billable=TRUE WHERE reservation_id=$1",
      [s.original.reservationId]);
    assert.equal((await request(s.messages[1])).code,
      "secondary_billing_previous_send_unresolved",
      "known charge remains blocked");
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
    const clause=reviewedDeliveryAttentionSql("c",authorized,"$2");
    const check=async(anchor=null)=> (await db.query(
      "SELECT "+clause+" AS ok FROM contacts c WHERE c.id=$1",
      [s.contact,anchor])).rows[0].ok;
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
    assert.equal(await check(s.messages[0]),false,
      "old outgoing video is never a valid fresh customer anchor");
    assert.equal(await check(inbound),true,
      "a new signed same-sender enquiry may continue with staff alert retained");
    const newReservation=await billing.reserveSecondaryBillingAttempt({
      contactId:s.contact,messageId:s.messages[1],
    },{database,env:authorized});
    assert.equal(newReservation.reserved,true);
    assert.equal(await check(inbound),false,
      "a new in-flight send must settle before additional AI work");
    // Simulate only a correctly reconciled NEW send, never the old original.
    await db.query("UPDATE whatsapp_sender_billing_attempts SET state='reconciled' "+
      "WHERE reservation_id=$1",[newReservation.reservationId]);
    await db.query("UPDATE whatsapp_sender_billing_gates SET state='idle',"+
      "reservation_id=NULL,contact_id=NULL,message_id=NULL,wamid=NULL "+
      "WHERE sender_id=$1 AND owner_contact_id=$2",[s.sender,s.contact]);
    assert.equal(await check(inbound),true,
      "reviewed old delivery attention must not permanently block later replies");
    await db.query("UPDATE contacts SET attention_reason='AI review requested: pending' "+
      "WHERE id=$1",[s.contact]);
    assert.equal(await check(inbound),false,
      "an unrelated clinical or staff review is never bypassed");
    // Mere UNKNOWN/no-WAMID outcomes still cannot resume an old AI thread.
    // The SQL also permits newly sent, verified failed Meta receipts.
    const autoSql=reviewedDeliveryAttentionSql("c",env);
    assert.match(autoSql,/verified_failure\.matched=TRUE/);
    assert.equal((await db.query(
      "SELECT "+autoSql+" AS ok FROM contacts c WHERE c.id=$1",
      [s.contact])).rows[0].ok,false,
      "no-WAMID outcomes never inherit automatic signed-failure recovery");
  });
});

test("Inbox review authorises only one newly composed message by the reviewing administrator", {skip:!connectionString},async()=>{
  const review=require("../src/services/whatsappSecondaryInboxReviewService");
  await withSchema(async({db,database})=>{
    const s=await seed({db,database});
    await billing.recordSecondaryProviderOutcome({reservationId:s.original.reservationId},{database,env});
    await db.query("UPDATE messages SET delivery_status='unknown' WHERE id=$1",[s.messages[0]]);
    await db.query("UPDATE whatsapp_sender_billing_gates SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",[s.sender]);
    const input={contactId:s.contact,reservationId:s.original.reservationId,actor:"admin",
      reason:"Business App and Billing Hub checked: no delivery or charge.",
      nonDeliveryChecked:true,billingNoChargeChecked:true};
    assert.equal((await review.inspect({contactId:s.contact},{database,env})).eligible,true);
    await assert.rejects(review.approve({...input,billingNoChargeChecked:false},{database,env}),/Confirm non-delivery/);
    await assert.rejects(review.approve({...input,contactId:999999},{database,env}),/hold changed/);
    const approved=await review.approve(input,{database,env});
    assert.deepEqual(approved,{reviewed:true,sendAuthorized:false,originalRetryAllowed:false});
    assert.equal((await db.query("SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",[s.sender])).rows[0].state,"unknown");
    await assert.rejects(review.approve(input,{database,env}),/already reviewed/);
    const conversation=(await db.query("SELECT id FROM whatsapp_sender_conversations WHERE sender_id=$1 AND contact_id=$2",[s.sender,s.contact])).rows[0].id;
    async function newMessage(actor){
      const mid=(await db.query("INSERT INTO messages(contact_id,role,content,sent_by_username) VALUES($1,'assistant','new message',$2) RETURNING id",[s.contact,actor])).rows[0].id;
      await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[mid,conversation]);
      return mid;
    }
    const request=messageId=>billing.reserveSecondaryBillingAttempt({contactId:s.contact,messageId},{database,env});
    assert.equal((await request(s.messages[0])).reserved,false,"never replay original");
    assert.equal((await request(s.messages[1])).reserved,false,"pre-review draft cannot use approval");
    assert.equal((await request(await newMessage(null))).reserved,false,"automation cannot consume manual approval");
    assert.equal((await request(await newMessage("other-admin"))).reserved,false,"different actor cannot use approval");
    const mid=await newMessage("admin");
    const next=await request(mid);
    assert.equal(next.reserved,true);
    assert.equal((await db.query("SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",[s.original.reservationId])).rows[0].state,"unknown");
    assert.equal((await db.query("SELECT new_message_id FROM whatsapp_sender_unknown_gate_new_sends WHERE old_reservation_id=$1",[s.original.reservationId])).rows[0].new_message_id,mid);
    assert.equal((await review.inspect({contactId:s.contact},{database,env})).eligible,false);
    assert.equal((await request(await newMessage("admin"))).reserved,false,"another message cannot bypass an active reservation");
  });
});


test("reviewed unknown follow-up permits only a new verified AI text and preserves the original attempt",
 {skip:!connectionString},async()=>{
 await withSchema(async({db,database})=>{
   const s=await seed({db,database});
   const approvedEnv={...env,WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true"};
   await billing.recordSecondaryProviderOutcome({reservationId:s.original.reservationId},{database,env});
   await db.query("UPDATE messages SET delivery_status='unknown',created_at=NOW()-INTERVAL '1 hour' WHERE id=$1",[s.messages[0]]);
   await db.query("UPDATE whatsapp_sender_billing_gates SET updated_at=NOW()-INTERVAL '40 minutes' WHERE sender_id=$1",[s.sender]);
   const error="An earlier WhatsApp send is unconfirmed. Ask an administrator to review non-delivery and billing before composing a new message.";
   const failed=(await db.query("INSERT INTO messages(contact_id,role,content,delivery_status,delivery_error,created_at) VALUES($1,'assistant','blocked address','failed',$2,NOW()-INTERVAL '20 minutes') RETURNING id",[s.contact,error])).rows[0].id;
   await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE,attention_reason=$2,delivery_attention_message_id=$3 WHERE id=$1",[s.contact,"Delivery failed: "+error,failed]);
   const conv=(await db.query("SELECT id FROM whatsapp_sender_conversations WHERE sender_id=$1 AND contact_id=$2",[s.sender,s.contact])).rows[0].id;
   const inbound=(await db.query("INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) VALUES($1,'user','费用和地址','wamid.freshAI',NOW()-INTERVAL '5 minutes',NOW()-INTERVAL '5 minutes') RETURNING id",[s.contact])).rows[0].id;
   await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[inbound,conv]);
   const fresh=s.messages[1];
   const request=()=>billing.reserveSecondaryBillingAttempt({contactId:s.contact,messageId:fresh,billableAuthorized:true,freshAiInboundMessageId:inbound},{database,env:approvedEnv});
   const check=async(options={},outbound=null)=>{
      const sql=reviewedDeliveryAttentionSql("c",approvedEnv,"$2",options);
      return (await db.query("SELECT "+sql+" AS ok FROM contacts c WHERE c.id=$1",[s.contact,inbound,...(outbound==null?[]:[outbound])])).rows[0].ok;
   };
   assert.equal(await check({allowInboxAiReview:true}),false);
   assert.equal((await request()).reserved,false);
   await db.query("INSERT INTO whatsapp_sender_unknown_gate_inbox_reviews(reservation_id,sender_id,contact_id,old_message_id,actor,reason,non_delivery_checked,billing_no_charge_checked,reviewed_at) VALUES($1,$2,$3,$4,'admin','Verified no delivery or billing charge',TRUE,TRUE,NOW()-INTERVAL '10 minutes')",[s.original.reservationId,s.sender,s.contact,s.messages[0]]);
   assert.equal(await check(),false,"automation cannot initiate a bypass");
   assert.equal(await check({allowInboxAiReview:true}),true);
   await db.query("UPDATE messages SET source_created_at=NOW()-INTERVAL '15 minutes' WHERE id=$1",[inbound]);
   assert.equal(await check({allowInboxAiReview:true}),false);
   assert.equal((await request()).reserved,false,"a pre-review inbound must not be replayed");
   await db.query("UPDATE messages SET source_created_at=NOW()-INTERVAL '5 minutes' WHERE id=$1",[inbound]);
   const next=await request();
   assert.equal(next.reserved,true);
   assert.equal(await check({allowInboxAiReview:true}),false,"other AI work must wait");
   assert.equal(await check({allowInboxAiReview:true,outboundMessageSql:"$3"},fresh),true,"own reserved send remains eligible");
   assert.equal(await check({allowInboxAiReview:true,outboundMessageSql:"$3"},failed),false);
   assert.equal((await db.query("SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",[s.original.reservationId])).rows[0].state,"unknown");
   assert.equal((await db.query("SELECT new_message_id FROM whatsapp_sender_unknown_gate_new_sends WHERE old_reservation_id=$1",[s.original.reservationId])).rows[0].new_message_id,fresh);
 });
});


test("new customer text can automatically recover an uncertain automated service follow-up, never replay it",
 {skip:!connectionString},async()=>{
 await withSchema(async({db,database})=>{
   const s=await seed({db,database});
   const autoEnv={...env,WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true"};
   await billing.recordSecondaryProviderOutcome({reservationId:s.original.reservationId},{database,env});
   await db.query("UPDATE whatsapp_sender_billing_attempts SET billable_authorized=TRUE,billing_authorization_source='operator_acknowledged_service',updated_at=NOW()-INTERVAL '3 minutes' WHERE reservation_id=$1",[s.original.reservationId]);
   await db.query("UPDATE messages SET delivery_status='unknown',is_automated_follow_up=TRUE,whatsapp_template=$2::jsonb,created_at=NOW()-INTERVAL '4 minutes' WHERE id=$1",[s.messages[0],JSON.stringify({automatedSecondaryFollowup:true,senderKey:"neutro_secondary",slotHours:2})]);
   const conv=(await db.query("SELECT id FROM whatsapp_sender_conversations WHERE sender_id=$1 AND contact_id=$2",[s.sender,s.contact])).rows[0].id;
   const oldAnchor=(await db.query("INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) VALUES($1,'user','old enquiry','wamid.oldAnchor',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '2 hours') RETURNING id",[s.contact])).rows[0].id;
   await db.query("INSERT INTO whatsapp_sender_followup_attempts(sender_id,contact_id,anchor_message_id,slot_hours,message_id,status,error_code,completed_at) VALUES($1,$2,$3,2,$4,'unknown','secondary_staff_provider_outcome_unverified',NOW()-INTERVAL '3 minutes')",[s.sender,s.contact,oldAnchor,s.messages[0]]);
   await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE,attention_reason='Delivery unconfirmed: original video',delivery_attention_message_id=$2 WHERE id=$1",[s.contact,s.messages[0]]);
   const inbound=(await db.query("INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) VALUES($1,'user','我想先了解费用和地址在哪里','wamid.newAnchor',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '1 minute') RETURNING id",[s.contact])).rows[0].id;
   await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$3),($2,$3)",[oldAnchor,inbound,conv]);
   const fresh=s.messages[1];
   const request=(config=autoEnv,anchor=inbound,messageId=fresh)=>billing.reserveSecondaryBillingAttempt({contactId:s.contact,messageId,billableAuthorized:true,freshAiInboundMessageId:anchor},{database,env:config});
   const check=async(anchor=inbound,config=autoEnv,options={allowAutomaticFreshReply:true},outbound=null)=>{
     const sql=reviewedDeliveryAttentionSql("c",config,"$2",options);
     return (await db.query("SELECT "+sql+" AS ok FROM contacts c WHERE c.id=$1",[s.contact,anchor,...(outbound==null?[]:[outbound])])).rows[0].ok;
   };
   assert.equal(await check(),true,"fresh inquiry may proceed even before 30 minutes");
   assert.equal(await check(oldAnchor),false);
   assert.equal(await check(inbound,{...autoEnv,WHATSAPP_SECONDARY_AUTO_FRESH_REPLY_AFTER_UNKNOWN_FOLLOWUP:"false"}),false);
   assert.equal(await check(inbound,autoEnv,{}),false,"no scheduled or media bypass");
   assert.equal((await request({...autoEnv,WHATSAPP_SECONDARY_AUTO_FRESH_REPLY_AFTER_UNKNOWN_FOLLOWUP:"false"})).reserved,false);
   assert.equal((await request(autoEnv,oldAnchor)).reserved,false);
   assert.equal((await request(autoEnv,inbound,s.messages[0])).reserved,false);
   await db.query("UPDATE messages SET is_forwarded=TRUE WHERE id=$1",[inbound]);
   assert.equal(await check(),false);
   assert.equal((await request()).reserved,false);
   await db.query("UPDATE messages SET is_forwarded=FALSE WHERE id=$1",[inbound]);
   await db.query("UPDATE whatsapp_sender_followup_attempts SET error_code='other_unknown' WHERE message_id=$1",[s.messages[0]]);
   assert.equal(await check(),false);
   assert.equal((await request()).reserved,false);
   for(const code of ["secondary_staff_unconfirmed","sender_followup_delivery_unconfirmed","sender_followup_after_save_provider_dispatch","sender_followup_after_save_provider_result_persist","secondary_staff_billing_outcome_unverified_no_wamid"]){
     await db.query("UPDATE whatsapp_sender_followup_attempts SET error_code=$2 WHERE message_id=$1",[s.messages[0],code]);
     assert.equal(await check(),true,code);
   }
   await db.query("UPDATE whatsapp_sender_followup_attempts SET error_code='secondary_staff_provider_outcome_unverified' WHERE message_id=$1",[s.messages[0]]);
   const next=await request();
   assert.equal(next.reserved,true);
   assert.equal(await check(),false,"other work cannot proceed during this reservation");
   assert.equal(await check(inbound,autoEnv,{allowAutomaticFreshReply:true,outboundMessageSql:"$3"},fresh),true);
   assert.equal(await check(inbound,autoEnv,{allowAutomaticFreshReply:true,outboundMessageSql:"$3"},s.messages[0]),false);
   assert.equal((await db.query("SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",[s.original.reservationId])).rows[0].state,"unknown");
   assert.equal((await db.query("SELECT status FROM whatsapp_sender_followup_attempts WHERE message_id=$1",[s.messages[0]])).rows[0].status,"unknown");
   assert.equal((await db.query("SELECT new_message_id,basis FROM whatsapp_sender_unknown_gate_new_sends WHERE old_reservation_id=$1",[s.original.reservationId])).rows[0].new_message_id,fresh);
   assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_sender_unknown_gate_inbox_reviews")).rows[0].count,0,"never invent administrator evidence");
   assert.deepEqual((await db.query("SELECT authorization_source,recovery_inbound_message_id FROM whatsapp_sender_unknown_gate_new_sends WHERE old_reservation_id=$1",[s.original.reservationId])).rows[0],{authorization_source:"automatic_fresh_service_reply",recovery_inbound_message_id:inbound});
   // The new text can be accepted before its pricing receipt arrives. Queue
   // retention must not grant dispatch authority, or authorize an old anchor.
   const processing=(await db.query("INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) VALUES($1,$2,'whatsapp','{}','completed') RETURNING id",[inbound,s.contact])).rows[0].id;
   await db.query("INSERT INTO inbound_outbound_attempts(processing_job_id,inbound_message_id,assistant_message_id,contact_id,origin,outcome,provider_message_id) VALUES($1,$2,$3,$4,'ai_reply','accepted','wamid.recoveredFresh')",[processing,inbound,fresh,s.contact]);
   const accepted=await billing.recordSecondaryProviderOutcome({reservationId:next.reservationId,acceptedWamid:"wamid.recoveredFresh"},{database,env:autoEnv});
   assert.equal(accepted.state,"awaiting_pricing");
   const queue=require("../src/services/whatsappSecondaryAiMediaQueue");
   const queueEnv={...autoEnv,
     WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
     WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
     WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
     WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
     WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
     WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-01-01T00:00:00Z",
     WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-01-01T00:00:00Z",
     WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-01-01T00:00:00Z"};
   assert.equal(await check(inbound,autoEnv,{allowMediaQueueWait:true}),true);
   assert.equal(await check(inbound,autoEnv,{}),false,"queue retention never authorizes dispatch before settlement");
   assert.equal(await queue.enqueue({contactId:s.contact,inboundMessageId:inbound,kind:"promotion",solicitedPricing:true,
     items:[{imageUrl:"https://example.test/package-a.png",caption:"Package A RM388"},
            {imageUrl:"https://example.test/package-b.png",caption:"Package B RM268"}]},
     {database,env:queueEnv}),true,"both selected pricing images are durably queued while text settles");
   assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_sender_ai_media_jobs WHERE inbound_message_id=$1 AND state='pending'",[inbound])).rows[0].count,2);
   assert.equal(await check(oldAnchor,autoEnv,{allowMediaQueueWait:true}),false);
   const receiptService=require("../src/services/whatsappSecondaryReceiptService");
   const crypto=require("node:crypto");
   const receiptEnv={...autoEnv,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
     WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
     WHATSAPP_APP_SECRET:"test-recovery-status-secret"};
   const rawBody=Buffer.from(JSON.stringify({object:"whatsapp_business_account",entry:[{
     id:receiptEnv.WHATSAPP_SECONDARY_WABA_ID,changes:[{field:"messages",value:{
       metadata:{phone_number_id:receiptEnv.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},statuses:[{
         id:"wamid.recoveredFresh",status:"delivered",recipient_id:"60125550000",
         timestamp:String(Math.floor(Date.now()/1000)),
         pricing:{type:"free_entry_point",billable:false,category:"service"},
       }],
     }}],
   }]}));
   const receipt=await receiptService.recordSignedSecondaryStatusBatch({rawBody,
     signatureHeader:"sha256="+crypto.createHmac("sha256",receiptEnv.WHATSAPP_APP_SECRET).update(rawBody).digest("hex")},{database,env:receiptEnv});
   assert.equal(receipt.autoReconciled,1);
   assert.equal((await db.query("SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1 AND owner_contact_id=$2",[s.sender,s.contact])).rows[0].state,"idle");
   assert.equal(await check(inbound,autoEnv,{}),true,"new-anchor pricing media may use normal eligibility after text settles");
   assert.equal(await check(oldAnchor,autoEnv,{}),false,"original follow-up anchor remains blocked");
   const {automaticRecoveryBudgetSql}=require("../src/utils/whatsappSecondaryReviewedUnknownSend");
   const budget=async()=> (await db.query("SELECT "+automaticRecoveryBudgetSql("a")+" AS ok FROM whatsapp_sender_billing_attempts a WHERE a.reservation_id=$1",[s.original.reservationId])).rows[0].ok;
   assert.equal(await budget(),false,"same-day repeat is bounded");
   await db.query("UPDATE whatsapp_sender_unknown_gate_new_sends SET reopened_at=NOW()-INTERVAL '25 hours' WHERE old_reservation_id=$1",[s.original.reservationId]);
   assert.equal(await budget(),true,"a later separate incident is no longer blocked for a full month after the new reply settles");
   await db.query("UPDATE whatsapp_sender_billing_attempts SET state='unknown' WHERE reservation_id=$1",[next.reservationId]);
   assert.equal(await budget(),false,"never stack unresolved recovery replies");
   await db.query("UPDATE whatsapp_sender_billing_attempts SET state='reconciled' WHERE reservation_id=$1",[next.reservationId]);
 });
});
