"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BILLING_ADVISORY_SQL, REVIEW_TTL_MS, describeEvidence,
  getTemplateBillingAdvisory, issueReviewToken, verifyReviewToken,
  validateBillingAcknowledgment, claimBillingReviewOnce,
} = require("../src/services/whatsappTemplateBillingAdvisory");

const env = { SESSION_SECRET: "test-only-long-and-random-enough-session-secret-12345" };
const reviewedAt = new Date("2026-10-10T06:55:54.591Z");
const selected = { name: "ns_fu3_face_feedback", language: "zh_CN", sendable: true };
const scope = { templateName: selected.name, languageCode: selected.language };
const reviewOptions = { templates: [selected] };
function reviewBody(advisory) {
  return { ...scope, billingAcknowledged: true,
    billingReviewToken: advisory.reviewTokens[selected.name+"::"+selected.language] };
}


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
  const token = issueReviewToken(85, "admin", "no_ctwa_referral", {now: reviewedAt, env,...scope});
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env,...scope}).evidence,"no_ctwa_referral");
  assert.equal(verifyReviewToken(token,86,"admin",{now:reviewedAt,env,...scope}),null);
  assert.equal(verifyReviewToken(token,85,"other",{now:reviewedAt,env,...scope}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env:{SESSION_SECRET:"another-safe-but-different-long-secret-xyz"},...scope}),null);
  assert.equal(verifyReviewToken(token.slice(0,-3)+"xxx",85,"admin",{now:reviewedAt,env,...scope}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:new Date(reviewedAt.getTime()+REVIEW_TTL_MS+1),env,...scope}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:new Date(reviewedAt.getTime()-1000),env,...scope}),null);
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
  const first = await getTemplateBillingAdvisory(85,{database,now:reviewedAt,staffUsername:"admin",env,...reviewOptions});
  assert.equal(first.evidence,"recent_free_entry_evidence");
  const body = reviewBody(first);
  let validation = await validateBillingAcknowledgment(85,"admin",body,{database,now:new Date(reviewedAt.getTime()+800),env});
  assert.equal(validation.allowed,true);
  assert.equal(validation.evidence,"recent_free_entry_evidence");
  billed = true;
  validation = await validateBillingAcknowledgment(85,"admin",body,{database,now:new Date(reviewedAt.getTime()+1000),env});
  assert.equal(validation.allowed,false);
  assert.equal(validation.code,"billing_evidence_changed");
  assert.equal(validation.billingAdvisory.evidence,"recent_billable_message");
  assert.ok(validation.billingAdvisory.reviewTokens[selected.name+"::"+selected.language]);
  const renewed = await validateBillingAcknowledgment(85,"admin",reviewBody(validation.billingAdvisory),{database,now:new Date(reviewedAt.getTime()+1200),env});
  assert.equal(renewed.allowed,true);
  assert.equal(renewed.evidence,"recent_billable_message");
});

test("expired/forged evidence tokens fail closed and return a fresh review", async () => {
  const db = fakeDatabase({has_ctwa_referral:false});
  const a = await getTemplateBillingAdvisory(85,{database:db,now:reviewedAt,staffUsername:"admin",env,...reviewOptions});
  for (const bad of ["tampered.token",undefined,""]) {
    const v = await validateBillingAcknowledgment(85,"admin",
      {billingAcknowledged:true,billingReviewToken:bad},
      {database:db,now:reviewedAt,env});
    assert.equal(v.allowed,false);
    assert.equal(v.code,"billing_review_expired");
  }
  const old = await validateBillingAcknowledgment(85,"admin",reviewBody(a),{database:db,now:new Date(reviewedAt.getTime()+REVIEW_TTL_MS+1),env});
  assert.equal(old.allowed,false);
  assert.equal(old.code,"billing_review_expired");
  assert.equal(old.billingAdvisory.evidence,"no_ctwa_referral");
});

test("unavailable pricing evidence stays unknown with an explicit signed acknowledgment", async () => {
  const db = {query:async()=>{throw new Error("unavailable")} };
  const a = await getTemplateBillingAdvisory(85,{database:db,now:reviewedAt,staffUsername:"admin",env,...reviewOptions});
  assert.equal(a.evidence,"unknown");
  assert.ok(a.reviewTokens[selected.name+"::"+selected.language]);
  const val = await validateBillingAcknowledgment(85,"admin",reviewBody(a),{database:db,now:reviewedAt,env});
  assert.equal(val.allowed,true);
  assert.equal(val.evidence,"unknown");
});


test("a reviewed token cannot authorize another template, language, contact or staff", () => {
  const token=issueReviewToken(85,"admin","no_ctwa_referral",{now:reviewedAt,env,...scope});
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env,
    templateName:"ns_fu3_pelvis_feedback",languageCode:"zh_CN"}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env,
    templateName:selected.name,languageCode:"en_US"}),null);
  assert.equal(verifyReviewToken(token,85,"admin",{now:reviewedAt,env,...scope}).templateName,selected.name);
  const second=issueReviewToken(85,"admin","no_ctwa_referral",{now:reviewedAt,env,...scope});
  assert.notEqual(token,second,"different reviews must use different random nonce");
});

test("one-time billing claims allow one writer, reject replay, and keep template binding", async () => {
  const rows=new Set();
  const db={query:async (sql,args)=>{
    assert.match(sql,/ON CONFLICT \(token_hash\) DO NOTHING/);
    assert.deepEqual(args.slice(1),[85,"admin",selected.name,selected.language]);
    if(rows.has(args[0]))return {rows:[]};
    rows.add(args[0]);return {rows:[{token_hash:args[0]}]};
  }};
  const advisory={reviewTokens:{[selected.name+"::"+selected.language]:
    issueReviewToken(85,"admin","no_ctwa_referral",{now:reviewedAt,env,...scope})}};
  const body=reviewBody(advisory);
  const first=await claimBillingReviewOnce(85,"admin",body,{now:reviewedAt,env,database:db});
  assert.equal(first.claimed,true);
  assert.match(first.tokenHash,/^[a-f0-9]{64}$/);
  const replay=await claimBillingReviewOnce(85,"admin",body,{now:reviewedAt,env,database:db});
  assert.deepEqual(replay,{claimed:false,code:"billing_review_already_used"});
  assert.equal((await claimBillingReviewOnce(85,"admin",{...body,templateName:"wrong"},
    {now:reviewedAt,env,database:db})).claimed,false);
  assert.equal(rows.size,1);
});
