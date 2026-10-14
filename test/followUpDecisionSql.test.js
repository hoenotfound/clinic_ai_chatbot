const test = require("node:test");
const assert = require("node:assert/strict");
const {
  continuableFollowUpSkipSql,
  terminalFollowUpDecisionSql,
  normalizeFollowUpDecision,
} = require("../src/utils/followUpDecisionSql");

test("only explicit step skips may advance, while all old skips remain terminal", () => {
  const terminal = terminalFollowUpDecisionSql("d");
  const continuable = continuableFollowUpSkipSql("d");
  assert.match(terminal, /d\.action = 'human_review'/);
  assert.match(terminal, /d\.reason IS NULL OR d\.reason NOT LIKE 'step_skip:%'/);
  assert.match(continuable, /d\.reason LIKE 'step_skip:%'/);
  assert.throws(() => terminalFollowUpDecisionSql("d; DROP TABLE contacts"), TypeError);
  assert.throws(() => continuableFollowUpSkipSql("d; DROP TABLE contacts"), TypeError);
});

test("new step skips and conversation stops have different durable formats", () => {
  assert.deepEqual(normalizeFollowUpDecision({
    action: "skip", reason: "Photos have already been shared",
  }), { action: "skip", reason: "step_skip: Photos have already been shared" });
  assert.deepEqual(normalizeFollowUpDecision({
    action: "stop_sequence", reason: "Customer will contact us later",
  }), { action: "skip", reason: "sequence_stop: Customer will contact us later" });
  assert.deepEqual(normalizeFollowUpDecision({
    action: "human_review", reason: "Needs staff",
  }), { action: "human_review", reason: "Needs staff" });
});
