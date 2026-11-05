"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildScopedReplyPrompt } = require("../src/utils/scopedReplyPrompt");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
test("unscoped reply stays unchanged", () => {
  const o = { surface: "conversation", conversationContext: { relevantServiceNames: [] } };
  assert.equal(buildScopedReplyPrompt(o), buildSystemPrompt(o));
});
