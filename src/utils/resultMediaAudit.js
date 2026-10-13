"use strict";

// Pure, testable final audit decision. The caller persists this exactly once in
// its finally block so early returns are covered without duplicate SQL writes.
function resultMediaAuditOutcome({
  reason = null,
  sentCount = 0,
  promotionImagesTruncated = false,
} = {}) {
  const resolvedReason = promotionImagesTruncated
    ? (reason ? reason + ";promotion_image_budget" : "promotion_image_budget")
    : reason;
  const status = reason === "awaiting_meta_free_billing" && sentCount === 0
    ? "deferred"
    : sentCount > 0
    ? (resolvedReason ? "partial" : "sent")
    : (["provider_send_failed", "result_media_exception"].includes(reason)
      ? "failed" : "skipped");
  return { status, reason: resolvedReason };
}

module.exports = { resultMediaAuditOutcome };
