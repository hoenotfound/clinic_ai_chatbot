"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertSenderIngressSafety,assertStoredSenderSafety}=require("../src/services/whatsappSenderActivationGate");
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
  const allowed=await assertStoredSenderSafety({
    env:{...safe,WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"false"},
    database:db
  });
  assert.equal(allowed.nonprimaryContacts,2);
});
test("sender verification database outage prevents readiness",async()=>{
  await assert.rejects(assertStoredSenderSafety({
    env:safe,database:{query:async()=>{throw new Error("Neon offline");}}
  }),/Neon offline/);
});
