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
  assert.match(block, /pauseAiForHumanHandoff\(contact\.id, keywordReason\)/);

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


test("processing failures still transition to Staff mode while replies are paused", () => {
  const catchIndex = serverSource.indexOf("Error handling incoming");
  assert.ok(catchIndex >= 0);

  const pauseIndex = serverSource.indexOf(
    'if (!automatedRepliesEnabled()) {',
    catchIndex
  );
  const fallbackGuardIndex = serverSource.indexOf(
    'const fallbackContact = await getAiOwnedContact',
    catchIndex
  );

  assert.ok(pauseIndex > catchIndex && fallbackGuardIndex > pauseIndex);
  const block = serverSource.slice(pauseIndex, fallbackGuardIndex);
  assert.match(
    block,
    /pauseAiForHumanHandoff\([\s\S]*Message processing failed\. A staff reply is needed\./
  );
});
