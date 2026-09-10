#!/usr/bin/env node
require("dotenv").config();

const crypto = require("crypto");
const { createOpsPool, buildOpsPoolConfig } = require("../src/ops/db");
const { createClientRegistryRepo } = require("../src/ops/clientRegistryRepo");
const { createClientPoller } = require("../src/ops/clientPoller");
const { resolveFleetTarget, TARGET_VALIDITY } = require("../src/ops/deploymentDrift");
const { listMigrationFiles } = require("../src/ops/migrationRunner");
const { assertOpsRegistryMode } = require("../src/ops/mode");
const { createRequireOpsAdmin } = require("../src/ops/requireOpsAdmin");
const { redactSensitiveText } = require("../src/provisioning/providerClients");

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

function sensitiveValues(env = process.env, clients = []) {
  const values = [
    env.OPS_DATABASE_URL,
    env.OPS_REGISTRY_ADMIN_PASSWORD,
    ...Object.entries(env)
      .filter(([key]) => /^OPS_CLIENT_TOKEN_/i.test(key))
      .map(([, value]) => value),
    ...clients.map((client) => env[client?.tokenEnvKey]),
  ];
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function redactOpsText(value, env = process.env, clients = []) {
  return redactSensitiveText(value, sensitiveValues(env, clients));
}

function validateFleetTargetConfiguration(env = process.env) {
  const configured = String(env.OPS_FLEET_TARGET_COMMIT || "").trim();
  if (!configured) return null;

  const target = resolveFleetTarget(env);
  if (target.validity !== TARGET_VALIDITY.VALID) {
    return {
      ok: false,
      label: target.error || "OPS_FLEET_TARGET_COMMIT is invalid.",
    };
  }

  return {
    ok: true,
    label: "Pinned fleet target is a valid full Git commit SHA",
  };
}

function validateConfiguration(env = process.env) {
  const checks = [];

  try {
    assertOpsRegistryMode(env);
    checks.push({ ok: true, label: "OPS_REGISTRY_MODE=true" });
  } catch (error) {
    checks.push({ ok: false, label: redactOpsText(error.message, env) });
  }

  try {
    buildOpsPoolConfig(env);
    checks.push({ ok: true, label: "OPS_DATABASE_URL configured" });
  } catch (error) {
    checks.push({ ok: false, label: redactOpsText(error.message, env) });
  }

  try {
    createRequireOpsAdmin({ env });
    checks.push({ ok: true, label: "Ops admin credentials configured" });
  } catch (error) {
    checks.push({ ok: false, label: redactOpsText(error.message, env) });
  }

  const targetCheck = validateFleetTargetConfiguration(env);
  if (targetCheck) checks.push(targetCheck);

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

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function inspectClientTokens(clients, env = process.env) {
  const checks = [];
  const seenKeys = new Map();
  const seenFingerprints = new Map();

  for (const client of clients) {
    const slug = client.clientSlug;
    const tokenEnvKey = String(client.tokenEnvKey || "").trim();
    const token = String(env[tokenEnvKey] || "").trim();

    const previousKeyOwner = seenKeys.get(tokenEnvKey);
    if (previousKeyOwner) {
      checks.push({
        clientSlug: slug,
        ok: false,
        label: `${slug}: token environment key ${tokenEnvKey} is also assigned to ${previousKeyOwner}`,
      });
    } else {
      seenKeys.set(tokenEnvKey, slug);
    }

    if (token.length < 32) {
      checks.push({
        clientSlug: slug,
        ok: false,
        label: `${slug}: ${tokenEnvKey} missing or shorter than 32 characters`,
      });
      continue;
    }

    const fingerprint = tokenFingerprint(token);
    const previousTokenOwner = seenFingerprints.get(fingerprint);
    if (previousTokenOwner) {
      checks.push({
        clientSlug: slug,
        ok: false,
        label: `${slug}: readiness credential duplicates ${previousTokenOwner}; every client must use a unique token`,
      });
      continue;
    }

    seenFingerprints.set(fingerprint, slug);
    checks.push({
      clientSlug: slug,
      ok: true,
      label: `${slug}: unique readiness token configured`,
    });
  }

  return checks;
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
        label: `${client.clientSlug}: ${redactOpsText(error.message, env, clients)}`,
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
    console.error(redactOpsText(error.message, env));
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
  let clients = [];
  try {
    try {
      await pool.query("SELECT 1");
      printChecks([{ ok: true, label: "PostgreSQL connection successful" }]);
    } catch (error) {
      printChecks([{
        ok: false,
        label: `PostgreSQL connection failed: ${redactOpsText(error.message, env)}`,
      }]);
      return 1;
    }

    const migrationState = await inspectMigrationState(pool);
    printChecks([{ ok: migrationState.ok, label: migrationState.message }]);
    if (!migrationState.ok) {
      for (const name of migrationState.pending) console.log(`  - ${name}`);
      return 1;
    }

    const repo = createClientRegistryRepo(pool);
    clients = await repo.listClients();
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
      console.error(`Ops Registry preflight failed: ${redactOpsText(error.message || error, process.env)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  inspectClientTokens,
  inspectMigrationState,
  main,
  parseArgs,
  probeClients,
  redactOpsText,
  sensitiveValues,
  tokenFingerprint,
  usage,
  validateConfiguration,
  validateFleetTargetConfiguration,
};
