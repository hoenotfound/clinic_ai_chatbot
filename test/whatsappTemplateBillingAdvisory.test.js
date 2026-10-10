"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BILLING_ADVISORY_SQL, REVIEW_TTL_MS, describeEvidence,
  getTemplateBillingAdvisory, issueReviewToken, verifyReviewToken,
  validateBillingAcknowledgment,
} = require("../src/services/whatsappTemplateBillingAdvisory");

const env = { SESSION_SECRET: "test-only-long-and-random-enough-session-secret-12345" };
const reviewedAt = new Date("2026-10-10T06:55:54.591Z");

function fakeDatabase(rows) {
  let calls = 0;
  return {
    get calls() { return calls; },
    query: async (_sql, args) => {
      calls++;
      assert.equal(args[0], 85);
      return { rows: [typeof rows === "function" ? rows() : rows] };
    },
  };
}

test("prioritizes verified Meta charges over a prior free-entry receipt", () => {
  assert.equal(describeEvidence(null), "unknown");
  assert.equal(describeEvidence({has_ctwa_referral:false, has_recent_verified_free_entry:false}), "no_ctwa_referral");
  assert.equal(describeEvidence({has_ctwa_referral:true,has_recent_verified_free_entry:false}), "ctwa_unverified_or_expired");
  assert.equal(describeEvidence({has_ctwa_referral:true,has_recent_verified_free_entry:true}), "recent_free_entry_evidence");
  assert.equal(describeEvidence({
    has_ctwa_referral:true, has_recent_verified_free_entry:true,
    has_recent_billable_message:true,
  }), "recent_billable_message");
  assert.match(BILLING_ADVISORY_SQL, /pricing_type='free_entry_point'/);
  assert.match(BILLING_ADVISORY_SQL, /billed\.billable=true/);
  assert.match(BILLING_ADVISORY_SQL, /m\.contact_id=\$1/);
  assert.match(BILLING_ADVISORY_SQL, /interval '7 days'/);
  assert.match(BILLING_ADVISORY_SQL, /interval '71 hours'/);
});

test("signed billing reviews bind contact, staff, evidence, secret and expiration", () => {
  const token = issueReviewToken(85, "admin", "no_ctwa_referral", {now: reviewedAt, env});
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env}).evidence,"no_ctwa_referral");
  assert.equal(verifyReviewToken(token,86,"admin",{now:reviewedAt,env}),null);
  assert.equal(verifyReviewToken(token,85,"other",{now:reviewedAt,env}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env:{SESSION_SECRET:"another-safe-but-different-long-secret-xyz"}}),null);
  assert.equal(verifyReviewToken(token.slice(0,-3)+"xxx",85,"admin",{now:reviewedAt,env}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:new Date(reviewedAt.getTime()+REVIEW_TTL_MS+1),env}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:new Date(reviewedAt.getTime()-1000),env}),null);
});

test("a manual send requires explicit server-side acknowledgment", async () => {
  const database = fakeDatabase({has_ctwa_referral:false});
  const res = await validateBillingAcknowledgment(85,"admin",{}, {now:reviewedAt,env,database});
  assert.equal(res.allowed,false);
  assert.equal(res.code,"billing_acknowledgment_required");
  assert.equal(database.calls,0,"missing acknowledgment must not query billing or send");
});

test("fresh valid acknowledgment passes, but new billable evidence forces reconfirmation", async () => {
  let billed = false;
  const database = fakeDatabase(() => ({
    has_ctwa_referral: true,has_recent_verified_free_entry:true,
    has_recent_billable_message:billed,
  }));
  const first = await getTemplateBillingAdvisory(85,{database,now:reviewedAt,staffUsername:"admin",env});
  assert.equal(first.evidence,"recent_free_entry_evidence");
  const body = {billingAcknowledged:true,billingReviewToken:first.reviewToken};
  let validation = await validateBillingAcknowledgment(85,"admin",body,{database,now:new Date(reviewedAt.getTime()+800),env});
  assert.equal(validation.allowed,true);
  assert.equal(validation.evidence,"recent_free_entry_evidence");
  billed = true;
  validation = await validateBillingAcknowledgment(85,"admin",body,{database,now:new Date(reviewedAt.getTime()+1000),env});
  assert.equal(validation.allowed,false);
  assert.equal(validation.code,"billing_evidence_changed");
  assert.equal(validation.billingAdvisory.evidence,"recent_billable_message");
  assert.ok(validation.billingAdvisory.reviewToken);
  const renewed = await validateBillingAcknowledgment(85,"admin",{
    billingAcknowledged:true,
    billingReviewToken:validation.billingAdvisory.reviewToken,
  },{database,now:new Date(reviewedAt.getTime()+1200),env});
  assert.equal(renewed.allowed,true);
  assert.equal(renewed.evidence,"recent_billable_message");
});

test("expired/forged evidence tokens fail closed and return a fresh review", async () => {
  const db = fakeDatabase({has_ctwa_referral:false});
  const a = await getTemplateBillingAdvisory(85,{database:db,now:reviewedAt,staffUsername:"admin",env});
  for (const bad of ["tampered.token",undefined,""]) {
    const v = await validateBillingAcknowledgment(85,"admin",
      {billingAcknowledged:true,billingReviewToken:bad},
      {database:db,now:reviewedAt,env});
    assert.equal(v.allowed,false);
    assert.equal(v.code,"billing_review_expired");
  }
  const old = await validateBillingAcknowledgment(85,"admin",{
    billingAcknowledged:true,billingReviewToken:a.reviewToken,
  },{database:db,now:new Date(reviewedAt.getTime()+REVIEW_TTL_MS+1),env});
  assert.equal(old.allowed,false);
  assert.equal(old.code,"billing_review_expired");
  assert.equal(old.billingAdvisory.evidence,"no_ctwa_referral");
});

test("unavailable pricing evidence stays unknown with an explicit signed acknowledgment", async () => {
  const db = {query:async()=>{throw new Error("unavailable")} };
  const a = await getTemplateBillingAdvisory(85,{database:db,now:reviewedAt,staffUsername:"admin",env});
  assert.equal(a.evidence,"unknown");
  assert.ok(a.reviewToken);
  const val = await validateBillingAcknowledgment(85,"admin",{
    billingAcknowledged:true,billingReviewToken:a.reviewToken,
  },{database:db,now:reviewedAt,env});
  assert.equal(val.allowed,true);
  assert.equal(val.evidence,"unknown");
});
