"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {loadMigrations}=require("../src/db/migrationRunner");

test("production migration history preserves sales-follow-up 078/079, not PR395 QA migrations",()=>{
  const migrations=loadMigrations();
  const last=migrations.slice(-2);
  assert.deepEqual(last.map(m=>[m.version,m.name]),[
    [78,"sales_follow_up_tasks"],
    [79,"sales_follow_up_corrections"]
  ]);
  assert.equal(migrations.length,79);
  const paths=migrations.map(m=>m.filePath||"");
  assert.ok(paths.every(p=>!p.includes("ops/qa-only")));
  assert.ok(paths.every(p=>!p.includes("whatsapp_sender_foundation")));
});
test("27 PR395 QA migration names are mapped only in a non-executable reconciliation plan",()=>{
  const plan=fs.readFileSync(path.join(__dirname,
    "../docs/pr395-production-migration-reconciliation.md"),"utf8");
  assert.match(plan, /\| 078 \| 080 \|/);
  assert.match(plan, /\| 104 \| 106 \|/);
  assert.match(plan, /27/);
  assert.match(plan, /Do not merge PR #395 wholesale/);
});
