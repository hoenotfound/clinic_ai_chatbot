"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertSenderIngressSafety}=require("../src/services/whatsappSenderActivationGate");
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
