"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const billing = require("../src/db/whatsappSenderBillingGateRepo");
const receipts = require("../src/services/whatsappSecondaryReceiptService");
const settlement = require("../src/services/whatsappSecondaryReconciliationService");

const connectionString = process.env.TEST_DATABASE_URL;
const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED: "true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED: "true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED: "true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_WABA_ID: "200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "100000000000002",
  WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
  WHATSAPP_APP_SECRET: "test-signed-status-secret",
};
function signed(status, { account = env.WHATSAPP_SECONDARY_WABA_ID,
  phone = env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID } = {}) {
  const data = {
    object:"whatsapp_business_account",entry:[{
      id:account,changes:[{field:"messages",value:{
        metadata:{ phone_number_id:phone },statuses:[status],
      }}],
    }],
  };
  const rawBody=Buffer.from(JSON.stringify(data));
  return {rawBody,signatureHeader:"sha256="+crypto.createHmac("sha256",env.WHATSAPP_APP_SECRET)
    .update(rawBody).digest("hex")};
}
function st(wamid, properties={}) {
  return {id:wamid,status:"delivered",recipient_id:"60125550000",
    timestamp:"1792657000",pricing:{type:"free_entry_point",billable:false,category:"service"},
    ...properties};
}

async function withSchema(run) {
  const db = new Client({connectionString});
  const schema = "sender_receipts_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const database = {
      async connect() {
        const c = new Client({connectionString});
        await c.connect();
        await c.query("SET search_path TO "+schema);
        return {query:(...args)=>c.query(...args),release:()=>c.end()};
      },
      query:(...args)=>db.query(...args),
    };
    await runMigrations(database,{quiet:true});
    await run({db,database});
  } finally {
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
}

async function seededSend(db,database) {
  const senders=(await db.query(
    "INSERT INTO whatsapp_sender_accounts " +
    "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) VALUES " +
    "('neutro','100000000000001','200000000000001','Neutro','active')," +
    "('ariel','100000000000002','200000000000002','Ariel','active') " +
    "RETURNING id,sender_key"
  )).rows;
  const ids=Object.fromEntries(senders.map(x=>[x.sender_key,x.id]));
  const contacts=(await db.query(
    "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) " +
    "VALUES('60125550000',$1),('60125550000',$2) RETURNING id",
    [ids.neutro,ids.ariel]
  )).rows;
  const conversations=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
    "VALUES($1,'60125550000',$3,'bound'),($2,'60125550000',$4,'bound') " +
    "RETURNING id",
    [ids.neutro,ids.ariel,contacts[0].id,contacts[1].id]
  )).rows;
  const messages=(await db.query(
    "INSERT INTO messages(contact_id,role,content) " +
    "VALUES($1,'assistant','Neutro message'),($2,'assistant','Ariel message') " +
    "RETURNING id",
    [contacts[0].id,contacts[1].id]
  )).rows;
  await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) " +
    "VALUES($1,$3),($2,$4)",
    [messages[0].id,messages[1].id,conversations[0].id,conversations[1].id]
  );
  const reservation=await billing.reserveSecondaryBillingAttempt({
    contactId:contacts[1].id,messageId:messages[1].id,
  },{database,env});
  assert.equal(reservation.reserved,true);
  assert.equal((await billing.recordSecondaryProviderOutcome({
    reservationId:reservation.reservationId,acceptedWamid:"wamid.ariel-one",
  },{database,env})).state,"awaiting_pricing");
  return {ids,contacts,messages,reservation};
}

test("migration 084 is repeatable and keeps both customer senders separate",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      assert.equal(loadMigrations().at(-1).version,87);
      assert.equal((await runMigrations(database,{quiet:true})).appliedCount,0);
      const inserted=await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_status_receipts");
      assert.equal(inserted.rows[0].n,0);
      await seededSend(db,database);
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate")).rows[0].n,0);
    });
  });

test("signed Ariel callbacks are durable, idempotent, receiver-specific and do not release billing",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      const {ids,contacts,messages,reservation}=await seededSend(db,database);
      const event=st("wamid.ariel-one");
      const first=await receipts.recordSignedSecondaryStatusBatch(signed(event),{database,env});
      assert.deepEqual(first,{
        accepted:true,sendAuthorized:false,autoRetryAllowed:false,
        matched:1,unmatched:0,replayed:0,held:0,
      });
      const replay=await receipts.recordSignedSecondaryStatusBatch(signed(event),{database,env});
      assert.equal(replay.replayed,1);
      const rows=(await db.query(
        "SELECT sender_id,reservation_id,wamid,matched,pricing_billable " +
        "FROM whatsapp_sender_status_receipts"
      )).rows;
      assert.equal(rows.length,1);
      assert.equal(String(rows[0].sender_id),String(ids.ariel));
      assert.equal(rows[0].reservation_id,reservation.reservationId);
      assert.equal(rows[0].pricing_billable,false);
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
        [ids.ariel]
      )).rows[0].state,"awaiting_pricing");
      assert.equal((await billing.reserveSecondaryBillingAttempt({
        contactId:contacts[1].id,messageId:messages[1].id,
      },{database,env})).reserved,false);
      const retry=await receipts.inspectSecondaryRetryHold(reservation.reservationId,{database,env});
      assert.equal(retry.canAutoRetry,false);
      assert.equal(retry.code,"secondary_retry_waiting_pricing");

      const wrongRecipient=await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one",{recipient_id:"60127779999"})),{database,env});
      assert.equal(wrongRecipient.unmatched,1);
      const audit=(await db.query(
        "SELECT matched,wamid,wamid_hash FROM whatsapp_sender_status_receipts WHERE NOT matched"
      )).rows;
      assert.equal(audit.length,1);
      assert.equal(audit[0].wamid,null);
      assert.match(audit[0].wamid_hash,/^[a-f0-9]{64}$/);

      const primary=await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one"),{
          account:env.WHATSAPP_WABA_ID,phone:env.WHATSAPP_PHONE_NUMBER_ID,
        }),{database,env});
      assert.equal(primary.code,"secondary_receipt_batch_invalid");
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_sender_status_receipts"
      )).rows[0].n,2);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_free_entry_pricing_evidence"
      )).rows[0].n,0,"Neutro receipt storage must remain unaffected");
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_outbound_retries"
      )).rows[0].n,0,"Neutro outbound retry queue must remain unaffected");
    });
  });

test("billable or failed Ariel statuses force a durable, non-retryable hold",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      const {ids,reservation}=await seededSend(db,database);
      const failed=await receipts.recordSignedSecondaryStatusBatch(signed(st(
        "wamid.ariel-one",{status:"failed",pricing:{type:"regular",billable:true}}
      )),{database,env});
      assert.equal(failed.held,1);
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
        [ids.ariel]
      )).rows[0].state,"unknown");
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
        [reservation.reservationId]
      )).rows[0].state,"unknown");
      const lateFree=await receipts.recordSignedSecondaryStatusBatch(signed(st(
        "wamid.ariel-one",{status:"read"}
      )),{database,env});
      assert.equal(lateFree.matched,1);
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
        [ids.ariel]
      )).rows[0].state,"unknown");
      const retry=await receipts.inspectSecondaryRetryHold(reservation.reservationId,{database,env});
      assert.equal(retry.canAutoRetry,false);
      assert.equal(retry.code,"secondary_retry_adverse_receipt");
    });
  });


const review = (reservationId, receiptFingerprint) => ({
  reservationId, receiptFingerprint,
  reviewer: "verified-test-operator",
  reason: "Verified this exact Ariel message and charge status in Meta Billing Hub.",
  billingHubConfirmed: true,
});

test("manual settlement only clears a verified Ariel receipt and never authorizes retry",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      const {ids,reservation,contacts}=await seededSend(db,database);
      const packet=signed(st("wamid.ariel-one"));
      const receiptResult=await receipts.recordSignedSecondaryStatusBatch(packet,{database,env});
      assert.equal(receiptResult.matched,1);
      const fingerprint=(await db.query(
        "SELECT fingerprint FROM whatsapp_sender_status_receipts WHERE matched=true"
      )).rows[0].fingerprint;
      const disabled=await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,fingerprint),
        {database,env:{...env,WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"false"}}
      );
      assert.equal(disabled.code,"secondary_reconciliation_disabled");
      const wrong=await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,"a".repeat(64)),{database,env});
      assert.equal(wrong.code,"secondary_reconciliation_evidence_unverified");
      const invalid=await settlement.reconcileVerifiedSecondaryNonbillable(
        {...review(reservation.reservationId,fingerprint),billingHubConfirmed:false},{database,env});
      assert.equal(invalid.code,"secondary_reconciliation_review_required");
      const success=await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,fingerprint),{database,env});
      assert.deepEqual(success,{reconciled:true,sendAuthorized:false,autoRetryAllowed:false});
      const gate=(await db.query(
        "SELECT state,reservation_id,wamid FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
        [ids.ariel]
      )).rows[0];
      assert.equal(gate.state,"idle");
      assert.equal(gate.reservation_id,null);
      assert.equal(gate.wamid,null);
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
        [reservation.reservationId]
      )).rows[0].state,"reconciled");
      assert.equal((await db.query(
        "SELECT reviewer,billing_hub_confirmed FROM whatsapp_sender_billing_reconciliations"
      )).rows[0].billing_hub_confirmed,true);
      const replay=await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,fingerprint),{database,env});
      assert.equal(replay.reconciled,false);
      const msg=(await db.query(
        "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','new draft') RETURNING id",
        [contacts[1].id]
      )).rows[0].id;
      const conversation=(await db.query(
        "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
        [contacts[1].id]
      )).rows[0].id;
      await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [msg,conversation]);
      const next=await billing.reserveSecondaryBillingAttempt(
        {contactId:contacts[1].id,messageId:msg},{database,env});
      assert.equal(next.reserved,true);
      // Crucial: the old WAMID remains identifiable AFTER settlement and
      // after a new pending reservation exists. It must latch the sender alarm.
      const late=await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one",{
          status:"read",pricing:{type:"regular",billable:true,category:"marketing"},
        })),{database,env});
      assert.equal(late.matched,1);
      assert.equal(late.held,1);
      const alarm=(await db.query(
        "SELECT reason,reservation_id FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
        [ids.ariel]
      )).rows[0];
      assert.equal(alarm.reason,"provider_billable");
      assert.equal(alarm.reservation_id,reservation.reservationId);
      // New reservation remains unresolved, and a later idle state cannot
      // bypass the latched sender alarm even if someone clears the gate.
      const newMsg=(await db.query(
        "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','third draft') RETURNING id",
        [contacts[1].id]
      )).rows[0].id;
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [newMsg,conversation]
      );
      const blocked=await billing.reserveSecondaryBillingAttempt(
        {contactId:contacts[1].id,messageId:newMsg},{database,env});
      assert.equal(blocked.reserved,false);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
      )).rows[0].n,0,"Neutro billing records stay unchanged");
    });
  });

test("unmatched recipient or contradictory receipts prevent sender settlement",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      const {reservation}=await seededSend(db,database);
      const bad=await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one",{recipient_id:"60124440000"})),{database,env});
      assert.equal(bad.unmatched,1);
      const good=await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one",{status:"read"})),{database,env});
      assert.equal(good.matched,1);
      const fingerprint=(await db.query(
        "SELECT fingerprint FROM whatsapp_sender_status_receipts WHERE matched=true"
      )).rows[0].fingerprint;
      const blocked=await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,fingerprint),{database,env});
      assert.equal(blocked.code,"secondary_reconciliation_evidence_unverified");
      assert.equal((await db.query(
        "SELECT state FROM whatsapp_sender_billing_gates"
      )).rows[0].state,"awaiting_pricing");
    });
  });


test("late billable receipt after gate is idle prohibits a fresh Ariel reservation",
  {skip:!connectionString},async()=>{
    await withSchema(async({db,database})=>{
      const {contacts,reservation}=await seededSend(db,database);
      assert.equal((await receipts.recordSignedSecondaryStatusBatch(
        signed(st("wamid.ariel-one")),{database,env})).matched,1);
      const fp=(await db.query(
        "SELECT fingerprint FROM whatsapp_sender_status_receipts WHERE matched=true"
      )).rows[0].fingerprint;
      assert.equal((await settlement.reconcileVerifiedSecondaryNonbillable(
        review(reservation.reservationId,fp),{database,env}
      )).reconciled,true);
      const late=await receipts.recordSignedSecondaryStatusBatch(signed(st(
        "wamid.ariel-one",{
          status:"read",pricing:{type:"regular",billable:true,category:"service"},
        }
      )),{database,env});
      assert.equal(late.held,1);
      const message=(await db.query(
        "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','fresh draft') RETURNING id",
        [contacts[1].id]
      )).rows[0].id;
      const conversation=(await db.query(
        "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
        [contacts[1].id]
      )).rows[0].id;
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [message,conversation]
      );
      const result=await billing.reserveSecondaryBillingAttempt(
        {contactId:contacts[1].id,messageId:message},{database,env});
      assert.equal(result.code,"secondary_billing_sender_alarm");
      assert.equal(result.reserved,false);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_reconciliations"
      )).rows[0].n,1);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
      )).rows[0].n,0);
    });
  });
