"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { customerFollowUpIntentGuardSql } = require("../src/db/followUpRepo");

test("primary TCM followups exclude non-patient commercial outreaches", () => {
 const original = clinicConfig.businessType;
 try {
   clinicConfig.businessType = "tcm_clinic";
   const sql = customerFollowUpIntentGuardSql("c");
   assert.match(sql, /health\[\[:space:\]\]\+professional/);
   assert.match(sql, /谢谢/);
   assert.match(sql, /penang/);
   assert.match(sql, /recent_user\.contact_id=c\.id/);
   assert.match(sql, /ORDER BY recent_user\.created_at DESC/);
   assert.throws(() => customerFollowUpIntentGuardSql("c;DELETE"));
   clinicConfig.businessType = "retail";
   assert.equal(customerFollowUpIntentGuardSql("c"), "TRUE");
 } finally {
   clinicConfig.businessType = original;
 }
});
