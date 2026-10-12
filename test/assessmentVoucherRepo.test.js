"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const voucher = require("../src/db/assessmentVoucherRepo");

function fakeDatabase({ lead = { id: 7, appointment_status: "visited", treatment_interest: "骨盆调理" },
  current = null } = {}) {
  const calls = [];
  let state = current;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT id, appointment_status")) return { rows: lead ? [lead] : [] };
      if (sql.startsWith("SELECT * FROM assessment_voucher_tracking")) return { rows: state ? [state] : [] };
      if (sql.includes("INSERT INTO assessment_voucher_tracking")) {
        state = { ...(state || {}), lead_id: 7, status: params[1],
          assessed_at: params[1] === "eligible" ? new Date().toISOString() : (state?.assessed_at || null),
          issued_at: params[1] === "issued" ? new Date().toISOString() : (state?.issued_at || null),
          redeemed_at: params[1] === "redeemed" ? new Date().toISOString() : (state?.redeemed_at || null),
          updated_at: new Date().toISOString(), updated_by: params[2],
          redemption_note: params[3] || state?.redemption_note || null };
        return { rows: [state] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return { connect: async () => client, calls };
}

test("voucher lifecycle is staff-only, one-way, and recorded in lead activity", async()=>{
  const db=fakeDatabase();
  const eligible=await voucher.transitionVoucher(7,{status:"eligible"},"staff",db);
  assert.equal(eligible.status,"eligible");
  assert.equal(eligible.valueRm,100);
  assert.equal(db.calls.some(x=>x.sql.includes("lead_activities")),true);
  assert.equal(db.calls.filter(x=>x.sql==="COMMIT").length,1);
  const issued=await voucher.transitionVoucher(7,{status:"issued",termsConfirmed:true},"staff",db);
  assert.equal(issued.status,"issued");
  const redeemed=await voucher.transitionVoucher(7,{status:"redeemed",redemptionNote:"Voucher redeemed once, no stacking."},"staff",db);
  assert.equal(redeemed.status,"redeemed");
  assert.equal(redeemed.redemptionNote,"Voucher redeemed once, no stacking.");
  assert.equal(db.calls.filter(x=>x.sql==="COMMIT").length,3);
  await assert.rejects(voucher.transitionVoucher(7,{status:"issued",termsConfirmed:true},"staff",db),
    err=>err.status===409);
});

test("voucher cannot be granted before verified pelvic assessment attendance", async()=>{
  for (const lead of [
    {id:7,appointment_status:"set",treatment_interest:"骨盆调理"},
    {id:7,appointment_status:"visited",treatment_interest:"3D 小颜术"},
    {id:7,appointment_status:"visited",treatment_interest:null},
  ]) {
    const db=fakeDatabase({lead});
    await assert.rejects(voucher.transitionVoucher(7,{status:"eligible"},"staff",db),
      err=>err.status===400);
    assert.equal(db.calls.some(x=>x.sql.includes("INSERT INTO assessment_voucher_tracking")),false);
    assert.ok(db.calls.some(x=>x.sql==="ROLLBACK"));
  }
});

test("voucher issuance confirms terms and redemption requires an audit note", async()=>{
  const eligible={status:"eligible",assessed_at:new Date().toISOString()};
  await assert.rejects(voucher.transitionVoucher(7,{status:"issued"},"staff",fakeDatabase({current:eligible})),
    err=>err.status===400);
  await assert.rejects(voucher.transitionVoucher(7,{status:"redeemed",redemptionNote:""},"staff",
    fakeDatabase({current:{...eligible,status:"issued"}})),err=>err.status===400);
  await assert.rejects(voucher.transitionVoucher(7,{status:"redeemed",redemptionNote:"x".repeat(501)},"staff",
    fakeDatabase({current:{...eligible,status:"issued"}})),err=>err.status===400);
  assert.equal(voucher.validTransition("none","eligible"),true);
  assert.equal(voucher.validTransition("none","redeemed"),false);
  assert.equal(voucher.validTransition("issued","redeemed"),true);
  assert.equal(voucher.validTransition("redeemed","voided"),false);
  assert.equal(voucher.isPelvicLead("骨盆调理"),true);
  assert.equal(voucher.isPelvicLead("徒手体态调理"),false);
  assert.equal(voucher.publicVoucher(null).status,"not_verified");
});

test("voucher is persisted in a new non-destructive versioned migration",()=>{
  const file=fs.readFileSync(path.join(__dirname,"../src/db/migrations/066_assessment_voucher_tracking.sql"),"utf8");
  assert.match(file,/CREATE TABLE IF NOT EXISTS assessment_voucher_tracking/);
  assert.match(file,/REFERENCES leads\(id\) ON DELETE CASCADE/);
  assert.match(file,/redeemed/);
});
