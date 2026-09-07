const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  runGeminiKeyModelDiagnostic,
} = require("../src/services/geminiSetupCheckService");
const {
  createGeminiDiagnosticGuard,
} = require("../src/routes/setupStatus");

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

test("Gemini diagnostic guard blocks overlap and enforces its server-side cooldown", () => {
  let nowMs = 1_000_000;
  const guard = createGeminiDiagnosticGuard({
    cooldownMs: 10 * 60 * 1000,
    clock: () => nowMs,
  });

  assert.equal(guard.status().remainingMs, 0);
  const lease = guard.start();
  assert.equal(guard.status().inFlight, true);
  assert.throws(
    () => guard.start(),
    (error) => error.code === "GEMINI_DIAGNOSTIC_IN_PROGRESS"
  );

  lease.finish();
  assert.equal(guard.status().inFlight, false);
  assert.equal(guard.status().remainingMs, 10 * 60 * 1000);
  assert.throws(
    () => guard.start(),
    (error) => error.code === "GEMINI_DIAGNOSTIC_COOLDOWN"
  );

  nowMs += 10 * 60 * 1000;
  const secondLease = guard.start();
  assert.equal(guard.status().inFlight, true);
  secondLease.finish();
});

test("real-generation Gemini diagnostic routes are behind setup-status admin middleware", () => {
  const route = fs.readFileSync(
    path.join(__dirname, "..", "src/routes/setupStatus.js"),
    "utf8"
  );
  const authIndex = route.indexOf("router.use(requireAdministrator)");
  const statusIndex = route.indexOf('router.get("/gemini-diagnostic/status"');
  const runIndex = route.indexOf('router.post("/gemini-diagnostic"');

  assert.ok(authIndex >= 0);
  assert.ok(statusIndex > authIndex);
  assert.ok(runIndex > authIndex);
  assert.match(route, /GEMINI_DIAGNOSTIC_COOLDOWN_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
});
