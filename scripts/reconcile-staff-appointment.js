"use strict";
// Usage: node scripts/reconcile-staff-appointment.js --lead 123 --message 456
// Add --apply only after a successful dry run and an operator's confirmation.
require("dotenv").config();
const {pool}=require("../src/db/db");
const config=require("../src/config/clinicConfig");
const pipeline=require("../src/db/pipelineRepo");
const {reconcileStaffAppointment}=require("../src/services/staffAppointmentReconciliationService");

async function main(){
  const args=process.argv.slice(2);
  const flags=new Map();
  for(let i=0;i<args.length;i++){
    if(args[i]==="--apply"&&!flags.has("--apply"))flags.set("--apply",true);
    else if(["--lead","--message"].includes(args[i])&&!flags.has(args[i])&&/^[1-9]\d*$/u.test(args[i+1]||""))flags.set(args[i],Number(args[++i]));
    else throw new Error("Use --lead ID --message ID [--apply]");
  }
  if(!flags.has("--lead")||!flags.has("--message"))throw new Error("Both exact IDs required");
  // Do not seed or mutate configuration or pipeline stages during dry run.
  const stored=(await pool.query("SELECT data FROM clinic_config WHERE id=1")).rows[0]?.data;
  if(!stored||stored.businessType!=="tcm_clinic"||!/^neutro\s+sense\b/iu.test(String(stored.businessName||stored.clinicName||"")))throw new Error("Only the configured Neutro Sense database is eligible");
  if(flags.has("--apply"))Object.assign(config,stored);
  const result=await reconcileStaffAppointment({database:pool,pipeline,config:stored,
    leadId:flags.get("--lead"),staffMessageId:flags.get("--message"),apply:flags.has("--apply")});
  console.log(JSON.stringify(result));
  if(!["verified_dry_run","reconciled"].includes(result.status))process.exitCode=1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
