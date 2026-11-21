"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { categorizeAiReview } = require("../src/utils/aiReviewPolicy");
const { campaignContextReply, firstReply, PREFILL } = require("../src/utils/neutroBreastRm68Campaign");

test("ordinary price, dates and location stay informational even if model says clinical", () => {
  for (const question of ["价钱呢？", "只有这两天？", "你们的店是在哪？"]) {
    assert.equal(categorizeAiReview(question, "clinical"), "information", question);
  }
});
test("genuine clinical enquiry still needs clinical review", () => {
  assert.equal(categorizeAiReview("乳腺癌可以做这个护理吗？", "information"), "clinical");
});
test("verified RM68 opener supports short date and price questions", () => {
  const history = [
    { role: "user", content: PREFILL },
    { role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z")) },
  ];
  for (const question of ["只有这两天？", "价钱呢？"]) {
    const answer = campaignContextReply({ history, customerText: question, now: Date.parse("2026-11-22T00:00:00Z") });
    assert.ok(answer && answer.includes("RM68"), question);
  }
});
test("campaign does not inherit price after treatment switch", () => {
  const history = [
    { role: "user", content: PREFILL },
    { role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z")) },
    { role: "user", content: "我想了解骨盆调理" },
    { role: "assistant", content: "好的" },
  ];
  assert.equal(campaignContextReply({ history, customerText: "价钱呢？", now: Date.parse("2026-11-22T00:00:00Z") }), null);
});
