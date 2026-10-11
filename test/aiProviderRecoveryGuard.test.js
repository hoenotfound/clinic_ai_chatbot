const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

test("temporary AI provider outages alert staff quietly and keep AI mode", () => {
  const start = server.indexOf("if (ai.isRecoverableAiReplyFailure(err))");
  const end = server.indexOf("} else {", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const recoveryBlock = server.slice(start, end);
  assert.match(recoveryBlock, /contactsRepo\.setTemporaryAiAttention/);
  assert.doesNotMatch(recoveryBlock, /sendTrackedText|pauseAiForHumanHandoff/);

  const failureTail = server.slice(start, server.indexOf("return { wasFirstMessage, keywordReason };", end));
  assert.match(failureTail, /contactsRepo\.setAiReviewAttention/);
  assert.doesNotMatch(failureTail, /sendTrackedText/);
});

test("a successful AI reply clears only temporary provider-outage attention", () => {
  const sendIndex = server.indexOf('const sendOutcome = await sendTrackedText(');
  const clearIndex = server.indexOf(
    "contactsRepo.clearTemporaryAiAttention",
    sendIndex
  );
  const promoIndex = server.indexOf(
    "resolvePricePromotionForReply",
    sendIndex
  );

  assert.ok(sendIndex >= 0, "normal AI send should exist");
  assert.ok(clearIndex > sendIndex, "temporary attention should clear after the send");
  assert.ok(promoIndex > clearIndex, "attention should clear before promo eligibility is checked");
});
