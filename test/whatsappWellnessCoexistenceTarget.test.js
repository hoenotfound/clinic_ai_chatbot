"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {
  assertExpectedSecondaryTarget,
  assertSecondaryOperationalSafety,
  secondaryUsesPrimaryClinicContent,
}=require("../src/services/whatsappSenderActivationGate");
const cfg=fs.readFileSync(path.join(__dirname,"../.env.example"),"utf8");
const PHONE="1318355951360575";
const ACCOUNT="1071636698738276";
const MESSAGING_ACCOUNT="1852014482431209";
const env={
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:PHONE,
 WHATSAPP_SECONDARY_WABA_ID:ACCOUNT,
 WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:PHONE,
 WHATSAPP_SECONDARY_EXPECTED_WABA_ID:ACCOUNT,
 WHATSAPP_COEXISTENCE_ENABLED:"false",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",
 WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
 WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"false",
};
test("selected 中医养生馆 target pins its phone without asserting an unverified WhatsApp account ID",()=>{
 assert.match(cfg,/WHATSAPP_SECONDARY_PHONE_NUMBER_ID=1318355951360575/);
 assert.match(cfg,/WHATSAPP_SECONDARY_WABA_ID=REPLACE_AFTER_AUTHORIZED_META_VERIFICATION/);
 assert.match(cfg,/WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=\\+60174831336/);
 assert.doesNotMatch(cfg,/# WHATSAPP_SECONDARY_WABA_ID=1071636698738276/);
 assert.match(cfg,/WHATSAPP_SECONDARY_SENDER_KEY=tcm_wellness/);
 assert.ok(!cfg.includes("WHATSAPP_SECONDARY_WABA_ID="+MESSAGING_ACCOUNT));
 assert.doesNotThrow(()=>assertExpectedSecondaryTarget(env));
 assert.doesNotThrow(()=>assertSecondaryOperationalSafety(env));
});
test("the old secondary sender cannot pass a new-number-pinned activation preflight",()=>{
 for(const mismatch of [
  {...env,WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"110552088553929"},
  {...env,WHATSAPP_SECONDARY_WABA_ID:"758291387233325"},
  {...env,WHATSAPP_SECONDARY_EXPECTED_WABA_ID:MESSAGING_ACCOUNT},
 ]) assert.throws(()=>assertExpectedSecondaryTarget(mismatch),/Unsafe secondary target/);
});
test("old secondary number's content authorization does not transfer to new TCM account",()=>{
 assert.equal(secondaryUsesPrimaryClinicContent(env),false);
 assert.throws(()=>assertSecondaryOperationalSafety({
  ...env,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 }),/approved primary Neutro clinic-content binding/);
 assert.throws(()=>assertSecondaryOperationalSafety({
  ...env,WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
 }),/approved primary Neutro clinic-content binding/);
});
test("Inbox uses registry display name rather than the former secondary number's label",()=>{
 const followups=fs.readFileSync(path.join(__dirname,
  "../portal-frontend/src/components/ArielFollowUpRules.jsx"),"utf8");
 const media=fs.readFileSync(path.join(__dirname,
  "../portal-frontend/src/components/ArielMediaReview.jsx"),"utf8");
 const ruleApi=fs.readFileSync(path.join(__dirname,
  "../src/routes/whatsappSecondaryFollowUpRules.js"),"utf8");
 const mediaApi=fs.readFileSync(path.join(__dirname,
  "../src/routes/whatsappSecondaryMediaReview.js"),"utf8");
 assert.match(followups,/config\?\.senderDisplayName/);
 assert.match(media,/data\?\.senderDisplayName/);
 assert.match(ruleApi,/senderDisplayName:identity.display_name/);
 assert.match(mediaApi,/senderDisplayName:lookup.rows\[0\].display_name/);
 assert.doesNotMatch(followups,/Ariel Lee/);
 assert.doesNotMatch(media,/Ariel Lee/);
});
