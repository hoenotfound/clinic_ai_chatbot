const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkGeminiConnection,
  isCredentialError,
} = require("../src/services/geminiSetupCheckService");

test("Gemini setup connection check uses models.get and consumes no generation call", async () => {
  const calls = [];
  const env = {
    GEMINI_API_KEY: "key-one",
    GEMINI_MODEL: "gemini-2.5-flash",
  };

  const result = await checkGeminiConnection({
    env,
    createClient(apiKey) {
      assert.equal(apiKey, "key-one");
      return {
        models: {
          async get(params) {
            calls.push({ method: "get", params });
            return {
              name: "models/gemini-2.5-flash",
              supportedActions: ["generateContent", "countTokens"],
            };
          },
          async generateContent() {
            calls.push({ method: "generateContent" });
            throw new Error("generateContent must not be called by Setup Status");
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [
    { method: "get", params: { model: "gemini-2.5-flash" } },
  ]);
  assert.equal(result.keyLabel, "Gemini key 1");
  assert.equal(result.model, "gemini-2.5-flash");
});

test("Gemini setup check only tries another key when credentials are rejected", async () => {
  const attempted = [];
  const env = {
    GEMINI_API_KEY: "bad-key",
    GEMINI_API_KEY_1: "good-key",
    GEMINI_API_KEY_2: "unused-key",
    GEMINI_MODEL: "gemini-2.5-flash",
  };

  const result = await checkGeminiConnection({
    env,
    createClient(apiKey) {
      return {
        models: {
          async get() {
            attempted.push(apiKey);
            if (apiKey === "bad-key") {
              const error = new Error("API key not valid. Please pass a valid API key.");
              error.status = 400;
              throw error;
            }
            return { name: "models/gemini-2.5-flash" };
          },
        },
      };
    },
  });

  assert.deepEqual(attempted, ["bad-key", "good-key"]);
  assert.equal(result.keyLabel, "Gemini key 2");
});

test("Gemini setup check does not fan out across keys for provider/model failures", async () => {
  const attempted = [];
  const env = {
    GEMINI_API_KEY: "key-one",
    GEMINI_API_KEY_1: "key-two",
    GEMINI_API_KEY_2: "key-three",
  };
  const error = new Error("Provider temporarily unavailable");
  error.status = 503;

  await assert.rejects(
    checkGeminiConnection({
      env,
      createClient(apiKey) {
        return {
          models: {
            async get() {
              attempted.push(apiKey);
              throw error;
            },
          },
        };
      },
    }),
    (caught) => caught === error
  );

  assert.deepEqual(attempted, ["key-one"]);
});

test("credential classifier recognizes invalid API-key errors without treating 503 as a bad key", () => {
  const invalid = new Error("API key not valid. Please pass a valid API key.");
  invalid.status = 400;
  assert.equal(isCredentialError(invalid), true);

  const unavailable = new Error("Model unavailable");
  unavailable.status = 503;
  assert.equal(isCredentialError(unavailable), false);
});
