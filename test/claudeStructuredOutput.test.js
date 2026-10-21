const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  DEFAULT_REPLY_EFFORT,
  DEFAULT_REPLY_MAX_TOKENS,
  TRUNCATION_RETRY_MAX_TOKENS,
  buildClaudeOutputSchema,
  buildClaudeMessages,
  getReply,
} = require("../src/services/claudeService");
const { buildCandidates, runCandidate } = require("../src/services/aiService");
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
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    packageQuery: false,
    promotionOption: null,
    treatment: null,
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
  assert.equal(body.max_tokens, DEFAULT_REPLY_MAX_TOKENS);
  assert.equal(body.output_config.effort, DEFAULT_REPLY_EFFORT);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(
    body.output_config.format.schema.required,
    [
      "reply",
      "outcome",
      "serviceQuery",
      "serviceQuerySource",
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
  assert.equal(parsed.details.treatment, null);
});

test("Claude comment automation gets the comment-specific structured schema", () => {
  const schema = buildClaudeOutputSchema({ surface: "comment_automation" });

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.outcome.enum, ["normal", "needs_human"]);
  assert.equal(schema.properties.nextStep.type, "null");
  assert.ok(schema.required.includes("publicReply"));
  assert.ok(schema.required.includes("privateReply"));
  assert.ok(schema.required.includes("shouldRespond"));
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, "serviceQuery"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, "priceQuery"), false);
});

test("Claude truncation retry increases the token cap instead of repeating the same request", async () => {
  const requestBodies = [];
  let call = 0;
  const candidate = {
    label: "Claude primary",
    provider: "claude",
    async run(messages, options, requestControl) {
      return getReply(
        messages,
        options,
        "test-claude-key",
        "wrkspc-test",
        {
          ...requestControl,
          fetchImpl: async (_url, fetchOptions) => {
            requestBodies.push(JSON.parse(fetchOptions.body));
            call += 1;
            if (call === 1) {
              return response({
                type: "message",
                stop_reason: "max_tokens",
                content: [],
              });
            }
            return response({
              type: "message",
              stop_reason: "end_turn",
              content: [{
                type: "text",
                text: JSON.stringify(validConversationReply()),
              }],
            });
          },
        }
      );
    },
  };

  const result = await runCandidate(
    candidate,
    [{ role: "user", content: "hello" }],
    { channel: "whatsapp", isFirstMessage: false },
    1000,
    1,
    { globalBudgetMs: 2000 }
  );

  assert.equal(parseAiReplyResult(result).structured, true);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].max_tokens, DEFAULT_REPLY_MAX_TOKENS);
  assert.equal(requestBodies[1].max_tokens, TRUNCATION_RETRY_MAX_TOKENS);
  assert.equal(requestBodies[0].output_config.effort, DEFAULT_REPLY_EFFORT);
  assert.equal(requestBodies[1].output_config.effort, DEFAULT_REPLY_EFFORT);
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

test("Claude exposes itself as primary when AI_PROVIDER=claude", () => {
  const candidates = buildCandidates({
    AI_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "claude-key",
    ANTHROPIC_WORKSPACE_ID: "wrkspc-test",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-test",
    GEMINI_FALLBACK_MODEL: "",
  });

  assert.equal(candidates[0].provider, "claude");
  assert.equal(candidates[0].label, "Claude primary");
});


test("Claude fallback preserves inbound vision while replacing assistant image attachments with text", async () => {
  const history = [
    { role: "user", content: "我想了解9D" },
    { role: "assistant", content: [
      { type: "text", text: "给你看看9D的介绍" },
      { type: "image", mimeType: "image/png", data: "outgoing-price-image" },
    ] },
    { role: "user", content: [
      { type: "text", text: "我的照片适合这个吗？" },
      { type: "image", mimeType: "image/jpeg", data: "incoming-customer-image" },
    ] },
  ];
  const normalized = buildClaudeMessages(history);
  assert.equal(normalized[1].role, "assistant");
  assert.deepEqual(normalized[1].content[0], {
    type: "text", text: "给你看看9D的介绍",
  });
  assert.equal(normalized[1].content.some(x => x.type === "image"), false);
  assert.match(normalized[1].content[1].text, /Previously sent image attachment/);
  assert.equal(normalized[1].content[1].text.includes("outgoing-price-image"), false);
  assert.deepEqual(normalized[2].content[1], {
    type: "image",
    source: {
      type: "base64", media_type: "image/jpeg", data: "incoming-customer-image",
    },
  });
  let sent = null;
  await getReply(history, { surface: "conversation" }, "test-claude-key", "wrkspc-test", {
    fetchImpl: async (_url, request) => {
      sent = JSON.parse(request.body);
      return response({
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(validConversationReply()) }],
      });
    },
  });
  assert.deepEqual(sent.messages, normalized);
  assert.equal(sent.messages[1].content.some(x => x.type === "image"), false);
});

test("Claude never sends an empty assistant block list for image-only history", () => {
  const messages = buildClaudeMessages([
    { role: "assistant", content: [
      { type: "image", mimeType: "image/png", data: "outgoing-photo" },
      { type: "text", text: "" },
    ] },
    { role: "user", content: [
      { type: "image", mimeType: "image/jpeg", data: "incoming-photo" },
    ] },
  ]);
  assert.ok(messages[0].content.length > 0);
  assert.equal(messages[0].content.every(x => x.type === "text" && x.text), true);
  assert.equal(messages[1].content[0].type, "image");
});
