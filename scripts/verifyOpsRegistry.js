#!/usr/bin/env node
require("dotenv").config();

const { createOpsPool, buildOpsPoolConfig } = require("../src/ops/db");
const { createClientRegistryRepo } = require("../src/ops/clientRegistryRepo");
const { createClientPoller } = require("../src/ops/clientPoller");
const { listMigrationFiles } = require("../src/ops/migrationRunner");
const { assertOpsRegistryMode } = require("../src/ops/mode");
const { createRequireOpsAdmin } = require("../src/ops/requireOpsAdmin");

function parseArgs(argv = []) {
  const args = { probeClients: false };
  for (const arg of argv) {
    if (arg === "--probe-clients") args.probeClients = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `
Validate a DA Chatbot Ops Registry deployment without printing secrets.

Usage:
  npm run ops-registry:verify
  npm run ops-registry:verify -- --probe-clients

Options:
  --probe-clients   Also perform one read-only readiness request to each
                    registered client. This does not update registry snapshots.
  --help
`;
}

function validateConfiguration(env = process.env) {
  const checks = [];

  try {
    assertOpsRegistryMode(env);
    checks.push({ ok: true, label: "OPS_REGISTRY_MODE=true" });
  } catch (error) {
    checks.push({ ok: false, label: error.message });
  }

  try {
    buildOpsPoolConfig(env);
    checks.push({ ok: true, label: "OPS_DATABASE_URL configured" });
  } catch (error) {
    checks.push({ ok: false, label: error.message });
  }

  try {
    createRequireOpsAdmin({ env });
    checks.push({ ok: true, label: "Ops admin credentials configured" });
  } catch (error) {
    checks.push({ ok: false, label: error.message });
  }

  return checks;
}

async function inspectMigrationState(pool) {
  const tables = await pool.query(`
    SELECT
      to_regclass('public.ops_schema_migrations') AS migrations_table,
      to_regclass('public.ops_clients') AS clients_table
  `);
  const row = tables.rows?.[0] || {};
  if (!row.migrations_table || !row.clients_table) {
    return {
      ok: false,
      pending: listMigrationFiles(),
      message: "Ops Registry schema is missing. Run npm run ops-registry:migrate first.",
    };
  }

  const appliedResult = await pool.query("SELECT name FROM ops_schema_migrations ORDER BY name");
  const applied = new Set((appliedResult.rows || []).map((item) => item.name));
  const pending = listMigrationFiles().filter((name) => !applied.has(name));
  return pending.length
    ? {
        ok: false,
        pending,
        message: `Ops Registry has ${pending.length} pending migration(s).`,
      }
    : {
        ok: true,
        pending: [],
        message: `Ops Registry migrations current (${applied.size} applied).`,
      };
}

function inspectClientTokens(clients, env = process.env) {
  return clients.map((client) => {
    const token = String(env[client.tokenEnvKey] || "").trim();
    return {
      clientSlug: client.clientSlug,
      ok: token.length >= 32,
      label: token.length >= 32
        ? `${client.clientSlug}: readiness token configured`
        : `${client.clientSlug}: ${client.tokenEnvKey} missing or shorter than 32 characters`,
    };
  });
}

async function probeClients(clients, env = process.env, { poller = createClientPoller({ env }) } = {}) {
  const results = [];
  for (const client of clients) {
    try {
      const result = await poller.pollClient(client);
      results.push({
        clientSlug: client.clientSlug,
        ok: true,
        label: `${client.clientSlug}: reachable (HTTP ${result.httpStatus}, ${result.snapshot.readiness.status})`,
      });
    } catch (error) {
      results.push({
        clientSlug: client.clientSlug,
        ok: false,
        label: `${client.clientSlug}: ${error.message}`,
      });
    }
  }
  return results;
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label}`);
  }
}

async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  if (args.help) {
    console.log(usage());
    return 0;
  }

  console.log("DA Chatbot Ops Registry Preflight\n");
  const configChecks = validateConfiguration(env);
  printChecks(configChecks);
  if (configChecks.some((check) => !check.ok)) return 1;

  const pool = createOpsPool(env);
  try {
    try {
      await pool.query("SELECT 1");
      printChecks([{ ok: true, label: "PostgreSQL connection successful" }]);
    } catch (error) {
      printChecks([{ ok: false, label: `PostgreSQL connection failed: ${error.message}` }]);
      return 1;
    }

    const migrationState = await inspectMigrationState(pool);
    printChecks([{ ok: migrationState.ok, label: migrationState.message }]);
    if (!migrationState.ok) {
      for (const name of migrationState.pending) console.log(`  - ${name}`);
      return 1;
    }

    const repo = createClientRegistryRepo(pool);
    const clients = await repo.listClients();
    console.log(`\nRegistered clients: ${clients.length}`);

    const tokenChecks = inspectClientTokens(clients, env);
    printChecks(tokenChecks);
    if (tokenChecks.some((check) => !check.ok)) return 1;

    if (args.probeClients && clients.length) {
      console.log("\nRead-only client probes:");
      const probeResults = await probeClients(clients, env);
      printChecks(probeResults);
      if (probeResults.some((check) => !check.ok)) return 1;
    }

    console.log("\nOps Registry preflight passed.");
    return 0;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Ops Registry preflight failed: ${error.message || error}`);
      process.exitCode = 1;
    });
}

module.exports = {
  inspectClientTokens,
  inspectMigrationState,
  main,
  parseArgs,
  probeClients,
  usage,
  validateConfiguration,
};
