"use strict";
// Temporary CI-only, source-code SQL export for isolated staging benchmarking.
// This file contains NO credentials, bound query parameters or customer rows.
// The source SQL is chunked so the CI log viewer cannot truncate long lines.
// Never merge this diagnostic exporter to production.
const test=require("node:test");
const assert=require("node:assert/strict");
for(const [key,value] of Object.entries({
 WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
 WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
 WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
})) process.env[key]=value;
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const service=require("../src/services/whatsappSecondaryFollowUpService");
test("export exact source SQL for isolated staging EXPLAIN, no execution",()=>{
 const statements={
  marketing_candidates:marketing.CANDIDATES_SQL,
  marketing_due:marketing.POTENTIAL_DUE_SQL,
  service_candidates:service.CANDIDATES_SQL,
  service_due:service.POTENTIAL_DUE_SQL,
 };
 for(const [name,sql] of Object.entries(statements)){
   assert.equal(typeof sql,"string");
   assert.ok(sql.length>15000,name+" must include full clinic policy safeguards");
   const serialized=JSON.stringify(sql);
   for(let offset=0;offset<serialized.length;offset+=1800)
      console.log("BENCH_SOURCE|"+name+"|"+offset+"|"+serialized.slice(offset,offset+1800));
   console.log("BENCH_END|"+name+"|"+serialized.length);
 }
});
