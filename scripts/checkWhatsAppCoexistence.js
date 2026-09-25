#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  getCoexistenceStatus,
} = require("../src/services/whatsappCoexistenceApi");

function usage() {
  return `
Read-only check for WhatsApp Business App + Cloud API coexistence status.

Usage:
  npm run whatsapp-coexistence:status -- --runtime-env-file <path> [options]

Options:
  --phone-number-id <id>      Override WHATSAPP_PHONE_NUMBER_ID from the env file
  --runtime-env-file <path>   dotenv containing WHATSAPP_TOKEN and phone number ID
  --graph-version <version>   Meta Graph API version, default v26.0
  --json                      Print machine-readable output
  --help                      Show this help

This command is read-only. It never registers, migrates, syncs or changes a
WhatsApp number. Access tokens are intentionally not accepted as CLI flags.
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
    const result = await getCoexistenceStatus({
      phoneNumberId: args.phoneNumberId || runtimeEnv.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: runtimeEnv.WHATSAPP_TOKEN,
      graphVersion: args.graphVersion || process.env.META_GRAPH_API_VERSION,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("WhatsApp coexistence status");
    console.log(`Phone Number ID: ${result.phoneNumberId}`);
    console.log(`Business App:    ${result.isOnBusinessApp ? "yes" : "no"}`);
    console.log(`Platform:        ${result.platformType || "unknown"}`);
    console.log(`Coexistence:     ${result.ready ? "READY" : "NOT READY"}`);
  } catch (err) {
    console.error(`WhatsApp coexistence status check failed: ${err.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  loadRuntimeEnv,
  parseArgs,
  usage,
};
