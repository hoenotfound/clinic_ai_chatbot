"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {tokenForInboundMedia}=require("../src/services/whatsappService");
const env={
 WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
 WHATSAPP_WABA_ID:"200000000000001",
 WHATSAPP_TOKEN:"test-primary",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 WHATSAPP_SECONDARY_TOKEN:"test-secondary"
};
test("media selects a token only when the receiving Meta account and number both match",()=>{
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_WABA_ID
 },env),"test-primary");
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID
 },env),"test-secondary");
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_WABA_ID
 },env),null);
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID
 },env),null);
 assert.equal(tokenForInboundMedia({},env),null);
});
test("secondary token cannot fall back to primary if disabled or missing",()=>{
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID
 },{...env,WHATSAPP_SECONDARY_TOKEN:""}),null);
 const disabled={...env,WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"false"};
 assert.equal(tokenForInboundMedia({
  businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID
 },disabled),null);
 assert.equal(tokenForInboundMedia({},disabled),"test-primary");
});
