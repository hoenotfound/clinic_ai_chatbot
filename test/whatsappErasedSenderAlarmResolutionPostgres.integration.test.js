"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const svc=require("../src/services/whatsappErasedSenderAlarmResolutionService");
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const reservation=hash("synthetic-purged-reservation");
const env={
 WHATSAPP_SECONDARY_ERASED_ALARM_RELEASE_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_WABA_ID:"1593376338308612",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"1852014482431209",
};
const evidence={
 reservationSha256:reservation,
 businessAppEvidenceSha256:hash("external-app-confirmation"),
 metaBillingEvidenceSha256:hash("external-meta-billing-confirmation"),
 reviewer:"operator.one",independentApprover:"operator.two",
 outcome:"confirmed_sent",chargeOutcome:"charge_accounted",
 reviewReason:"Independently confirmed an app send and reconciled the specific Meta billing outcome.",
 businessAppManuallyReviewed:true,metaBillingManuallyReviewed:true,
 operatorExplicitlyAuthorized:true,
 signedReceiptIngressManuallyVerified:true,
 secondaryPaymentMethodManuallyVerified:true,
};
test("release stays OFF, rejects active sends and incomplete evidence",async()=>{
 assert.equal(svc.enabled({}),false);
 assert.equal((await svc.releaseReviewedErasedSecondaryAlarm(evidence,{env:{}})).released,false);
 for(const flag of svc.OUTBOUND_FLAGS)assert.equal(svc.enabled({...env,[flag]:"true"}),false,flag);
 for(const flag of [
  "WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED",
  "WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
 ])assert.equal(svc.enabled({...env,[flag]:"false"}),false,flag);
 assert.equal(svc.validateEvidence(null),null);
 assert.equal(svc.validateEvidence([]),null);
 assert.equal(svc.enabled({...env,WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"wrong"}),false);
 for(const bad of [
  {operatorExplicitlyAuthorized:false},
  {signedReceiptIngressManuallyVerified:false},
  {secondaryPaymentMethodManuallyVerified:false},
  {businessAppManuallyReviewed:false},
  {metaBillingManuallyReviewed:false},{reviewer:"operator.two"},
  {metaBillingEvidenceSha256:evidence.businessAppEvidenceSha256},
  {outcome:"confirmed_not_sent",chargeOutcome:"charge_accounted"},
  {reservationSha256:"bad"},{reviewReason:"unverified"},
 ])assert.equal(svc.validateEvidence({...evidence,...bad}),null,JSON.stringify(bad));
 assert.equal(svc.validateEvidence(evidence).reservation,reservation);
});

const acceptedUnknown={
 ...evidence,
 outcome:"unknown",chargeOutcome:"unknown",
 businessAppEvidenceSha256:undefined,metaBillingEvidenceSha256:undefined,
 businessAppManuallyReviewed:false,metaBillingManuallyReviewed:false,
 acceptsUnresolvedDeliveryAndCharge:true,
 acceptsPossibleLaterMetaCharge:true,
 originalMessageWillNeverBeRetried:true,
 reviewReason:"The owner and independent reviewer accept that delivery and charges may remain unknown permanently; do not retry the erased message.",
};
test("UNKNOWN/UNKNOWN risk acceptance never fabricates provider facts",()=>{
 const risk=svc.validateEvidence(acceptedUnknown);
 assert.equal(risk.outcome,"unknown");
 assert.equal(risk.charge,"unknown");
 assert.equal(risk.appHash,null);
 assert.equal(risk.billingHash,null);
 assert.equal(risk.riskAccepted,true);
 for(const bad of [
  {acceptsUnresolvedDeliveryAndCharge:false},
  {acceptsPossibleLaterMetaCharge:false},
  {originalMessageWillNeverBeRetried:false},
  {secondaryPaymentMethodManuallyVerified:false},
  {signedReceiptIngressManuallyVerified:false},
  {metaBillingEvidenceSha256:hash("fake-provider-evidence")},
  {businessAppManuallyReviewed:true},
  {outcome:"confirmed_sent",chargeOutcome:"unknown"},
  {outcome:"unknown",chargeOutcome:"charge_accounted"},
  {reviewer:"operator.two"},
 ])assert.equal(svc.validateEvidence({...acceptedUnknown,...bad}),null,JSON.stringify(bad));
});

test("disposable PostgreSQL: exact purged alarm releases once, records evidence, never sends",
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema="erased_alarm_"+process.pid+"_"+Date.now()+"_"+crypto.randomBytes(3).toString("hex");
 const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
 await db.connect();
 try {
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const database={
   async connect(){
    const c=new Client({connectionString:process.env.TEST_DATABASE_URL});
    await c.connect();await c.query("SET search_path TO "+schema);
    return{query:(...a)=>c.query(...a),release:()=>c.end()};
   },query:(...a)=>db.query(...a),
  };
  await runMigrations(database,{quiet:true});
  assert.equal((await db.query("SELECT MAX(version)::integer AS v FROM schema_migrations")).rows[0].v,108);
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary',$1,$2,'Secondary','active') RETURNING id",
   [env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
  )).rows[0].id;
  await db.query(
   "INSERT INTO whatsapp_sender_erased_billing_audit"+
   "(reservation_sha256,sender_id,previous_state,staff_charge_approved,billable_receipt_seen)"+
   "VALUES($1,$2,'unknown',TRUE,FALSE)",[reservation,sender]
  );
  await db.query(
   "INSERT INTO whatsapp_sender_billing_alarms(sender_id,reservation_id,reason,latest_wamid_hash)"+
   "VALUES($1,NULL,'purged_unresolved_reservation',$2)",[sender,reservation]
  );
  const wrong=await svc.releaseReviewedErasedSecondaryAlarm(
   {...evidence,metaBillingManuallyReviewed:false},{database,env});
  assert.equal(wrong.released,false);
  const result=await svc.releaseReviewedErasedSecondaryAlarm(evidence,{database,env});
  assert.deepEqual(result,{released:true,sendAuthorized:false,retryAuthorized:false});
  const resolution=(await db.query(
   "SELECT * FROM whatsapp_sender_erased_alarm_resolutions")).rows;
  assert.equal(resolution.length,1);
  assert.equal(resolution[0].reservation_sha256,reservation);
  assert.equal(resolution[0].meta_billing_evidence_sha256,evidence.metaBillingEvidenceSha256);
  assert.equal(resolution[0].independent_approver,"operator.two");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_sender_billing_alarms")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_sender_erased_billing_audit")).rows[0].n,1);
  const replay=await svc.releaseReviewedErasedSecondaryAlarm(evidence,{database,env});
  assert.equal(replay.released,false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_sender_erased_alarm_resolutions")).rows[0].n,1);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});


test("disposable PostgreSQL: UNKNOWN stays UNKNOWN after audited risk release; future alarms still block",
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema="risk_alarm_"+process.pid+"_"+Date.now()+"_"+crypto.randomBytes(3).toString("hex");
 const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const database={
   async connect(){
    const c=new Client({connectionString:process.env.TEST_DATABASE_URL});
    await c.connect();await c.query("SET search_path TO "+schema);
    return{query:(...a)=>c.query(...a),release:()=>c.end()};
   },query:(...a)=>db.query(...a),
  };
  await runMigrations(database,{quiet:true});
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary',$1,$2,'Secondary','active') RETURNING id",
   [env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
  )).rows[0].id;
  await db.query(
   "INSERT INTO whatsapp_sender_erased_billing_audit"+
   "(reservation_sha256,sender_id,previous_state,staff_charge_approved,billable_receipt_seen)"+
   "VALUES($1,$2,'unknown',TRUE,FALSE)",[reservation,sender]
  );
  await db.query(
   "INSERT INTO whatsapp_sender_billing_alarms(sender_id,reservation_id,reason,latest_wamid_hash)"+
   "VALUES($1,NULL,'purged_unresolved_reservation',$2)",[sender,reservation]
  );
  // The release must not proceed for mismatched or conflicting old ledgers.
  const badHash=await svc.releaseReviewedErasedSecondaryAlarm(
   {...acceptedUnknown,reservationSha256:hash("unrelated-reservation")},{database,env});
  assert.equal(badHash.released,false);
  await db.query("UPDATE whatsapp_sender_billing_alarms SET observed_count=2 WHERE sender_id=$1",[sender]);
  const multiAlarm=await svc.releaseReviewedErasedSecondaryAlarm(acceptedUnknown,{database,env});
  assert.equal(multiAlarm.released,false);
  await db.query("UPDATE whatsapp_sender_billing_alarms SET observed_count=1 WHERE sender_id=$1",[sender]);
  await db.query("UPDATE whatsapp_sender_erased_billing_audit SET previous_state='rejected' WHERE sender_id=$1",[sender]);
  const otherState=await svc.releaseReviewedErasedSecondaryAlarm(acceptedUnknown,{database,env});
  assert.equal(otherState.released,false);
  await db.query("UPDATE whatsapp_sender_erased_billing_audit SET previous_state='unknown' WHERE sender_id=$1",[sender]);

  const blocked=await svc.releaseReviewedErasedSecondaryAlarm(
   {...acceptedUnknown,signedReceiptIngressManuallyVerified:false},{database,env});
  assert.equal(blocked.released,false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_sender_billing_alarms")).rows[0].n,1);
  const result=await svc.releaseReviewedErasedSecondaryAlarm(acceptedUnknown,{database,env});
  assert.deepEqual(result,{released:true,sendAuthorized:false,retryAuthorized:false});
  const audit=(await db.query(
   "SELECT outcome,charge_outcome,risk_accepted,business_app_evidence_sha256,"+
   "meta_billing_evidence_sha256,signed_receipt_ingress_verified,"+
   "secondary_payment_method_verified,original_retry_prohibited "+
   "FROM whatsapp_sender_erased_alarm_resolutions WHERE sender_id=$1",[sender]
  )).rows[0];
  assert.equal(audit.outcome,"unknown");
  assert.equal(audit.charge_outcome,"unknown");
  assert.equal(audit.risk_accepted,true);
  assert.equal(audit.business_app_evidence_sha256,null);
  assert.equal(audit.meta_billing_evidence_sha256,null);
  assert.equal(audit.signed_receipt_ingress_verified,true);
  assert.equal(audit.secondary_payment_method_verified,true);
  assert.equal(audit.original_retry_prohibited,true);
  // This is an append-only audit: neither reviewer nor operator may
  // rewrite the UNKNOWN status after a successful release.
  await assert.rejects(db.query(
   "UPDATE whatsapp_sender_erased_alarm_resolutions SET outcome='confirmed_sent' WHERE sender_id=$1",
   [sender]
  ),/append-only/);
  await assert.rejects(db.query(
   "DELETE FROM whatsapp_sender_erased_alarm_resolutions WHERE sender_id=$1",[sender]
  ),/append-only/);
  assert.equal((await db.query("SELECT previous_state FROM whatsapp_sender_erased_billing_audit")).rows[0].previous_state,"unknown");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_sender_billing_attempts")).rows[0].n,0);
  const replay=await svc.releaseReviewedErasedSecondaryAlarm(acceptedUnknown,{database,env});
  assert.equal(replay.released,false);
  // A later unmatched charge must create a NEW hold; the exception is
  // specific to the old erased reservation, not a global future bypass.
  await db.query(
   "INSERT INTO whatsapp_sender_billing_alarms(sender_id,reservation_id,reason,latest_wamid_hash) "+
   "VALUES($1,NULL,'unmatched_provider_billable',$2)",[sender,hash("late-unmatched-provider-charge")]
  );
  const adverse=await svc.releaseReviewedErasedSecondaryAlarm(acceptedUnknown,{database,env});
  assert.equal(adverse.released,false);
  assert.equal((await db.query(
   "SELECT reason FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",[sender]
  )).rows[0].reason,"unmatched_provider_billable");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
