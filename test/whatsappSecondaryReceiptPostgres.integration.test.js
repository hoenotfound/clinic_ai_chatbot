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
      assert.equal(loadMigrations().at(-1).version,97);
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


test("signed nonbillable Ariel receipt auto-reconciles only when explicitly enabled",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,reservation,contacts}=await seededSend(db,database);
    const autoEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
    const recorded=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:autoEnv});
    assert.equal(recorded.matched,1);
    assert.equal(recorded.autoReconciled,1);
    const settled=(await db.query(
      "SELECT state,reservation_id FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0];
    assert.equal(settled.state,"idle");
    assert.equal(settled.reservation_id,null);
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [reservation.reservationId]
    )).rows[0].state,"reconciled");
    const audit=(await db.query(
      "SELECT method FROM whatsapp_sender_auto_reconciliations WHERE reservation_id=$1",
      [reservation.reservationId]
    )).rows[0];
    assert.equal(audit.method,"signed_meta_nonbillable_free_entry");
    const oldReceipt=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:autoEnv});
    assert.equal(oldReceipt.replayed,1);
    assert.equal(oldReceipt.autoReconciled,0);
    const late=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-one",{
        status:"read",pricing:{type:"regular",billable:true,category:"service"},
      }
    )),{database,env:autoEnv});
    assert.equal(late.matched,1);
    assert.equal(late.held,1);
    const msg=(await db.query(
      "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','new text') RETURNING id",
      [contacts[1].id]
    )).rows[0].id;
    const conv=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [msg,conv]
    );
    const next=await billing.reserveSecondaryBillingAttempt(
      {contactId:contacts[1].id,messageId:msg},{database,env:autoEnv});
    assert.equal(next.code,"secondary_billing_sender_alarm");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});

test("explicit nonbillable receipt never overrides prior wrong recipient evidence",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids}=await seededSend(db,database);
    const autoEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
    assert.equal((await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{recipient_id:"60124440000"})),
      {database,env:autoEnv})).unmatched,1);
    const actual=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:autoEnv});
    assert.equal(actual.autoReconciled,0);
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0].state,"awaiting_pricing");
  });
});


test("a one-time staff-reviewed template may settle a signed legitimate Meta charge without clearing unexpected charges",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,contacts,reservation}=await seededSend(db,database);
    const paidEnv={
      ...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
      WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
    };
    const first=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:paidEnv});
    assert.equal(first.autoReconciled,1);

    const hash="a".repeat(64), signature="b".repeat(64);
    const name="ariel_followup",lang="en_US";
    await db.query(
      `INSERT INTO whatsapp_manual_template_billing_claims
         (token_hash,contact_id,staff_username,template_name,language_code)
       VALUES($1,$2,$3,$4,$5)`,
      [hash,contacts[1].id,"test-staff",name,lang]
    );
    const metadata={name,language:lang,category:"UTILITY",
      billingAcknowledged:true,billingReviewClaimHash:hash,
      templateSignature:signature};
    const next=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_template) " +
      "VALUES($1,'assistant','Approved template',$2::jsonb) RETURNING id",
      [contacts[1].id,JSON.stringify(metadata)]
    )).rows[0].id;
    const conversation=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [next,conversation]
    );
    const wrongSig=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:next,
      billableAuthorized:true,expectedTemplateSignature:"c".repeat(64),
    },{database,env:paidEnv});
    assert.equal(wrongSig.code,"secondary_billing_template_review_unverified");
    const review=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:next,
      billableAuthorized:true,expectedTemplateSignature:signature,
    },{database,env:paidEnv});
    assert.equal(review.reserved,true);
    assert.equal((await billing.recordSecondaryProviderOutcome({
      reservationId:review.reservationId,acceptedWamid:"wamid.ariel-paid",
    },{database,env:paidEnv})).state,"awaiting_pricing");
    const accepted=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-paid",{
        status:"sent",
        pricing:{type:"regular",billable:true,category:"utility"},
      }
    )),{database,env:paidEnv});
    assert.equal(accepted.autoReconciled,1);
    assert.equal(accepted.held,0);
    const recorded=(await db.query(
      "SELECT method,pricing_billable FROM whatsapp_sender_auto_reconciliations " +
      "WHERE reservation_id=$1",
      [review.reservationId]
    )).rows[0];
    assert.equal(recorded.method,"signed_meta_staff_authorized_charge");
    assert.equal(recorded.pricing_billable,true);
    const later=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-paid",{
        status:"read",
        pricing:{type:"regular",billable:true,category:"utility"},
      }
    )),{database,env:paidEnv});
    assert.equal(later.held,0);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0].n,0);
    const failure=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-paid",{
        status:"failed",
        pricing:{type:"regular",billable:true,category:"utility"},
      }
    )),{database,env:paidEnv});
    assert.equal(failure.held,1);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0].n,1);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});

test("fabricated or re-used staff billing claim never authorizes another sender attempt",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {contacts}=await seededSend(db,database);
    const sig="b".repeat(64),claim="c".repeat(64);
    const conversation=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].id;
    const meta={name:"ariel_template",language:"en_US",category:"UTILITY",
      billingAcknowledged:true,billingReviewClaimHash:claim,templateSignature:sig};
    const m=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_template) " +
      "VALUES($1,'assistant','Forged billing claim',$2::jsonb) RETURNING id",
      [contacts[1].id,JSON.stringify(meta)]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [m,conversation]
    );
    const result=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:m,billableAuthorized:true,
      expectedTemplateSignature:sig,
    },{database,env});
    assert.equal(result.code,"secondary_billing_template_review_unverified");
  });
});


test("signed Ariel receipts update only their own Inbox ticks, preserve read ordering and survive late WAMID persistence",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {contacts,messages}=await seededSend(db,database);
    const received=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{status:"delivered"})),{database,env});
    assert.equal(received.matched,1);
    let owned=(await db.query(
      "SELECT whatsapp_message_id,delivery_status FROM messages WHERE id=$1",
      [messages[1].id]
    )).rows[0];
    assert.equal(owned.whatsapp_message_id,"wamid.ariel-one");
    assert.equal(owned.delivery_status,"delivered");
    const primary=(await db.query(
      "SELECT whatsapp_message_id,delivery_status FROM messages WHERE id=$1",
      [messages[0].id]
    )).rows[0];
    assert.equal(primary.whatsapp_message_id,null);
    assert.notEqual(primary.delivery_status,"delivered");

    // Existing accepted-send persistence may complete after webhook.
    const repo=require("../src/db/messagesRepo");
    const confirmed=await repo.setWhatsappMessageId(
      messages[1].id,"wamid.ariel-one",{
        database,preserveVerifiedSecondaryReceipt:true,
        events:{publishInternal:()=>{},publish:()=>{}},
      }
    );
    assert.equal(confirmed.delivery_status,"delivered");

    const lateSent=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{status:"sent"})),{database,env});
    assert.equal(lateSent.matched,1);
    assert.equal((await db.query(
      "SELECT delivery_status FROM messages WHERE id=$1",
      [messages[1].id]
    )).rows[0].delivery_status,"delivered");
    const read=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{status:"read"})),{database,env});
    assert.equal(read.matched,1);
    const failed=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{
        status:"failed",pricing:{type:"regular",billable:true,category:"service"},
      })),{database,env});
    assert.equal(failed.held,1);
    assert.equal((await db.query(
      "SELECT delivery_status FROM messages WHERE id=$1",
      [messages[1].id]
    )).rows[0].delivery_status,"read",
      "A late failure must not replace confirmed read status.");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_outbound_retries"
    )).rows[0].n,0,"Ariel Meta failure may not queue Neutro retries");
  });
});


test("a signed status received before provider acceptance can be safely promoted only after exact Ariel matching on replay",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {reservation,messages}=await seededSend(db,database);
    // Emulate Meta status arriving before the provider acceptance/WAMID
    // commit without changing any production or primary-sender record.
    await db.query(
      "UPDATE whatsapp_sender_billing_attempts SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]
    );
    await db.query(
      "UPDATE whatsapp_sender_billing_gates SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]
    );
    const packet=signed(st("wamid.ariel-one"));
    const premature=await receipts.recordSignedSecondaryStatusBatch(packet,{database,env});
    assert.equal(premature.unmatched,1);
    assert.equal((await db.query(
      "SELECT matched FROM whatsapp_sender_status_receipts"
    )).rows[0].matched,false);
    await billing.recordSecondaryProviderOutcome({
      reservationId:reservation.reservationId,acceptedWamid:"wamid.ariel-one",
    },{database,env});
    const recovered=await receipts.recordSignedSecondaryStatusBatch(packet,{database,env});
    assert.equal(recovered.matched,0,"Original signed status was promoted on acceptance");
    assert.equal(recovered.replayed,1,"A duplicate webhook must be idempotent");
    const rows=(await db.query(
      "SELECT matched,reservation_id,wamid FROM whatsapp_sender_status_receipts"
    )).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0].matched,true);
    assert.equal(rows[0].reservation_id,reservation.reservationId);
    assert.equal((await db.query(
      "SELECT delivery_status FROM messages WHERE id=$1",
      [messages[1].id]
    )).rows[0].delivery_status,"delivered");
    const replay=await receipts.recordSignedSecondaryStatusBatch(packet,{database,env});
    assert.equal(replay.replayed,1);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_outbound_retries"
    )).rows[0].n,0);
  });
});



test("one early signed free Ariel receipt settles on acceptance without another callback",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,reservation,messages}=await seededSend(db,database);
    await db.query("UPDATE whatsapp_sender_billing_attempts SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]);
    await db.query("UPDATE whatsapp_sender_billing_gates SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]);
    const autoEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
    const first=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:autoEnv});
    assert.equal(first.unmatched,1);
    const accepted=await billing.recordSecondaryProviderOutcome({
      reservationId:reservation.reservationId,acceptedWamid:"wamid.ariel-one",
    },{database,env:autoEnv});
    assert.equal(accepted.recorded,true);
    assert.equal(accepted.stagedReceiptsMatched,1);
    assert.equal(accepted.stagedAutoReconciled,true);
    assert.equal(accepted.state,"reconciled");
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
      [ids.ariel])).rows[0].state,"idle");
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [reservation.reservationId])).rows[0].state,"reconciled");
    const receipt=(await db.query(
      "SELECT matched,recipient_hash FROM whatsapp_sender_status_receipts"
    )).rows[0];
    assert.equal(receipt.matched,true);
    assert.match(receipt.recipient_hash,/^[0-9a-f]{64}$/);
    assert.equal((await db.query("SELECT delivery_status FROM messages WHERE id=$1",
      [messages[1].id])).rows[0].delivery_status,"delivered");
    assert.equal((await db.query(
      "SELECT method FROM whatsapp_sender_auto_reconciliations WHERE reservation_id=$1",
      [reservation.reservationId])).rows[0].method,"signed_meta_nonbillable_free_entry");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0,"Primary Neutro billing remains untouched");
  });
});

test("one early signed receipt with wrong recipient must not settle Ariel",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,reservation}=await seededSend(db,database);
    await db.query("UPDATE whatsapp_sender_billing_attempts SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]);
    await db.query("UPDATE whatsapp_sender_billing_gates SET state='reserved',wamid=NULL WHERE reservation_id=$1",
      [reservation.reservationId]);
    const autoEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
    const prior=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one",{recipient_id:"60124440000"})),
      {database,env:autoEnv});
    assert.equal(prior.unmatched,1);
    const result=await billing.recordSecondaryProviderOutcome({
      reservationId:reservation.reservationId,acceptedWamid:"wamid.ariel-one",
    },{database,env:autoEnv});
    assert.equal(result.stagedReceiptsMatched,0);
    assert.equal(result.stagedAutoReconciled,false);
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
      [ids.ariel])).rows[0].state,"awaiting_pricing");
    assert.equal((await db.query(
      "SELECT matched,reservation_id FROM whatsapp_sender_status_receipts"
    )).rows[0].matched,false);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_auto_reconciliations"
    )).rows[0].n,0);
  });
});

test("signed free_customer_service receipt permits another Ariel reply without inventing a charge",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,reservation}=await seededSend(db,database);
    const enabledEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
    const item=st("wamid.ariel-one",{
      pricing:{type:"free_customer_service",billable:false,category:"service"},
    });
    const out=await receipts.recordSignedSecondaryStatusBatch(signed(item),{
      database,env:enabledEnv,
    });
    assert.equal(out.autoReconciled,1);
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_gates WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0].state,"idle");
    const audit=(await db.query(
      "SELECT method,pricing_billable FROM whatsapp_sender_auto_reconciliations " +
      "WHERE reservation_id=$1",[reservation.reservationId]
    )).rows[0];
    assert.equal(audit.method,"signed_meta_nonbillable_customer_service");
    assert.equal(audit.pricing_billable,false);
    const replay=await receipts.recordSignedSecondaryStatusBatch(signed(item),{
      database,env:enabledEnv,
    });
    assert.equal(replay.replayed,1);
  });
});

test("unmatched signed billable Ariel receipt raises unassigned sender alarm",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids}=await seededSend(db,database);
    const item=st("wamid.unexpected-ariel-charge",{
      recipient_id:"60128889999",
      pricing:{type:"regular",billable:true,category:"service"},
    });
    const out=await receipts.recordSignedSecondaryStatusBatch(signed(item),{
      database,env,
    });
    assert.equal(out.unmatched,1);
    assert.equal(out.held,1);
    const alarm=(await db.query(
      "SELECT reason,reservation_id FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0];
    assert.equal(alarm.reason,"unmatched_provider_billable");
    assert.equal(alarm.reservation_id,null);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});

test("an ordinary nonbillable failed Ariel delivery does not freeze every other customer",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,reservation}=await seededSend(db,database);
    const out=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-one",{
        status:"failed",
        pricing:{type:"free_customer_service",billable:false,category:"service"},
      }
    )),{database,env});
    assert.equal(out.held,1);
    assert.equal((await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [reservation.reservationId]
    )).rows[0].state,"unknown");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0].n,0);
  });
});


test("customer deletion purges Ariel sender ledgers, retains anonymous billing alarm and leaves sibling Neutro chat intact",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,contacts,reservation,messages}=await seededSend(db,database);
    const lifecycle=require("../src/db/customerDataLifecycleRepo");
    const result=await lifecycle.purgeContactData({
      contactId:contacts[1].id,reason:"manual",requestedBy:"privacy-test",
    },db);
    assert.equal(result.status,"purged");
    const people=(await db.query(
      "SELECT id FROM contacts ORDER BY id"
    )).rows.map(x=>x.id);
    assert.deepEqual(people,[contacts[0].id],
      "Only Ariel contact may be purged for a shared WhatsApp customer.");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].n,0);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_followup_attempts WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].n,0);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_conversations WHERE contact_id=$1",
      [contacts[1].id]
    )).rows[0].n,0);
    const audit=(await db.query(
      "SELECT sender_id,previous_state FROM whatsapp_sender_erased_billing_audit"
    )).rows;
    assert.equal(audit.length,1);
    assert.equal(String(audit[0].sender_id),String(ids.ariel));
    assert.equal(audit[0].previous_state,"awaiting_pricing");
    const alarm=(await db.query(
      "SELECT reason,reservation_id FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel]
    )).rows[0];
    assert.equal(alarm.reason,"purged_unresolved_reservation");
    assert.equal(alarm.reservation_id,null);
    assert.equal((await db.query(
      "SELECT content FROM messages WHERE id=$1",[messages[0].id]
    )).rows[0].content,"Neutro message");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});


test("operator-approved service charge is isolated, auto-settles, and late receipts cannot block Ariel globally",
 {skip:!connectionString},async()=>{
  await withSchema(async({db,database})=>{
    const {ids,contacts}=await seededSend(db,database);
    const paidEnv={...env,WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
      WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true"};
    const free=await receipts.recordSignedSecondaryStatusBatch(
      signed(st("wamid.ariel-one")),{database,env:paidEnv});
    assert.equal(free.autoReconciled,1);
    const m=(await db.query(
      "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','Approved service reply') RETURNING id",
      [contacts[1].id])).rows[0].id;
    const sc=(await db.query(
      "SELECT id FROM whatsapp_sender_conversations WHERE contact_id=$1",
      [contacts[1].id])).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[m,sc]);
    const denied=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:m,billableAuthorized:true,
    },{database,env});
    assert.equal(denied.code,"secondary_billing_template_review_unverified");
    const accepted=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:m,billableAuthorized:true,
    },{database,env:paidEnv});
    assert.equal(accepted.reserved,true);
    const source=(await db.query(
      "SELECT billing_authorization_source,billable_authorized FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [accepted.reservationId])).rows[0];
    assert.equal(source.billing_authorization_source,"operator_acknowledged_service");
    assert.equal(source.billable_authorized,true);
    assert.equal((await billing.recordSecondaryProviderOutcome({
      reservationId:accepted.reservationId,acceptedWamid:"wamid.ariel-service",
    },{database,env:paidEnv})).state,"awaiting_pricing");
    const priced=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-service",{
        pricing:{type:"regular",billable:true,category:"service"},status:"delivered",
      }
    )),{database,env:paidEnv});
    assert.equal(priced.autoReconciled,1);
    assert.equal(priced.held,0);
    assert.equal((await db.query(
      "SELECT method FROM whatsapp_sender_auto_reconciliations WHERE reservation_id=$1",
      [accepted.reservationId])).rows[0].method,
      "signed_meta_operator_authorized_service_charge");
    const later=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-service",{
        pricing:{type:"regular",billable:true,category:"service"},status:"read",
      }
    )),{database,env:paidEnv});
    assert.equal(later.held,0);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel])).rows[0].n,0);
    const newMessage=(await db.query(
      "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','Next service') RETURNING id",
      [contacts[1].id])).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [newMessage,sc]);
    const next=await billing.reserveSecondaryBillingAttempt({
      contactId:contacts[1].id,messageId:newMessage,billableAuthorized:true,
    },{database,env:paidEnv});
    assert.equal(next.reserved,true);
    assert.equal((await billing.recordSecondaryProviderOutcome({
      reservationId:next.reservationId,acceptedWamid:"wamid.ariel-unexpected",
    },{database,env:paidEnv})).state,"awaiting_pricing");
    const wrong=await receipts.recordSignedSecondaryStatusBatch(signed(st(
      "wamid.ariel-unexpected",{
        pricing:{type:"regular",billable:true,category:"marketing"},
      }
    )),{database,env:paidEnv});
    assert.equal(wrong.held,1);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [ids.ariel])).rows[0].n,1);
  });
});
