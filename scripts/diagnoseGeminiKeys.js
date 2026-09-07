require("dotenv").config();

const {
  runGeminiKeyModelDiagnostic,
} = require("../src/services/geminiSetupCheckService");
const { credentialFingerprint } = require("../src/services/geminiKeyPool");

function configuredKeySources(env = process.env) {
  const entries = [];
  if (env.GEMINI_API_KEYS) {
    String(env.GEMINI_API_KEYS).split(/[\n,;]/).forEach((value, index) => {
      entries.push({ value, source: `GEMINI_API_KEYS[${index + 1}]` });
    });
  }
  for (const name of [
    "GEMINI_API_KEY",
    "GEMINI_API_KEY_1",
    "GEMINI_API_KEY_2",
    "GEMINI_API_KEY_3",
    "GEMINI_API_KEY_4",
    "GEMINI_API_KEY_5",
  ]) {
    entries.push({ value: env[name], source: name });
  }

  const sources = new Map();
  for (const entry of entries) {
    const value = String(entry.value || "").trim();
    if (!value) continue;
    const fingerprint = credentialFingerprint(value).slice(0, 8);
    if (!sources.has(fingerprint)) sources.set(fingerprint, entry.source);
  }
  return sources;
}

function resultText(item) {
  if (item.status === "ready") {
    const tokens = item.totalTokens ? `, ${item.totalTokens} token${item.totalTokens === 1 ? "" : "s"}` : "";
    return `OK (${item.latencyMs}ms${tokens})`;
  }
  const code = item.httpStatus || item.providerStatus || item.failureKind || item.status;
  return `${String(code).toUpperCase()} (${item.latencyMs}ms)`;
}

async function main() {
  console.log("Gemini diagnostic: tiny real generation, max 1 output token per key/model.");
  console.log("Run this while chatbot traffic is quiet because real requests share project RPM/RPD quota.\n");

  const result = await runGeminiKeyModelDiagnostic({
    timeoutMs: process.env.GEMINI_DIAGNOSTIC_TIMEOUT_MS,
  });
  const sources = configuredKeySources();

  console.log(
    `Configured keys: ${result.configuredKeyCount}. Testing: ${result.keyCount}. ` +
    `Planned requests: ${result.plannedRequests}.`
  );
  if (result.skippedKeyCount > 0) {
    console.log(`${result.skippedKeyCount} configured key${result.skippedKeyCount === 1 ? " was" : "s were"} not tested because the diagnostic is hard-capped at 5 keys.`);
  }
  console.log("");

  const byKey = new Map();
  for (const item of result.results) {
    if (!byKey.has(item.label)) {
      const source = sources.get(item.fingerprint) || "configured key";
      byKey.set(item.label, {
        key: `${item.label} · ${source} · ${item.fingerprint}`,
      });
    }
    const row = byKey.get(item.label);
    row[item.model.replace("gemini-", "")] = resultText(item);
  }

  console.table([...byKey.values()]);
  console.log(
    `\n${result.successfulRequests}/${result.requestsAttempted} attempted requests succeeded; ` +
    `${result.totalTokens} total token${result.totalTokens === 1 ? "" : "s"} reported by completed Gemini responses.`
  );

  if (!result.tokenUsageComplete) {
    console.log("Token usage is incomplete because a timed-out request may still have been processed remotely.");
  }
  if (result.stoppedEarly) {
    console.log(
      `Diagnostic stopped early after ${result.requestsAttempted}/${result.plannedRequests} planned requests; ` +
      `${result.remainingRequests} request${result.remainingRequests === 1 ? "" : "s"} were not started.`
    );
  }

  const failures = result.results.filter((item) => item.status !== "ready");
  if (failures.length) {
    console.log("\nFailures:");
    for (const item of failures) {
      const code = item.httpStatus || item.providerStatus || item.failureKind || item.status;
      console.log(`- ${item.label} ${item.model}: ${code} - ${item.message}`);
    }
  }

  if (result.warnings.length) {
    console.log("\nNotes:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

main().catch((error) => {
  console.error("Gemini diagnostic failed:", error?.message || error);
  process.exitCode = 1;
});
