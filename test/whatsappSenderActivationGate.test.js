"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertSenderIngressSafety,assertStoredSenderSafety,secondaryUsesPrimaryClinicContent}=require("../src/services/whatsappSenderActivationGate");
const safe={
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
 WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_WABA_ID:"200000000000001"
};
test("legacy startup does not need new flags",()=>assert.doesNotThrow(()=>assertSenderIngressSafety({})));
test("verified primary-only ingress can start",()=>assert.doesNotThrow(()=>assertSenderIngressSafety(safe)));
test("incomplete or unverified scoped ingress never starts",()=>{
 for(const key of Object.keys(safe)){
   const bad={...safe}; delete bad[key];
   if(key==="WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED") continue;
   assert.throws(()=>assertSenderIngressSafety(bad), /Unsafe WhatsApp/);
 }
});

test("legacy startup with no sender bindings remains available",async()=>{
  const calls=[];
  const answer=await assertStoredSenderSafety({
    env:{WHATSAPP_PHONE_NUMBER_ID:safe.WHATSAPP_PHONE_NUMBER_ID,
         WHATSAPP_WABA_ID:safe.WHATSAPP_WABA_ID},
    database:{query:async(sql,args)=>{calls.push(sql);return{rows:[{total:0,nonprimary:0}]}}}
  });
  assert.equal(answer.verified,true);
  assert.equal(calls.length,1);
});
test("scope can activate only with an active, verified primary registration",async()=>{
  const db={query:async(sql)=>{
    if(sql.includes("COUNT(*)"))return {rows:[{total:0,nonprimary:0}]};
    return {rows:[{id:1,sender_key:"neutro",state:"active"}]};
  }};
  assert.equal((await assertStoredSenderSafety({env:safe,database:db})).verified,true);
  for(const account of [
    null,{id:1,sender_key:"ariel",state:"active"},
    {id:1,sender_key:"neutro",state:"disabled"}
  ]) {
    const denied={query:async sql=>sql.includes("COUNT(*)")?
      {rows:[{total:0,nonprimary:0}]}:{rows:account?[account]:[]}};
    await assert.rejects(assertStoredSenderSafety({env:safe,database:denied}),/active persisted/);
  }
});
test("rollback never turns off sender lookups with live secondary contacts",async()=>{
  let db={query:async()=>({rows:[{total:4,nonprimary:2}]})};
  await assert.rejects(assertStoredSenderSafety({
    env:{WHATSAPP_PHONE_NUMBER_ID:safe.WHATSAPP_PHONE_NUMBER_ID,
         WHATSAPP_WABA_ID:safe.WHATSAPP_WABA_ID},database:db
  }),/Unsafe WhatsApp rollback/);
  await assert.rejects(assertStoredSenderSafety({
    env:{...safe,WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"false"},
    database:db
  }), /Unsafe WhatsApp rollback/);
});
test("sender verification database outage prevents readiness",async()=>{
  await assert.rejects(assertStoredSenderSafety({
    env:safe,database:{query:async()=>{throw new Error("Neon offline");}}
  }),/Neon offline/);
});

test("secondary inbox only requires active exact Meta registry identity",async()=>{
 const env={...safe,
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"110552088553929",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_SECONDARY_TOKEN:"synthetic-fixture"
 };
 const good={query:async(sql)=>{
   if(sql.includes("COUNT(*)"))return{rows:[{total:1,nonprimary:1}]};
   if(sql.includes("WHATSAPP"))throw new Error("invalid");
   if(sql.includes("SELECT sender_key,state"))return{rows:[{sender_key:"ariel",state:"active"}]};
   return{rows:[{id:1,sender_key:"neutro",state:"active"}]};
 }};
 assert.equal((await assertStoredSenderSafety({env,database:good})).verified,true);
 for(const bad of [
   {...env,WHATSAPP_SECONDARY_PHONE_NUMBER_ID:env.WHATSAPP_PHONE_NUMBER_ID},
   {...env,WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
   {...env,WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"false"}
 ]) await assert.rejects(assertStoredSenderSafety({env:bad,database:good}),
   /unsafe|requires|incomplete/i);
 const badDb={query:async(sql)=>sql.includes("COUNT(*)")?
   {rows:[{total:0,nonprimary:0}]}:{rows:[]}};
 await assert.rejects(assertStoredSenderSafety({env,database:badDb}),/active sender registration/);
});


test("new secondary operational flags fail startup when only one feature is enabled",()=>{
  for(const flag of [
    "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
    "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
    "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
    "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
    "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
    "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
    "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
    "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
    "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  ]) {
    assert.throws(
      ()=>assertSenderIngressSafety({...safe,[flag]:"true"}),
      /Unsafe WhatsApp secondary operational activation/
    );
  }
});

test("fully configured secondary operational flags still preserve strict Neutro receiver checks",()=>{
  const dual={
    ...safe,
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
    WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
    WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
    WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
    WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
    WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
    WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
    WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
    WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
    WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true",
    WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"true",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",
    WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
    WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
    WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
    WHATSAPP_SECONDARY_TOKEN:"private-test-token",
    WHATSAPP_APP_SECRET:"synthetic-meta-hmac",
  };
  assert.throws(
    ()=>assertSenderIngressSafety({...dual,WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"false"}),
    /possible Meta service-message charges require explicit sender-specific acknowledgment/
  );
  assert.throws(
    ()=>assertSenderIngressSafety({...dual,WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:""}),
    /possible Meta service-message charges require explicit sender-specific acknowledgment/
  );
  assert.doesNotThrow(()=>assertSenderIngressSafety({
    ...safe,WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false",
  }),"Ordinary Neutro startup needs no Ariel spend acknowledgement.");
  assert.doesNotThrow(()=>assertSenderIngressSafety(dual));
  // Without an explicit Neutro clinic-content binding, Ariel AI remains off
  // even with every independent transport and billing dependency configured.
  assert.throws(
    ()=>assertSenderIngressSafety({...dual,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"}),
    /approved primary Neutro clinic-content binding/
  );
  assert.throws(
    ()=>assertSenderIngressSafety({...dual,WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"}),
    /approved primary Neutro clinic-content binding/
  );
  const sharedClinic={
    ...dual,
    WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
    WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
  };
  assert.equal(secondaryUsesPrimaryClinicContent(sharedClinic),true);
  assert.equal(secondaryUsesPrimaryClinicContent(dual),false);
  assert.doesNotThrow(()=>assertSenderIngressSafety({
    ...sharedClinic,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  }));
  assert.doesNotThrow(()=>assertSenderIngressSafety({
    ...sharedClinic,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
  }));
  for(const changes of [
    {WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"ariel"},
    {WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:""},
    {WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"false"},
    {WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:""},
    {WHATSAPP_SECONDARY_SENDER_KEY:dual.WHATSAPP_PRIMARY_SENDER_KEY},
  ]) {
    assert.equal(secondaryUsesPrimaryClinicContent({...sharedClinic,...changes}),false);
    assert.throws(()=>assertSenderIngressSafety({
      ...sharedClinic,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",...changes,
    }),/approved primary Neutro clinic-content binding/);
  }
  // Content approval does not approve billing or skip independent transport.
  assert.throws(()=>assertSenderIngressSafety({
    ...sharedClinic,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"false",
  }),/possible Meta service-message charges/);
  assert.throws(()=>assertSenderIngressSafety({
    ...sharedClinic,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false",
  }),/Unsafe WhatsApp secondary operational activation/);
  assert.doesNotThrow(()=>assertSenderIngressSafety({
    ...dual, WHATSAPP_SECONDARY_WABA_ID: dual.WHATSAPP_WABA_ID,
  }), "Two sender phone IDs may share a single verified WABA.");
  for(const change of [
    {WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false"},
    {WHATSAPP_SECONDARY_TOKEN:""},
    {WHATSAPP_APP_SECRET:""},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:dual.WHATSAPP_PHONE_NUMBER_ID},
    {WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"false"},
  ]) {
    assert.throws(
      ()=>assertSenderIngressSafety({...dual,...change}),
      /Unsafe WhatsApp secondary operational activation/
    );
  }
});
