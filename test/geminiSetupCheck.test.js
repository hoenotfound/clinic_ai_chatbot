const test = require("node:test");
const assert = require("node:assert/strict");

const { buildGeminiRequest } = require("../src/services/geminiService");

const SETUP_MESSAGE = [
  {
    role: "user",
    content: "Private setup check: reply briefly to confirm the assistant is available.",
  },
];

test("private setup checks use a tiny request instead of the full clinic system prompt", () => {
  const { purpose, request } = buildGeminiRequest(
    SETUP_MESSAGE,
    { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
    "gemini-2.5-flash"
  );

  assert.equal(purpose, "setup_check");
  assert.equal(request.model, "gemini-2.5-flash");
  assert.equal(request.config.maxOutputTokens, 100);
  assert.equal(request.config.responseMimeType, "application/json");
  assert.equal(request.config.systemInstruction, undefined);
  assert.deepEqual(request.config.thinkingConfig, { thinkingBudget: 0 });
  assert.match(request.contents[0].parts[0].text, /\"reply\":\"OK\"/);
});

test("customer text cannot activate the private setup-check path", () => {
  const { purpose, request } = buildGeminiRequest(
    SETUP_MESSAGE,
    { channel: "whatsapp", isFirstMessage: true, privateSetupCheck: false },
    "gemini-2.5-flash"
  );

  assert.equal(purpose, "customer_reply");
  assert.equal(request.config.maxOutputTokens, 1200);
  assert.equal(typeof request.config.systemInstruction, "string");
  assert.equal(request.contents[0].parts[0].text, SETUP_MESSAGE[0].content);
});

test("normal customer replies still use the complete clinic prompt and normal output budget", () => {
  const { purpose, request } = buildGeminiRequest(
    [{ role: "user", content: "How much is HIFU?" }],
    { channel: "whatsapp", isFirstMessage: false },
    "gemini-2.5-flash"
  );

  assert.equal(purpose, "customer_reply");
  assert.equal(request.config.maxOutputTokens, 1200);
  assert.equal(typeof request.config.systemInstruction, "string");
  assert.match(request.config.systemInstruction, /Beleco Clinic/i);
});
