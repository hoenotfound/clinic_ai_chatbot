const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeUsageEvent, claudeFailureUsageEvent, trackClaudeRequest } = require("../src/services/claudeUsageTelemetry");

test("Claude usage normalization includes reads and writes without exposing text or tokens", () => {
  const result = claudeUsageEvent({
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "PRIVATE CUSTOMER MESSAGE" }],
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
      output_tokens: 30,
    },
  }, { purpose: "customer_reply", contactId: 123, leadId: 456 });
  assert.equal(result.promptTokens, 350);
  assert.equal(result.cachedTokens, 200);
  assert.equal(result.cacheWriteTokens, 50);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.contactId, 123);
  assert.equal(result.leadId, 456);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("failed Claude provider request is recorded with unknown billing and contact evidence", () => {
  const error = Object.assign(new Error("Claude request timed out"), { code: "AI_TIMEOUT" });
  const event = claudeFailureUsageEvent(error, {
    purpose: "follow_up_generation", model: "claude-sonnet-5", contactId: 12, leadId: 55,
    latencyMs: 2500,
  });
  assert.equal(event.status, "failed");
  assert.equal(event.failureKind, "timeout");
  assert.equal(event.responseDisposition, "aborted_without_usage");
  assert.equal(event.promptTokens, 0);
  assert.equal(event.contactId, 12);
  assert.equal(event.leadId, 55);
});

test("Claude tracking wrapper preserves successful response and propagates original provider errors", async () => {
  const response = { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 8 } };
  assert.equal(await trackClaudeRequest(async () => response), response);
  const providerError = Object.assign(new Error("rate limit"), { status: 429 });
  await assert.rejects(
    trackClaudeRequest(async () => { throw providerError; }, { contactId: 99 }),
    (error) => error === providerError
  );
});
