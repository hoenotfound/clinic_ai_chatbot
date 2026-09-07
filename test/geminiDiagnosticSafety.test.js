const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  runGeminiKeyModelDiagnostic,
} = require("../src/services/geminiSetupCheckService");

test("Gemini diagnostic hard-caps runtime keys at five and reports skipped credentials", async () => {
  const attempted = [];
  const env = {
    GEMINI_API_KEY: "key-0",
    GEMINI_API_KEY_1: "key-1",
    GEMINI_API_KEY_2: "key-2",
    GEMINI_API_KEY_3: "key-3",
    GEMINI_API_KEY_4: "key-4",
    GEMINI_API_KEY_5: "key-5",
  };

  const result = await runGeminiKeyModelDiagnostic({
    env,
    maxKeys: 99,
    models: ["gemini-3.8-flash"],
    createClient(apiKey) {
      return {
        models: {
          async generateContent() {
            attempted.push(apiKey);
            return { usageMetadata: { totalTokenCount: 1 } };
          },
        },
      };
    },
  });

  assert.deepEqual(attempted, ["key-0", "key-1", "key-2", "key-3", "key-4"]);
  assert.equal(result.configuredKeyCount, 6);
  assert.equal(result.keyCount, 5);
  assert.equal(result.skippedKeyCount, 1);
  assert.equal(result.plannedRequests, 5);
  assert.match(result.warnings.join("\n"), /first 5 of 6 configured runtime Gemini keys/i);
});

test("Gemini diagnostic aborts locally and stops all later tests after a timeout", async () => {
  const attempted = [];
  let abortObserved = false;
  const env = {
    GEMINI_API_KEY: "key-one",
    GEMINI_API_KEY_1: "key-two",
  };

  const result = await runGeminiKeyModelDiagnostic({
    env,
    timeoutMs: 500,
    createClient(apiKey) {
      return {
        models: {
          generateContent(request) {
            attempted.push({ apiKey, model: request.model });
            const signal = request.config.abortSignal;
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                abortObserved = true;
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            });
          },
        },
      };
    },
  });

  assert.deepEqual(attempted, [
    { apiKey: "key-one", model: "gemini-3.8-flash" },
  ]);
  assert.equal(abortObserved, true);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.stopReason, "timeout");
  assert.equal(result.requestsAttempted, 1);
  assert.equal(result.plannedRequests, 4);
  assert.equal(result.remainingRequests, 3);
  assert.equal(result.tokenUsageComplete, false);
  assert.equal(result.results[0].failureKind, "timeout");
  assert.match(result.warnings.join("\n"), /stopped after a timeout/i);
});

test("Gemini diagnostic warns that a single 429 is not key-specific proof", async () => {
  const result = await runGeminiKeyModelDiagnostic({
    env: { GEMINI_API_KEY: "key-one" },
    models: ["gemini-3.8-flash"],
    createClient() {
      return {
        models: {
          async generateContent() {
            const error = new Error("Too many requests");
            error.status = 429;
            throw error;
          },
        },
      };
    },
  });

  assert.equal(result.results[0].status, "rate_limited");
  assert.equal(result.results[0].failureKind, "rate_limit");
  assert.match(result.warnings.join("\n"), /RATE LIMIT/);
  assert.match(result.warnings.join("\n"), /live chatbot traffic/i);
});

test("real-generation Gemini diagnostic is CLI-only and has no HTTP route", () => {
  const route = fs.readFileSync(
    path.join(__dirname, "..", "src/routes/setupStatus.js"),
    "utf8"
  );
  assert.doesNotMatch(route, /gemini-diagnostic/);
});
