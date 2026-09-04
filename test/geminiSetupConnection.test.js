const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkAllGeminiConnections,
  checkGeminiConnection,
  isCredentialError,
} = require("../src/services/geminiSetupCheckService");

test("Gemini setup connection check uses models.get and never calls generateContent", async () => {
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

test("all-key Gemini setup check calls models.get once per key and never generates content", async () => {
  const metadataCalls = [];
  let generatedReplies = 0;
  const env = {
    GEMINI_API_KEY: "good-key",
    GEMINI_API_KEY_1: "bad-key",
    GEMINI_API_KEY_2: "unavailable-key",
    GEMINI_MODEL: "gemini-2.5-flash",
  };

  const result = await checkAllGeminiConnections({
    env,
    createClient(apiKey) {
      return {
        models: {
          async get(params) {
            metadataCalls.push({ apiKey, params });
            if (apiKey === "bad-key") {
              const error = new Error("API key not valid. Please pass a valid API key.");
              error.status = 400;
              throw error;
            }
            if (apiKey === "unavailable-key") {
              const error = new Error("Provider temporarily unavailable");
              error.status = 503;
              throw error;
            }
            return { name: "models/gemini-2.5-flash" };
          },
          async generateContent() {
            generatedReplies += 1;
            throw new Error("generateContent must never be called by Setup Status");
          },
        },
      };
    },
  });

  assert.equal(metadataCalls.length, 3);
  assert.deepEqual(
    metadataCalls.map((call) => call.apiKey).sort(),
    ["bad-key", "good-key", "unavailable-key"]
  );
  assert.ok(metadataCalls.every((call) => call.params.model === "gemini-2.5-flash"));
  assert.equal(generatedReplies, 0);
  assert.equal(result.readyCount, 1);
  assert.equal(result.totalCount, 3);
  assert.deepEqual(
    result.results.map(({ label, status, failureKind }) => ({ label, status, failureKind })),
    [
      { label: "Gemini key 1", status: "ready", failureKind: null },
      { label: "Gemini key 2", status: "invalid", failureKind: "authentication" },
      { label: "Gemini key 3", status: "unavailable", failureKind: "temporary_failure" },
    ]
  );
});

test("all-key metadata timeouts are bounded independently without generating content", async () => {
  const attempted = [];
  const env = {
    GEMINI_API_KEY: "key-one",
    GEMINI_API_KEY_1: "key-two",
  };

  const result = await checkAllGeminiConnections({
    env,
    timeoutMs: 100,
    createClient(apiKey) {
      return {
        models: {
          get() {
            attempted.push(apiKey);
            return new Promise(() => {});
          },
          generateContent() {
            throw new Error("generateContent must never be called");
          },
        },
      };
    },
  });

  assert.deepEqual(attempted.sort(), ["key-one", "key-two"]);
  assert.equal(result.readyCount, 0);
  assert.equal(result.totalCount, 2);
  assert.ok(result.results.every((item) => item.status === "unavailable"));
  assert.ok(result.results.every((item) => item.failureKind === "temporary_failure"));
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

test("Gemini setup metadata check is bounded and a timeout does not fan out across keys", async () => {
  const attempted = [];
  const env = {
    GEMINI_API_KEY: "key-one",
    GEMINI_API_KEY_1: "key-two",
  };

  await assert.rejects(
    checkGeminiConnection({
      env,
      timeoutMs: 100,
      createClient(apiKey) {
        return {
          models: {
            get() {
              attempted.push(apiKey);
              return new Promise(() => {});
            },
          },
        };
      },
    }),
    (error) => error.code === "GEMINI_SETUP_CHECK_TIMEOUT"
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
