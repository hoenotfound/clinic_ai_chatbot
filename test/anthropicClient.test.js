const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnthropicClientOptions,
  normalizeWorkspaceId,
} = require("../src/services/anthropicClient");

test("Anthropic client adds workspace header only when configured", () => {
  assert.deepEqual(
    buildAnthropicClientOptions({ apiKey: "key-a", workspaceId: "ws_123" }),
    {
      apiKey: "key-a",
      maxRetries: 0,
      defaultHeaders: {
        "anthropic-workspace-id": "ws_123",
      },
    }
  );

  assert.deepEqual(
    buildAnthropicClientOptions({ apiKey: "key-a", workspaceId: "   " }),
    {
      apiKey: "key-a",
      maxRetries: 0,
    }
  );
});

test("Anthropic workspace IDs are trimmed and missing keys fail clearly", () => {
  assert.equal(normalizeWorkspaceId("  ws_abc  "), "ws_abc");
  assert.throws(
    () => buildAnthropicClientOptions({ apiKey: "", workspaceId: "ws_abc" }),
    (err) => err.code === "AI_PROVIDER_NOT_CONFIGURED"
  );
});
