const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeUsageEvent } = require("../src/services/claudeUsageTelemetry");

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
