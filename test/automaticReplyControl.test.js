const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTOMATED_REPLIES_ENV_KEY,
  automatedRepliesEnabled,
} = require("../src/services/automaticReplyControl");

test("legacy deployments remain enabled when the switch is absent", () => {
  assert.equal(automatedRepliesEnabled({}), true);
});

test("the switch enables automation only for an explicit true value", () => {
  assert.equal(automatedRepliesEnabled({ [AUTOMATED_REPLIES_ENV_KEY]: "true" }), true);
  assert.equal(automatedRepliesEnabled({ [AUTOMATED_REPLIES_ENV_KEY]: " TRUE " }), true);
  assert.equal(automatedRepliesEnabled({ [AUTOMATED_REPLIES_ENV_KEY]: "false" }), false);
  assert.equal(automatedRepliesEnabled({ [AUTOMATED_REPLIES_ENV_KEY]: "" }), false);
  assert.equal(automatedRepliesEnabled({ [AUTOMATED_REPLIES_ENV_KEY]: "typo" }), false);
});
