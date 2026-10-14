const test = require("node:test");
const assert = require("node:assert/strict");
const { terminalFollowUpDecisionSql } = require("../src/utils/followUpDecisionSql");

test("terminal decision SQL blocks staff cancellations and explicit stop requests only", () => {
  const sql = terminalFollowUpDecisionSql("d");
  assert.match(sql, /d\.action = 'human_review'/);
  assert.match(sql, /d\.action = 'skip'/);
  assert.match(sql, /Cancelled because%/);
  assert.match(sql, /stop messaging/);
  assert.doesNotMatch(sql, /multiple result photos|introductory info/);
  assert.throws(() => terminalFollowUpDecisionSql("d; DROP TABLE contacts"), TypeError);
});
