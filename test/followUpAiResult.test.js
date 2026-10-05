const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFollowUpAiResult } = require("../src/utils/followUpAiResult");

test("parses a structured send decision", () => {
  assert.deepEqual(
    parseFollowUpAiResult(JSON.stringify({
      action: "send",
      message: "刚才你有问到大小脸的问题，如果还有哪里不确定可以直接问我 😊",
      reason: "The customer showed interest but did not continue.",
      topic: "3D 小颜术",
    })),
    {
      action: "send",
      message: "刚才你有问到大小脸的问题，如果还有哪里不确定可以直接问我 😊",
      reason: "The customer showed interest but did not continue.",
      topic: "3D 小颜术",
    }
  );
});

test("requires a reason for skip and human review", () => {
  assert.throws(
    () => parseFollowUpAiResult('{"action":"skip","message":"","reason":"","topic":""}'),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
  assert.equal(
    parseFollowUpAiResult('{"action":"human_review","message":"","reason":"Complaint needs staff.","topic":""}').action,
    "human_review"
  );
});

test("rejects unstructured or internally leaked follow-up output", () => {
  assert.throws(
    () => parseFollowUpAiResult("Just send a reminder"),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
  assert.throws(
    () => parseFollowUpAiResult(JSON.stringify({
      action: "send",
      message: 'Structured output: {"action":"send"}',
      reason: "x",
      topic: "",
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});
