"use strict";
// Offline operator action only. Never imported by the web server or scheduler.
// Do not invoke until two real people independently checked Meta billing and
// the Business App. CLI flags are human attestations, not API verification.
require("dotenv").config();
const {pool}=require("../src/db/db");
const {releaseReviewedSecondaryUnknownHold}=
  require("../src/services/whatsappSecondaryUnknownHoldReviewService");

const args=new Map();
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i];
 if(!key.startsWith("--"))continue;
 if(["--apply","--confirm-billing-no-charge","--confirm-business-app-reviewed",
     "--confirm-original-never-retry"].includes(key)){args.set(key,true);continue;}
 const value=process.argv[i+1];
 if(!value || value.startsWith("--")){console.error("Missing value for "+key);process.exitCode=2;break;}
 args.set(key,value);i++;
}
async function main(){
 if(!args.get("--apply")){
  console.log("Read-only: no gate was released. Supply --apply after two independent external reviews.");
  return;
 }
 const result=await releaseReviewedSecondaryUnknownHold({
  reservationId:args.get("--reservation-id"),
  releaseBasis:args.get("--release-basis"),
  firstReviewer:args.get("--first-reviewer"),
  secondReviewer:args.get("--second-reviewer"),
  evidenceTicket:args.get("--evidence-ticket"),
  billingHubNoChargeChecked:args.get("--confirm-billing-no-charge")===true,
  businessAppReviewed:args.get("--confirm-business-app-reviewed")===true,
  oldMessageRetryProhibited:args.get("--confirm-original-never-retry")===true,
 });
 console.log(JSON.stringify(result));
 if(!result.gateReleased)process.exitCode=1;
}
main().catch(()=>{
 console.error("Unknown hold review unavailable; no send authorized.");
 process.exitCode=1;
}).finally(()=>pool.end().catch(()=>{}));
