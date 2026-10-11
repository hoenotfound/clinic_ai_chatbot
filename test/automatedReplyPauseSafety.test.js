const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(
  path.join(__dirname, "../src/server.js"),
  "utf8"
);

test("global reply pause preserves deterministic human handoff before returning", () => {
  const start = serverSource.indexOf("if (!automatedRepliesEnabled()) {");
  assert.ok(start >= 0, "global automated-reply pause guard must exist");

  const end = serverSource.indexOf(
    "const history = await conversationStore.getHistoryForContact",
    start
  );
  assert.ok(end > start, "pause guard must run before AI history/model generation");

  const block = serverSource.slice(start, end);
  assert.match(block, /if \(keywordReason\)/);
  // Verify both safety and standard handoff reasons in the new guarded call.
  // An ordinary handoff must retain the exact legacy reason recognised by
  // PR #304, while safety warnings keep their original urgent reason.
  assert.match(block, /keywordReason === URGENT_SAFETY_REASON/);
  assert.match(block, /isActiveSafetyConcern\(text\)/);
  assert.match(block, /pauseAiForHumanHandoff\(\s*contact\.id,\s*medicalConcern \? keywordReason : "AI handed off this conversation\."\s*\)/);

  const handoffIndex = block.indexOf("pauseAiForHumanHandoff");
  const returnIndex = block.indexOf("return { wasFirstMessage, keywordReason }");
  assert.ok(
    handoffIndex >= 0 && returnIndex > handoffIndex,
    "safety handoff must happen before the paused reply path returns"
  );
});

test("global reply pause happens before customer-facing AI generation", () => {
  const pauseIndex = serverSource.indexOf("if (!automatedRepliesEnabled()) {");
  const aiIndex = serverSource.indexOf("await ai.getReply(");
  assert.ok(pauseIndex >= 0 && aiIndex > pauseIndex);
});


test("processing failures are staff-only and preserve AI mode even while replies are paused", () => {
  const catchIndex = serverSource.indexOf("Error handling incoming");
  assert.ok(catchIndex >= 0);
  const block = serverSource.slice(catchIndex);
  assert.match(block, /contactsRepo\.setTemporaryAiAttention/);
  assert.match(block, /contactsRepo\.setAiReviewAttention/);
  assert.doesNotMatch(block, /pauseAiForHumanHandoff|sendTrackedText|system_fallback/);
});
