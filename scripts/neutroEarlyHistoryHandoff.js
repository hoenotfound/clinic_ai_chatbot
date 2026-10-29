"use strict";
// Internal manual command on the already paid Render instance. Never schedule,
// invoke from signup callback, or run without reviewed real sender proof.
require("dotenv").config();
const {pool}=require("../src/db/db");
const hold=require("../src/services/whatsappPaidEarlyHistoryCapture");
const verified=require("../src/services/whatsappPaidProductionHistoryReceiver");

async function main(argv=process.argv.slice(2)){
  if(argv.length===1 && argv[0]==="--purge-expired"){
    if(process.env.WHATSAPP_PAID_SECONDARY_EARLY_PURGE_OPERATOR_APPROVED!=="true")
      throw Error("Expired-hold cleanup requires separate operator approval");
    const result=await hold.purgeExpired();
    console.log(JSON.stringify({expiredHoldsDeleted:result.rowCount}));
    return;
  }
  const execute=argv.includes("--execute");
  const confirm=argv.includes("--confirm=VERIFIED_NEUTRO_SECONDARY_ONLY");
  if(argv.some(x=>!["--execute","--confirm=VERIFIED_NEUTRO_SECONDARY_ONLY"].includes(x)))
    throw Error("Unknown command; use dry-run, --execute --confirm, or --purge-expired");
  const config=verified.assertConfig();
  const counts=await pool.query(
    "SELECT event_field,COUNT(*)::int AS count FROM whatsapp_secondary_early_history_hold " +
    "WHERE candidate_waba_id=$1 AND candidate_phone_number_id=$2 " +
    "AND expires_at>NOW() GROUP BY event_field ORDER BY event_field",
    [config.secondaryAccount,config.secondaryPhone]
  );
  if(!execute){
    console.log(JSON.stringify({dryRun:true,eligibleEventCounts:counts.rows,
      noMetaRequest:true,noCustomerMessageSent:true}));
    return;
  }
  if(!confirm || process.env.WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED!=="true")
    throw Error("Manual handoff approval missing");
  const result=await hold.handoffOnce({maxEvents:5});
  console.log(JSON.stringify(result));
}
if(require.main===module){
  main().catch(()=>{console.error("Early history handoff failed; no automatic retry or send. Review sender and durable DB.");process.exitCode=1;})
    .finally(()=>pool.end().catch(()=>{}));
}
module.exports={main};
