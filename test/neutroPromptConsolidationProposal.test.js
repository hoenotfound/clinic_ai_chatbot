"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { previewConsolidation, fingerprint } = require("../scripts/preview-neutro-prompt-consolidation");
const proposal = require("../scripts/config-proposals/neutro-prompt-consolidation-20261124.json");
const keys = ["sop", "messagingStyle", "closingPlaybook"];

function fixture() {
  const source = { businessName: proposal.clinic, services: [{ name: "骨盆调理" }],
    promotions: [{ name: "Package A" }, { name: "Package B" }], guardrails: ["medical review"],
    escalation: { outOfScopeTriggers: ["urgent issue"] }, automatedFollowUp: { assessmentFirstPricingEnabled: true },
    hours: { closed: "Monday" }, customSetting: true };
  const plan = { ...proposal, expectedMd5: {} };
  for (const key of keys) {
    source[key] = proposal.replacement[key] + "\nOld redundant text";
    plan.expectedMd5[key] = fingerprint(source[key]);
  }
  return { source, plan };
}

test("preview only changes three explicitly approved text sections without mutating input", () => {
  const { source, plan } = fixture();
  const before = structuredClone(source);
  const result = previewConsolidation(source, plan);
  assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(result).filter(key => result[key] !== source[key]).sort(), [...keys].sort());
  for (const key of keys) assert.equal(result[key], proposal.replacement[key]);
});

test("reject stale source, wrong business, and missing section without returning partial candidate", () => {
  const { source, plan } = fixture();
  assert.throws(() => previewConsolidation({ ...source, sop: source.sop + " updated" }, plan), /Stale/);
  assert.throws(() => previewConsolidation({ ...source, businessName: "Other clinic" }, plan), /Expected Neutro/);
  assert.throws(() => previewConsolidation({ ...source, closingPlaybook: undefined }, plan), /Stale/);
  assert.throws(() => previewConsolidation(source, { ...plan, replacement: { ...plan.replacement, sop: "" } }), /Invalid shortened/);
});

test("proposal retains explicit clinic-specific safety and sales constraints", () => {
  const { sop, messagingStyle, closingPlaybook } = proposal.replacement;
  for (const re of [/verifiedSessionCount = 1/, /6 weeks/, /RM100/, /ACTIVE PROMOTIONS/, /pregnancy/i, /Before & After/, /15cm/, /一次护理后有机会看到明显的变化/]) assert.match(sop, re);
  for (const re of [/15cm/, /AI 身体检测/, /paid facial trials free/, /自然|natural/, /English/, /BM/, /at most one useful question/, /中医师/]) assert.match(messagingStyle, re);
  for (const re of [/PJ/, /staff or connected CRM/i, /opt-out/, /VALUE-FIRST APPOINTMENT INVITATIONS/, /Package A\/B/, /assessment/i]) assert.match(closingPlaybook, re);
});
