#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  getWhatsAppCoexistenceStatus,
} = require("../src/provisioning/whatsappWebhookSubscription");

function usage() {
  return `
Check whether a WhatsApp phone number is active on both the Business app and Cloud API.

Usage:
  npm run whatsapp-coexistence:status -- --runtime-env-file <path> [options]

Options:
  --phone-number-id <id>      Override WHATSAPP_PHONE_NUMBER_ID from runtime env
  --runtime-env-file <path>   Client runtime env file
  --graph-version <version>   Meta Graph API version, default v26.0
  --json                      Print machine-readable output
  --help                      Show this help

The command is read-only. It never registers, migrates, or changes the phone
number. It prefers WHATSAPP_MANAGEMENT_TOKEN from the operator environment and
falls back to WHATSAPP_TOKEN from the runtime env. Tokens are intentionally not
accepted as command-line arguments.
`;
}

function parseArgs(argv) {
  const result = { json: false };
  const valueFlags = new Map([
    ["--phone-number-id", "phoneNumberId"],
    ["--runtime-env-file", "runtimeEnvFile"],
    ["--graph-version", "graphVersion"],
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

function loadRuntimeEnv(filePath) {
  if (!filePath) throw new Error("--runtime-env-file is required.");
  const absolute = path.resolve(process.cwd(), filePath);
  return dotenv.parse(fs.readFileSync(absolute));
}

function selectAccessToken(runtimeEnv) {
  return String(
    process.env.WHATSAPP_MANAGEMENT_TOKEN || runtimeEnv.WHATSAPP_TOKEN || ""
  ).trim();
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

  try {
    const runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    const result = await getWhatsAppCoexistenceStatus({
      phoneNumberId: args.phoneNumberId || runtimeEnv.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: selectAccessToken(runtimeEnv),
      graphVersion: args.graphVersion || process.env.META_GRAPH_API_VERSION,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("WhatsApp coexistence status");
    console.log(`Phone Number ID: ${result.phoneNumberId}`);
    console.log(`On Business App: ${result.isOnBizApp ? "yes" : "no"}`);
    console.log(`Platform:        ${result.platformType || "unknown"}`);
    console.log(`Coexistence:     ${result.coexistenceReady ? "ready" : "not confirmed"}`);
  } catch (err) {
    console.error(`WhatsApp coexistence status check failed: ${err.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  loadRuntimeEnv,
  parseArgs,
  selectAccessToken,
  usage,
};
