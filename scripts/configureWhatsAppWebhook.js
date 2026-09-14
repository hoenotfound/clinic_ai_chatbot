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
  --client-url <url>          Client Render/public base URL
  --runtime-env-file <path>   dotenv containing WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN,
                              and normally WHATSAPP_WABA_ID
  --graph-version <version>   Meta Graph API version, default v26.0
  --json                      Print machine-readable output
  --help                      Show this help

Access tokens and verify tokens are intentionally read from the runtime env file,
not accepted as command-line flags, so they do not need to be placed in shell
history.
`;
}

function parseArgs(argv) {
  const result = { json: false };
  const valueFlags = new Map([
    ["--waba-id", "wabaId"],
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
    if (!args.clientBaseUrl) throw new Error("--client-url is required.");
    const runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    const result = await configureWhatsAppWebhook({
      wabaId: args.wabaId || runtimeEnv.WHATSAPP_WABA_ID,
      accessToken: runtimeEnv.WHATSAPP_TOKEN,
      verifyToken: runtimeEnv.WHATSAPP_VERIFY_TOKEN,
      clientBaseUrl: args.clientBaseUrl,
      graphVersion: args.graphVersion || process.env.META_GRAPH_API_VERSION,
    });

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log("WhatsApp WABA webhook configured and confirmed.");
      console.log(`WABA:     ${result.wabaId}`);
      console.log(`Callback: ${result.callbackUrl}`);
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
  usage,
};
