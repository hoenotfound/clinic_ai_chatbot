#!/usr/bin/env node
"use strict";
require("dotenv").config();

const {
  loadRuntimeEnv,
  selectAccessToken,
} = require("./checkWhatsAppCoexistenceStatus");
const { verifyWhatsAppSenderMapping } = require("../src/provisioning/whatsappSenderVerification");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { args.help = true; continue; }
    if (!["--runtime-env-file", "--client-url"].includes(arg)) {
      throw new Error(`Unexpected flag: ${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg === "--runtime-env-file" ? "runtimeEnvFile" : "clientUrl"] = value;
  }
  return args;
}

function usage() {
  return [
    "Verify shared-app WhatsApp phone/account ownership and webhook callback (READ-ONLY).",
    "",
    "npm run whatsapp-sender:verify -- --runtime-env-file ./client-runtime.env --client-url https://your-client.onrender.com",
    "",
    "Uses WHATSAPP_MANAGEMENT_TOKEN from operator environment if provided,",
    "otherwise WHATSAPP_TOKEN from the client runtime env. Never passes a token",
    "as a CLI argument or prints token values.",
    "Reads WHATSAPP_WABA_ID, WHATSAPP_PHONE_NUMBER_ID and META_APP_ID",
    "from the client runtime env. Does NOT configure or subscribe anything.",
  ].join("\n");
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return console.log(usage());
    if (!args.runtimeEnvFile || !args.clientUrl) throw new Error(usage());
    const env = loadRuntimeEnv(args.runtimeEnvFile);
    const result = await verifyWhatsAppSenderMapping({
      wabaId: env.WHATSAPP_WABA_ID,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appId: env.META_APP_ID || process.env.META_APP_ID,
      clientBaseUrl: args.clientUrl,
      accessToken: selectAccessToken(env),
      graphVersion: env.META_GRAPH_API_VERSION || process.env.META_GRAPH_API_VERSION,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.verified) process.exitCode = 2;
  } catch (err) {
    console.error(`Read-only sender verification was inconclusive: ${err.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) void main();

module.exports = { parseArgs, usage };
