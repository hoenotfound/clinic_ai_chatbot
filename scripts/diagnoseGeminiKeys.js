require("dotenv").config();

const {
  runGeminiKeyModelDiagnostic,
} = require("../src/services/geminiSetupCheckService");

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
  console.log("This consumes request quota: with 5 keys it makes up to 5 requests per model.\n");

  const result = await runGeminiKeyModelDiagnostic({
    timeoutMs: process.env.GEMINI_DIAGNOSTIC_TIMEOUT_MS,
  });

  const byKey = new Map();
  for (const item of result.results) {
    if (!byKey.has(item.label)) {
      byKey.set(item.label, {
        key: `${item.label} (${item.fingerprint})`,
      });
    }
    const row = byKey.get(item.label);
    row[item.model.replace("gemini-", "")] = resultText(item);
  }

  console.table([...byKey.values()]);
  console.log(
    `\n${result.successfulRequests}/${result.requestsAttempted} requests succeeded; ` +
    `${result.totalTokens} total token${result.totalTokens === 1 ? "" : "s"} reported by Gemini.`
  );

  const failures = result.results.filter((item) => item.status !== "ready");
  if (failures.length) {
    console.log("\nFailures:");
    for (const item of failures) {
      const code = item.httpStatus || item.providerStatus || item.failureKind || item.status;
      console.log(`- ${item.label} ${item.model}: ${code} - ${item.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Gemini diagnostic failed:", error?.message || error);
  process.exitCode = 1;
});
