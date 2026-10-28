"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertRehearsalIsolation}=require("../src/services/pr414SyntheticQaRehearsal");
const valid={
 PR395_STAGING_MODE:"true",
 PR414_QA_SYNTHETIC_REHEARSAL_ON_BOOT:"true",
 PR414_QA_SYNTHETIC_OPERATOR_APPROVED:"true",
 PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"false",
 PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
 WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false",
 WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED:"false",
 PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"false",
 WHATSAPP_FEP_FOLLOWUPS_ENABLED:"false",
 WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:"postgresql://source:pw1@ep-qa.neon.tech/neondb",
 DATABASE_URL:"postgresql://target:pw2@ep-qa.neon.tech/pr414_forward_qa",
 WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.neon.tech",
 WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST:"ep-qa.neon.tech",
 WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE:"neondb",
 WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE:"pr414_forward_qa",
 WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ALLOW_SAME_QA_HOST:"true"
};
test("PR414 synthetic QA proof is disabled unless explicitly approved and two QA databases pinned",()=>{
 assert.equal(assertRehearsalIsolation(valid),true);
 for(const patch of [
   {PR395_STAGING_MODE:"false"},
   {PR414_QA_SYNTHETIC_OPERATOR_APPROVED:"false"},
   {PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true"},
   {WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true"},
   {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
   {WHATSAPP_FEP_FOLLOWUPS_ENABLED:"true"},
   {DATABASE_URL:valid.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL},
   {DATABASE_URL:"postgresql://source:pw1@ep-qa.neon.tech/pr414_forward_qa"},
   {WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE:"neondb"}
 ])assert.throws(()=>assertRehearsalIsolation({...valid,...patch}),/rehearsal|refused/);
});
