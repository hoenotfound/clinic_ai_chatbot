#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  ClientReadinessError,
  normalizeRequiredChannels,
  verificationFailureReport,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");
const { redactSensitiveText } = require("../src/provisioning/providerClients");

const NEEDS_ATTENTION_EXIT_CODE = 3;
const VERIFICATION_FAILED_EXIT_CODE = 4;

function usage() {
  return `
Re-run client go-live readiness checks without changing Render, Neon, app config,
or messaging data.

Preferred usage with a provisioning receipt:
  npm run verify-client -- \
    --receipt .provisioning/<client>.json \
    --runtime-env-file ./<client>.client-runtime.env

Or specify the contract directly:
  npm run verify-client -- \
    --url https://<service>.onrender.com \
    --industry home_renovation \
    --channels whatsapp,instagram \
    --runtime-env-file ./<client>.client-runtime.env

Required credentials:
  The local runtime env file must contain ADMIN_USERNAME and ADMIN_PASSWORD.
  ADMIN_PASSWORD can already be removed from Render after provisioning; the
  local value remains the portal administrator password stored in PostgreSQL.
  Passwords are intentionally not accepted as CLI flags.

Options:
  --receipt <path>            Secret-free receipt written by provision-client
  --url <url>                 Client portal URL (when not using --receipt)
  --industry <profile>        Expected business profile
  --channels <csv>            Required channels
  --runtime-env-file <path>   Local client dotenv with admin credentials
  --json                      Machine-readable output
  --help                      Show this help

Exit codes:
  0  READY / READY WITH WARNINGS
  2  Invalid verifier input
  3  Verification completed but client NEEDS ATTENTION
  4  Client could not be fully verified (login/transport/Setup Status failure)
`;
}

function parseArgs(argv) {
  const result = { json: false };
  const valueFlags = new Map([
    ["--receipt", "receiptPath"],
    ["--url", "url"],
    ["--industry", "industry"],
    ["--channels", "channels"],
    ["--runtime-env-file", "runtimeEnvFile"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    const field = valueFlags.get(arg);
    if (!field) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    result[field] = value;
    index += 1;
  }
  return result;
}

function readJsonFile(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function loadRuntimeEnv(filePath) {
  if (!filePath) return {};
  const absolute = path.resolve(process.cwd(), filePath);
  return dotenv.parse(fs.readFileSync(absolute));
}

function resolveContract(args) {
  let receipt = null;
  if (args.receiptPath) receipt = readJsonFile(args.receiptPath);

  const url = args.url || receipt?.render?.url;
  const industry = args.industry || receipt?.industry;
  const channels = normalizeRequiredChannels(args.channels || receipt?.requiredChannels || []);
  if (!url) throw new ClientReadinessError("Client URL is required. Supply --url or a receipt containing render.url.", {
    code: "READINESS_URL_REQUIRED",
    stage: "validation",
  });
  if (!industry) throw new ClientReadinessError("Expected industry is required. Supply --industry or a provisioning receipt.", {
    code: "READINESS_INDUSTRY_REQUIRED",
    stage: "validation",
  });
  return { url, industry, channels, receipt };
}

function updateReceiptReadiness(receiptPath, receipt, report) {
  if (!receiptPath || !receipt) return null;
  const absolute = path.resolve(process.cwd(), receiptPath);
  const tempPath = `${absolute}.${process.pid}.tmp`;
  const updated = {
    ...receipt,
    version: Math.max(3, Number(receipt.version) || 0),
    lastVerifiedAt: report.checkedAt || new Date().toISOString(),
    readiness: JSON.parse(JSON.stringify(report)),
  };
  fs.writeFileSync(tempPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, absolute);
  return updated;
}

function readinessLabel(report) {
  if (report?.status === "ready_with_warnings") return "READY WITH WARNINGS";
  if (report?.status === "verification_failed") return "VERIFICATION FAILED";
  return report?.ready ? "READY" : "NEEDS ATTENTION";
}

function printHuman(report, receiptWarning = null) {
  console.log(`Client readiness: ${readinessLabel(report)}\n`);
  console.log(`Industry: ${report.actualIndustry || "unknown"} (expected ${report.expectedIndustry || "unknown"})`);
  console.log(`Channels: ${(report.requiredChannels || []).join(", ")}`);

  if (report.businessProfile) {
    console.log(`${report.businessProfile.status === "ready" ? "[OK]" : "[!!]"} Business profile: ${report.businessProfile.summary}`);
  }
  for (const item of report.applicationChecks || []) {
    console.log(`${item.configured && item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  for (const item of report.channelChecks || []) {
    console.log(`${item.configured && item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  if (report.warnings?.length) {
    console.log("\nWarnings:");
    for (const item of report.warnings) console.log(`- ${item.summary}`);
  }
  if (report.blocking?.length) {
    console.log("\nNeeds attention:");
    for (const item of report.blocking) console.log(`- ${item.summary}`);
  }
  if (receiptWarning) console.log(`\nReceipt warning: ${receiptWarning}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  let runtimeEnv = {};
  let contract = null;
  try {
    runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    contract = resolveContract(args);
    const username = String(runtimeEnv.ADMIN_USERNAME || "").trim();
    const password = runtimeEnv.ADMIN_PASSWORD;
    if (!username || typeof password !== "string" || !password) {
      throw new ClientReadinessError(
        "ADMIN_USERNAME and ADMIN_PASSWORD are required in --runtime-env-file.",
        { code: "READINESS_ADMIN_CREDENTIALS_REQUIRED", stage: "validation" }
      );
    }

    let report;
    try {
      report = await verifyClientReadiness({
        baseUrl: contract.url,
        username,
        password,
        expectedIndustry: contract.industry,
        requiredChannels: contract.channels,
      });
    } catch (err) {
      if (err instanceof ClientReadinessError && err.stage !== "validation") {
        report = verificationFailureReport(err, {
          expectedIndustry: contract.industry,
          requiredChannels: contract.channels,
        });
      } else {
        throw err;
      }
    }

    let receiptWarning = null;
    if (args.receiptPath && contract.receipt) {
      try {
        updateReceiptReadiness(args.receiptPath, contract.receipt, report);
      } catch (err) {
        receiptWarning = redactSensitiveText(
          `Could not update readiness receipt: ${err.message}`,
          Object.values(runtimeEnv || {}).filter(Boolean)
        );
      }
    }

    const output = receiptWarning ? { ...report, receiptWarning } : report;
    if (args.json) console.log(JSON.stringify(output, null, 2));
    else printHuman(report, receiptWarning);

    if (report.status === "verification_failed") {
      process.exitCode = VERIFICATION_FAILED_EXIT_CODE;
    } else if (!report.ready) {
      process.exitCode = NEEDS_ATTENTION_EXIT_CODE;
    }
  } catch (err) {
    const sensitiveValues = Object.values(runtimeEnv || {}).filter(Boolean);
    const message = redactSensitiveText(err?.message || "Readiness verification failed", sensitiveValues);
    const output = {
      error: message,
      code: err?.code || "READINESS_COMMAND_FAILED",
      stage: err?.stage || null,
    };
    if (args?.json) console.error(JSON.stringify(output, null, 2));
    else console.error(`Readiness verification stopped: ${message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  NEEDS_ATTENTION_EXIT_CODE,
  VERIFICATION_FAILED_EXIT_CODE,
  loadRuntimeEnv,
  parseArgs,
  readJsonFile,
  resolveContract,
  updateReceiptReadiness,
};