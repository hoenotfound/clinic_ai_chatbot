#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createOpsPool, ensureOpsSchema } = require("../src/ops/db");
const { createClientRegistryRepo } = require("../src/ops/clientRegistryRepo");
const { normalizedBaseUrl } = require("../src/ops/clientPoller");

function usage() {
  return `
Register or update one client in the DA Multi-Client Ops Registry.

Usage:
  npm run ops:register-client -- --receipt <path> [options]

Required:
  --receipt <path>          Provisioning v3 receipt for the client.

Options:
  --name <display name>     Defaults to the receipt client slug.
  --base-url <url>          Overrides the Render URL stored in the receipt.
  --token-env <ENV_KEY>     Central registry env var containing this client's
                            OPS_READINESS_TOKEN. Defaults to a deterministic
                            OPS_CLIENT_TOKEN_<SLUG> name.
  --help

Secrets:
  This command never reads or stores the client's token value. The registry DB
  stores only the token environment-variable name. Put the actual token in the
  central registry service's secret environment and the same value in the
  client's OPS_READINESS_TOKEN.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--receipt") args.receiptPath = next;
    else if (arg === "--name") args.displayName = next;
    else if (arg === "--base-url") args.baseUrl = next;
    else if (arg === "--token-env") args.tokenEnvKey = next;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return args;
}

function defaultTokenEnvKey(slug) {
  return `OPS_CLIENT_TOKEN_${String(slug || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function validateTokenEnvKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid token env key: ${value}`);
  return key;
}

function registryRecordFromReceipt(receipt, args = {}) {
  if (Number(receipt?.version) !== 3) throw new Error("Only provisioning receipt version 3 is supported.");
  const clientSlug = String(receipt?.clientSlug || "").trim();
  if (!clientSlug) throw new Error("Receipt is missing clientSlug.");
  const baseUrl = normalizedBaseUrl(args.baseUrl || receipt?.render?.url);
  const tokenEnvKey = validateTokenEnvKey(args.tokenEnvKey || defaultTokenEnvKey(clientSlug));

  return {
    clientSlug,
    displayName: String(args.displayName || receipt?.readiness?.businessName || clientSlug).trim(),
    baseUrl,
    industry: receipt?.industry || null,
    purchasedChannels: Array.isArray(receipt?.requiredChannels) ? receipt.requiredChannels : [],
    tokenEnvKey,
    render: {
      serviceId: receipt?.render?.serviceId || null,
      serviceName: receipt?.render?.serviceName || null,
    },
    neon: {
      projectId: receipt?.neon?.projectId || null,
      projectName: receipt?.neon?.projectName || null,
    },
    provisionedCommitSha: receipt?.render?.deployedCommitSha || null,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (!args.receiptPath) throw new Error("--receipt is required.");
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const receipt = JSON.parse(fs.readFileSync(path.resolve(args.receiptPath), "utf8"));
  const record = registryRecordFromReceipt(receipt, args);
  const pool = createOpsPool(process.env);
  try {
    await ensureOpsSchema(pool);
    const repo = createClientRegistryRepo(pool);
    const saved = await repo.upsertClient(record);
    console.log(`Registered ${saved.displayName} (${saved.clientSlug})`);
    console.log(`Base URL: ${saved.baseUrl}`);
    console.log(`Token env: ${saved.tokenEnvKey}`);
    console.log("No token value was written to the registry database.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  defaultTokenEnvKey,
  parseArgs,
  registryRecordFromReceipt,
  validateTokenEnvKey,
};
