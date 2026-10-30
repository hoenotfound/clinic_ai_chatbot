"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {loadMigrations}=require("../src/db/migrationRunner");

test("forward-only multi-number migrations preserve sales 078/079",()=>{
 const migrations=loadMigrations();
 assert.equal(migrations.length,110);
 assert.deepEqual(migrations.slice(77,81).map(m=>[m.version,m.name]),[
  [78,"sales_follow_up_tasks"],[79,"sales_follow_up_corrections"],
  [80,"whatsapp_sender_foundation"],[81,"whatsapp_sender_conversation_identity"]]);
 assert.deepEqual([migrations.at(-1).version,migrations.at(-1).name],
  [110,"whatsapp_secondary_imported_contact_marker"]);
 assert.deepEqual([migrations.at(-2).version,migrations.at(-2).name],
  [109,"whatsapp_secondary_marketing_followup"]);
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
