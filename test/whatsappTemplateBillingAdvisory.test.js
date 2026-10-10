"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BILLING_ADVISORY_SQL,
  describeEvidence,
  getTemplateBillingAdvisory,
} = require("../src/services/whatsappTemplateBillingAdvisory");

test("manual template billing advisory distinguishes missing ad proof from confirmed recent evidence", () => {
  assert.equal(describeEvidence(null), "unknown");
  assert.equal(describeEvidence({ has_ctwa_referral: false, has_recent_verified_free_entry: false }), "no_ctwa_referral");
  assert.equal(describeEvidence({ has_ctwa_referral: true, has_recent_verified_free_entry: false }), "ctwa_unverified_or_expired");
  assert.equal(describeEvidence({ has_ctwa_referral: true, has_recent_verified_free_entry: true }), "recent_free_entry_evidence");
  assert.match(BILLING_ADVISORY_SQL, /pricing_type='free_entry_point'/);
  assert.match(BILLING_ADVISORY_SQL, /evidence\.billable=false/);
  assert.match(BILLING_ADVISORY_SQL, /interval '71 hours'/);
});

test("manual template billing advisory uses the contact's Meta billing evidence, never ad attribution alone", async () => {
  const now = new Date("2026-10-10T06:55:54.591Z");
  const queries = [];
  const database = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      return { rows: [{ has_ctwa_referral: false, has_recent_verified_free_entry: false }] };
    },
  };
  assert.deepEqual(await getTemplateBillingAdvisory(85, { database, now }), {
    evidence: "no_ctwa_referral",
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0][1], [85, now]);
  assert.deepEqual(await getTemplateBillingAdvisory(0, { database, now }), {
    evidence: "unknown",
  });
  assert.equal(queries.length, 1, "invalid contact must not touch the database");
});
