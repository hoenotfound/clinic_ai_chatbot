#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createOpsPool } = require("../src/ops/db");
const { runOpsMigrations } = require("../src/ops/migrationRunner");
const { createMetaWebhookRouteRepo } = require("../src/metaRouter/routeRepo");

function usage() {
  return `
Register Messenger/Instagram webhook routing for one client.

Usage:
  npm run meta-router:register-client -- --client <slug> --url <https://client...> [options]

Options:
  --facebook-page-id <id>       Facebook Page ID used in Messenger webhook entry.id
  --instagram-account-id <id>   Instagram Professional Account ID used in webhook entry.id
  --runtime-env-file <path>     Read FACEBOOK_PAGE_ID and/or INSTAGRAM_ACCOUNT_ID from dotenv
  --disable                     Register supplied routes as disabled
  --json                        Print machine-readable output
  --help                        Show this help

The command stores only asset IDs, client slug, target URL, and enabled state in
OPS_DATABASE_URL. Page access tokens and Meta app secrets are never stored in the
routing table.
`;
}

function parseArgs(argv) {
  const result = { enabled: true, json: false };
  const valueFlags = new Map([
    ["--client", "clientSlug"],
    ["--url", "targetBaseUrl"],
    ["--facebook-page-id", "facebookPageId"],
    ["--instagram-account-id", "instagramAccountId"],
    ["--runtime-env-file", "runtimeEnvFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--disable") {
      result.enabled = false;
      continue;
    }
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
  if (!filePath) return {};
  const absolute = path.resolve(process.cwd(), filePath);
  return dotenv.parse(fs.readFileSync(absolute));
}

async function registerRoutes({
  clientSlug,
  targetBaseUrl,
  facebookPageId,
  instagramAccountId,
  enabled = true,
  env = process.env,
} = {}) {
  if (!clientSlug) throw new Error("--client is required.");
  if (!targetBaseUrl) throw new Error("--url is required.");
  const routes = [];
  if (String(facebookPageId || "").trim()) {
    routes.push({ channel: "facebook", assetId: String(facebookPageId).trim() });
  }
  if (String(instagramAccountId || "").trim()) {
    routes.push({ channel: "instagram", assetId: String(instagramAccountId).trim() });
  }
  if (!routes.length) {
    throw new Error("Provide --facebook-page-id, --instagram-account-id, or a runtime env file containing those values.");
  }

  const pool = createOpsPool(env);
  try {
    await runOpsMigrations(pool);
    const repo = createMetaWebhookRouteRepo(pool);
    const registered = [];
    for (const route of routes) {
      registered.push(await repo.upsertRoute({
        clientSlug,
        channel: route.channel,
        assetId: route.assetId,
        targetBaseUrl,
        enabled,
      }));
    }
    return registered;
  } finally {
    await pool.end();
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

  try {
    const runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
    const registered = await registerRoutes({
      clientSlug: args.clientSlug,
      targetBaseUrl: args.targetBaseUrl,
      facebookPageId: args.facebookPageId || runtimeEnv.FACEBOOK_PAGE_ID,
      instagramAccountId: args.instagramAccountId || runtimeEnv.INSTAGRAM_ACCOUNT_ID,
      enabled: args.enabled,
      env: process.env,
    });
    if (args.json) {
      console.log(JSON.stringify({ registered }, null, 2));
    } else {
      console.log("Registered Meta webhook route(s):");
      for (const route of registered) {
        console.log(`- ${route.channel}:${route.assetId} -> ${route.targetBaseUrl}/meta-webhook (${route.enabled ? "enabled" : "disabled"})`);
      }
    }
  } catch (err) {
    console.error(`Meta webhook route registration failed: ${err.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  loadRuntimeEnv,
  parseArgs,
  registerRoutes,
  usage,
};
