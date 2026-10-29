"use strict";
// No Meta writes and no outbound sends. One operator-approved, identity-scoped
// refresh of stored Meta Coexistence status after authenticated signup.
require("dotenv").config();
const {pool}=require("../src/db/db");
const {recheck}=require("../src/services/neutroSecondaryCoexistenceStatusRecheck");
async function main(args=process.argv.slice(2)){
  const match=args.find(x=>/^--attempt=[1-9][0-9]*$/.test(x));
  const allowed=args.every(x=>x===match||x==="--execute"||x==="--confirm=VERIFIED_META_STATUS_ONLY");
  if(!match||!allowed)throw Error("Usage: --attempt=N [--execute --confirm=VERIFIED_META_STATUS_ONLY]");
  const execute=args.includes("--execute");
  if(execute && !args.includes("--confirm=VERIFIED_META_STATUS_ONLY"))
    throw Error("Missing explicit confirmation. No database status changed.");
  const result=await recheck({
    attemptId:Number(match.slice("--attempt=".length)),
    wabaId:process.env.WHATSAPP_SECONDARY_WABA_ID,
    phoneNumberId:process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    execute
  });
  console.log(JSON.stringify(result));
}
if(require.main===module)main().catch(err=>{
  console.error("STOP: Coexistence status refresh refused: "+err.message);
  process.exitCode=1;
}).finally(()=>pool.end().catch(()=>{}));
module.exports={main};
