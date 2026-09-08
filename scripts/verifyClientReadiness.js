#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  ClientReadinessError,
  normalizeRequiredChannels,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");
const { redactSensitiveText } = require("../src/provisioning/providerClients");

const NEEDS_ATTENTION_EXIT_CODE = 3;

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
  The runtime env file must contain ADMIN_USERNAME and ADMIN_PASSWORD.
  Passwords are intentionally not accepted as CLI flags so they do not enter
  shell history.

Options:
  --receipt <path>            Secret-free receipt written by provision-client
  --url <url>                 Client portal URL (when not using --receipt)
  --industry <profile>        Expected business profile
  --channels <csv>            Required channels
  --runtime-env-file <path>   Client runtime dotenv with admin credentials
  --json                      Machine-readable output
  --help                      Show this help

Exit codes:
  0  READY
  2  Verification/input failure
  3  Verification completed but client NEEDS ATTENTION
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
  return { url, industry, channels };
}

function printHuman(report) {
  console.log(`Client readiness: ${report.ready ? "READY" : "NEEDS ATTENTION"}\n`);
  console.log(`Industry: ${report.actualIndustry || "unknown"} (expected ${report.expectedIndustry})`);
  console.log(`Channels: ${(report.requiredChannels || []).join(", ")}`);

  if (report.businessProfile) {
    console.log(`${report.businessProfile.status === "ready" ? "[OK]" : "[!!]"} Business profile: ${report.businessProfile.summary}`);
  }
  for (const item of report.applicationChecks || []) {
    console.log(`${item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  for (const item of report.channelChecks || []) {
    console.log(`${item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }

  if (report.blocking?.length) {
    console.log("\nNeeds attention:");
    for (const item of report.blocking) console.log(`- ${item.summary}`);
  }
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
  try {
    runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    const contract = resolveContract(args);
    const username = String(runtimeEnv.ADMIN_USERNAME || "").trim();
    const password = runtimeEnv.ADMIN_PASSWORD;
    if (!username || typeof password !== "string" || !password) {
      throw new ClientReadinessError(
        "ADMIN_USERNAME and ADMIN_PASSWORD are required in --runtime-env-file.",
        { code: "READINESS_ADMIN_CREDENTIALS_REQUIRED", stage: "validation" }
      );
    }

    const report = await verifyClientReadiness({
      baseUrl: contract.url,
      username,
      password,
      expectedIndustry: contract.industry,
      requiredChannels: contract.channels,
    });

    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.ready) process.exitCode = NEEDS_ATTENTION_EXIT_CODE;
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
  loadRuntimeEnv,
  parseArgs,
  readJsonFile,
  resolveContract,
};
