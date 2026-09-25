#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  configureWhatsAppWebhook,
} = require("../src/provisioning/whatsappWebhookSubscription");

function usage() {
  return `
Configure the per-WABA WhatsApp callback override for one client deployment.

Usage:
  npm run whatsapp-webhook:configure -- --client-url <https://client...> --runtime-env-file <path> [options]

Options:
  --waba-id <id>              Override WHATSAPP_WABA_ID from the runtime env file
  --app-id <id>               Confirm the returned subscription belongs to this Meta app
  --client-url <url>          Client Render/public base URL
  --runtime-env-file <path>   dotenv containing WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN,
                              and normally WHATSAPP_WABA_ID
  --graph-version <version>   Meta Graph API version, default v26.0
  --coexistence               Subscribe messages + coexistence webhook fields
  --json                      Print machine-readable output
  --help                      Show this help

The command first performs the same verification-token handshake against the
client /webhook endpoint, then updates the WABA subscription and reads it back.
For the Meta management calls it prefers WHATSAPP_MANAGEMENT_TOKEN from the
operator shell. Keep that management token out of the client Render/runtime env.
If it is not supplied, the client's WHATSAPP_TOKEN is used as a backwards-
compatible fallback and must itself have whatsapp_business_management access.
Tokens are intentionally not accepted as command-line flags so they do not need
to be placed in shell history.
`;
}

function parseArgs(argv) {
  const result = { json: false };
  const valueFlags = new Map([
    ["--waba-id", "wabaId"],
    ["--app-id", "appId"],
    ["--client-url", "clientBaseUrl"],
    ["--runtime-env-file", "runtimeEnvFile"],
    ["--graph-version", "graphVersion"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--coexistence") {
      result.coexistence = true;
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

function selectManagementAccessToken({ operatorEnv = process.env, runtimeEnv = {} } = {}) {
  const managementToken = String(operatorEnv.WHATSAPP_MANAGEMENT_TOKEN || "").trim();
  if (managementToken) return managementToken;
  return String(runtimeEnv.WHATSAPP_TOKEN || "").trim();
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
    if (!args.clientBaseUrl) throw new Error("--client-url is required.");
    const runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    const result = await configureWhatsAppWebhook({
      wabaId: args.wabaId || runtimeEnv.WHATSAPP_WABA_ID,
      appId: args.appId || runtimeEnv.META_APP_ID || runtimeEnv.WHATSAPP_APP_ID || process.env.META_APP_ID,
      accessToken: selectManagementAccessToken({ runtimeEnv }),
      verifyToken: runtimeEnv.WHATSAPP_VERIFY_TOKEN,
      clientBaseUrl: args.clientBaseUrl,
      coexistence: Boolean(args.coexistence),
      graphVersion: args.graphVersion || process.env.META_GRAPH_API_VERSION,
    });

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log("WhatsApp WABA webhook configured and confirmed.");
      console.log(`WABA:     ${result.wabaId}`);
      if (result.appId) console.log(`Meta app: ${result.appId}`);
      console.log(`Callback: ${result.callbackUrl}`);
      if (result.coexistence) {
        console.log("Fields:   messages, smb_message_echoes, smb_app_state_sync, history");
      }
    }
  } catch (err) {
    console.error(`WhatsApp webhook configuration failed: ${err.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  loadRuntimeEnv,
  parseArgs,
  selectManagementAccessToken,
  usage,
};
