"use strict";
// Manual, opt-in operator entrypoint ONLY. NEVER run from a deploy hook,
// automatic retry, queue worker, webhook or Embedded Signup finish callback.
// This command can initiate a real one-time Meta data request if --execute.
require("dotenv").config();
const { assertSafeCommand, dispatchOnce } =
  require("../src/services/pr395CoexistenceSyncDispatcher");
function flags(argv) {
  const out={};
  for(const arg of argv) {
    const m=/^--([a-z-]+)=(.+)$/.exec(arg);
    if(m)out[m[1]]=m[2];
    else if(arg==="--execute")out.execute=true;
    else throw Error("Unknown or missing parameter.");
  }
  return out;
}
async function main(){
  const f=flags(process.argv.slice(2));
  const now=new Date();
  const input={
    onboardingAttemptId:Number(f.attempt),
    wabaId:process.env.WHATSAPP_SECONDARY_WABA_ID,
    phoneNumberId:process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    syncType:f.type,onboardingCompletedAt:f.completed,
    operatorApproved:f.approved==="yes",
    receiverReady:f.receiver==="verified",
    importerReady:f.importer==="verified",
    verifiedAppSubscription:f.subscription==="verified",
    verifiedCallbackOverride:f.callback==="verified",
    syncConsent:f["sync-consent"]==="verified",
    historyConsent:f["history-consent"]==="verified",
    consentSource:f["consent-source"],consentVerifiedBy:f.operator
  };
  assertSafeCommand(input,process.env,now);
  if(!f.execute){
    console.log("Dry-run prerequisite checks passed. No database or Meta requests issued.");
    console.log("No automatic dispatch is configured. --execute requires separate explicit operator approval.");
    return;
  }
  if(process.env.PR395_MANUAL_SYNC_APPROVAL!=="APPROVED_ONCE_ONLY_META_SYNC" ||
     f.confirm!=="IRREVERSIBLE_ONCE_ONLY"){
    throw Error("Manual execution confirmation missing. No Meta request sent.");
  }
  const result=await dispatchOnce(input,{env:process.env,now});
  console.log(JSON.stringify(result));
  if(result.requiresManualReview)process.exitCode=2;
}
main().catch(()=>{console.error("One-time sync refused or uncertain. Inspect isolated staging ledger; never automatically retry.");process.exitCode=1;});
