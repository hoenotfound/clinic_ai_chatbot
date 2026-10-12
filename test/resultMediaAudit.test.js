"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resultMediaAuditOutcome } = require("../src/utils/resultMediaAudit");

test("real audit outcome code distinguishes successful, partial, failed and early skip", () => {
  const scenarios = [
    [{ reason: null, sentCount: 2 }, { status: "sent", reason: null }],
    [{ reason: "staff_review_or_takeover", sentCount: 0 }, { status: "skipped", reason: "staff_review_or_takeover" }],
    [{ reason: "staff_review_or_takeover", sentCount: 1 }, { status: "partial", reason: "staff_review_or_takeover" }],
    [{ reason: "reply_window_or_staff_cancellation", sentCount: 1 }, { status: "partial", reason: "reply_window_or_staff_cancellation" }],
    [{ reason: "provider_send_failed", sentCount: 0 }, { status: "failed", reason: "provider_send_failed" }],
    [{ reason: "provider_send_failed", sentCount: 1 }, { status: "partial", reason: "provider_send_failed" }],
    [{ reason: "result_media_exception", sentCount: 0 }, { status: "failed", reason: "result_media_exception" }],
    [{ reason: null, sentCount: 0, promotionImagesTruncated: true }, { status: "skipped", reason: "promotion_image_budget" }],
  ];
  for (const [state, expected] of scenarios)
    assert.deepEqual(resultMediaAuditOutcome(state), expected, JSON.stringify(state));
});

test("audit finalizer executes exactly once when a result loop returns early", async () => {
  const decisions = [];
  const makeEarlyReturn = async ({ reason, sentCount }) => {
    let auditReason = null, auditSent = 0;
    try {
      auditSent = sentCount;
      auditReason = reason;
      return "stopped";
    } finally {
      decisions.push(resultMediaAuditOutcome({ reason: auditReason, sentCount: auditSent }));
    }
  };
  assert.equal(await makeEarlyReturn({ reason: "staff_review_or_takeover", sentCount: 1 }), "stopped");
  assert.deepEqual(decisions, [{ status: "partial", reason: "staff_review_or_takeover" }]);
});
