"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { customerFollowUpIntentGuardSql } = require("../src/db/followUpRepo");

test("primary TCM followups exclude non-patient commercial outreaches", () => {
 const original = clinicConfig.businessType;
 const originalName = clinicConfig.businessName;
 try {
   clinicConfig.businessType = "tcm_clinic";
   clinicConfig.businessName = "Neutro Sense TCM Centre";
   const sql = customerFollowUpIntentGuardSql("c");
   assert.match(sql, /health\[\[:space:\]\]\+professional/);
   assert.match(sql, /谢谢/);
   assert.match(sql, /penang/);
   assert.match(sql, /recent_user\.contact_id=c\.id/);
   assert.match(sql, /ORDER BY recent_user\.created_at DESC/);
   assert.throws(() => customerFollowUpIntentGuardSql("c;DELETE"));
   clinicConfig.businessType = "retail";
   assert.equal(customerFollowUpIntentGuardSql("c"), "TRUE");
   clinicConfig.businessType = "tcm_clinic";
   clinicConfig.businessName = "Other TCM Centre";
   assert.equal(customerFollowUpIntentGuardSql("c"), "TRUE");
 } finally {
   clinicConfig.businessType = original;
   clinicConfig.businessName = originalName;
 }
});

test("all five primary follow-up worker paths select the customer text needed by the booking guard", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src/db/followUpRepo.js"), "utf8");
  // Discovery and next-due scheduling both use a latest-inbound LATERAL row.
  assert.equal((source.match(/SELECT id, content, created_at\s+FROM messages\s+WHERE contact_id = c\.id\s+AND role = 'user'/g) || []).length, 2);
  // Send/decision claims use a latest-inbound CTE.
  assert.equal((source.match(/SELECT inbound\.id, inbound\.content, inbound\.created_at\s+FROM messages inbound, conversation_lock/g) || []).length, 2);
  // Final delivery eligibility must also project content.
  assert.match(source, /SELECT inbound\.id,inbound\.content,inbound\.created_at\s+FROM messages inbound/);
});
