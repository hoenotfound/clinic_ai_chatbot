"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const billing=require("../src/services/whatsappZeroCostGuard");
const env={WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_WABA_ID:"200000000000001",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true"};
test("same customer at Neutro and Ariel resolves only the primary-number billing contact",async()=>{
 const queries=[];
 const database={query:async(sql,args)=>{
   queries.push({sql,args});
   if(sql.includes("SELECT c.id FROM contacts c"))
      return {rows:[{id:17}]}; // sender-qualified DB predicate excludes Ariel
   if(sql.includes("SELECT contact_id FROM messages"))
      return {rows:[{contact_id:17}]};
   throw new Error("Unexpected SQL "+sql);
 }};
 assert.equal(await billing.primaryBillingContactId("60125550000",{
   env,database,expectedContactId:17,currentMessageId:81
 }),17);
 assert.equal(await billing.primaryBillingContactId("60125550000",{
   env,database,expectedContactId:18
 }),null);
 assert.match(queries[0].sql,/sa\.meta_phone_number_id=\$2/);
 assert.match(queries[0].sql,/sa\.meta_account_id=\$3/);
});
test("billing fails closed with ambiguous or missing primary contacts",async()=>{
 for(const rows of [[],[{id:17},{id:18}]]) {
   const id=await billing.primaryBillingContactId("60125550000",{
     env,database:{query:async()=>({rows})}
   });
   assert.equal(id,null);
 }
});
test("sender-qualified billing proof filters every eligibility query by contact ID",()=>{
 for(const [sql,bind] of [
  [billing.SCOPED_VERIFIED_WINDOW_SQL,7],
  [billing.SCOPED_SESSION_WINDOW_SQL,4],
  [billing.SCOPED_CTWA_FIRST_REPLY_SQL,4],
  [billing.SCOPED_SEVEN_DAY_PROOF_SQL,1]
 ]) assert.match(sql,new RegExp("\\$"+bind+"::integer"));
});

test("billing alarm is scoped to the owning business; unknown legacy metadata remains conservative",()=>{
 const q=billing.billingAlarmSenderSql(env);
 assert.match(q,/business_phone_number_id IS NULL/);
 assert.match(q,/business_account_id IS NULL/);
 assert.ok(q.includes("business_phone_number_id=$2::text"));
 assert.ok(q.includes("business_account_id=$3::text"));
 assert.deepEqual(billing.billingAlarmSenderArgs(env),
   ["1408739622311791","200000000000001"]);
 assert.equal(billing.billingAlarmSenderSql({}),"");
 assert.deepEqual(billing.billingAlarmSenderArgs({}),[]);
});
