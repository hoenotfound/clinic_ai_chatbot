"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {loadMigrations}=require("../src/db/migrationRunner");

test("forward-only multi-number migrations preserve sales 078/079",()=>{
 const migrations=loadMigrations();
 assert.equal(migrations.length,118);
 assert.deepEqual(migrations.slice(77,81).map(m=>[m.version,m.name]),[
  [78,"sales_follow_up_tasks"],[79,"sales_follow_up_corrections"],
  [80,"whatsapp_sender_foundation"],[81,"whatsapp_sender_conversation_identity"]]);
 assert.deepEqual([migrations.at(-1).version,migrations.at(-1).name],
  [118,"whatsapp_secondary_followup_treatment_state"]);
 for (const [version,name] of [
   [115,"inbox_chat_archiving"],
   [114,"secondary_day4_day6_marketing_slots"],
   [113,"secondary_66h_marketing_slot"],
   [112,"whatsapp_sender_owner_risk_override_audit"],
   [111,"secondary_marketing_languages"],
   [110,"whatsapp_secondary_imported_contact_marker"],
 ]) {
   assert.deepEqual(migrations.filter(m=>m.version===version).map(m=>[m.version,m.name]),
     [[version,name]]);
 }
 assert.ok(migrations.every(m=>!(m.filePath||"").includes("ops/qa-only")));
});
test("27 PR395 QA migration names are mapped only in a non-executable reconciliation plan",()=>{
  const plan=fs.readFileSync(path.join(__dirname,
    "../docs/pr395-production-migration-reconciliation.md"),"utf8");
  assert.match(plan, /\| 078 \| 080 \|/);
  assert.match(plan, /\| 104 \| 106 \|/);
  assert.match(plan, /27/);
  assert.match(plan, /Do not merge PR #395 wholesale/);
});
