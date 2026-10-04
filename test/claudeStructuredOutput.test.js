const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  buildClaudeOutputSchema,
  getReply,
} = require("../src/services/claudeService");
const { buildCandidates } = require("../src/services/aiService");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function validConversationReply() {
  return {
    reply: "可以的，你想先了解3D小颜术哪一方面呢？",
    outcome: "normal",
    priceQuery: false,
    packageQuery: false,
    promotionOption: null,
    treatment: "3D 小颜术",
    branch: null,
    appointmentPreference: null,
    projectLocation: null,
    projectSummary: null,
    nextStep: null,
    staffSummary: null,
  };
}

test("Claude customer replies use native structured outputs and the workspace header", async () => {
  let request = null;
  const structured = validConversationReply();

  const raw = await getReply(
    [{ role: "user", content: "3D小颜术是什么？" }],
    { channel: "whatsapp", isFirstMessage: false },
    "test-claude-key",
    " wrkspc_test_123 ",
    {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return response({
          type: "message",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(structured) }],
        });
      },
    }
  );

  assert.equal(request.url, ANTHROPIC_MESSAGES_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-api-key"], "test-claude-key");
  assert.equal(request.options.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(request.options.headers["anthropic-workspace-id"], "wrkspc_test_123");

  const body = JSON.parse(request.options.body);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(
    body.output_config.format.schema.required,
    [
      "reply",
      "outcome",
      "priceQuery",
      "packageQuery",
      "promotionOption",
      "treatment",
      "branch",
      "appointmentPreference",
      "projectLocation",
      "projectSummary",
      "nextStep",
      "staffSummary",
    ]
  );

  const parsed = parseAiReplyResult(raw);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.outcome, "normal");
  assert.equal(parsed.text, structured.reply);
  assert.equal(parsed.details.treatment, "3D 小颜术");
});

test("Claude comment automation gets the comment-specific structured schema", () => {
  const schema = buildClaudeOutputSchema({ surface: "comment_automation" });

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.outcome.enum, ["normal", "needs_human"]);
  assert.equal(schema.properties.nextStep.type, "null");
  assert.ok(schema.required.includes("publicReply"));
  assert.ok(schema.required.includes("privateReply"));
  assert.ok(schema.required.includes("shouldRespond"));
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, "priceQuery"), false);
});

test("Claude API errors preserve workspace configuration failures for health classification", async () => {
  await assert.rejects(
    getReply(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false },
      "test-claude-key",
      null,
      {
        fetchImpl: async () => response(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.",
            },
          },
          { ok: false, status: 400 }
        ),
      }
    ),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.provider, "claude");
      assert.match(err.message, /anthropic-workspace-id/i);
      return true;
    }
  );
});

test("Claude logs itself as primary when AI_PROVIDER=claude without changing the persisted health label", () => {
  const candidates = buildCandidates({
    AI_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "claude-key",
    ANTHROPIC_WORKSPACE_ID: "wrkspc-test",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-test",
    GEMINI_FALLBACK_MODEL: "",
  });

  assert.equal(candidates[0].provider, "claude");
  assert.equal(candidates[0].label, "Claude fallback");
  assert.equal(candidates[0].logLabel, "Claude primary");
});
