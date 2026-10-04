const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

test("temporary AI provider outages do not force Staff mode", () => {
  const recoveryIndex = server.indexOf("if (ai.isRecoverableAiReplyFailure(err))");
  const pauseIndex = server.indexOf(
    "const pausedContact = await pauseAiForHumanHandoff(",
    recoveryIndex
  );

  assert.ok(recoveryIndex >= 0, "recoverable AI failure guard should exist");
  assert.ok(pauseIndex > recoveryIndex, "provider recovery guard should run before handoff");

  const recoveryBlock = server.slice(recoveryIndex, pauseIndex);
  assert.match(recoveryBlock, /contactsRepo\.setTemporaryAiAttention/);
  assert.match(recoveryBlock, /sendTrackedText/);
  assert.doesNotMatch(recoveryBlock, /pauseAiForHumanHandoff/);
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
