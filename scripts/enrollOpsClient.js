#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  createRenderClient,
  redactSensitiveText,
} = require("../src/provisioning/providerClients");
const {
  OpsRegistryEnrollmentError,
  deployPreparedClientToken,
  deployPreparedRegistryToken,
  opsEnrollmentFailureState,
  prepareOpsRegistryEnrollment,
  requireOpsEnrollmentConfig,
  verifyAndRegisterPreparedEnrollment,
} = require("../src/provisioning/opsRegistryEnrollment");
const { acquireProvisioningLock } = require("./provisionClient");

function usage() {
  return `
Resume or repair Ops Registry enrollment for an already provisioned client.

Usage:
  npm run ops:enroll-client -- --receipt <path> [--json]

Required shell configuration:
  PROVISIONING_RENDER_API_KEY
  PROVISIONING_RENDER_OWNER_ID
  PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID
  OPS_DATABASE_URL

This command is safely repeatable at the registry-record level. Every completed
run generates a fresh high-entropy token, configures both Render services,
redeploys them, verifies the exact client identity/profile/channel contract, and
upserts the registry record. A same-machine provisioning lock prevents two local
operators from rotating the same client's token concurrently. The token value is
never written to the receipt or printed.
`;
}

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--receipt") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--receipt requires a value.");
      args.receiptPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadReceipt(receiptPath) {
  if (!receiptPath) throw new Error("--receipt is required.");
  const absolute = path.resolve(process.cwd(), receiptPath);
  const receipt = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (Number(receipt?.version) !== 3) {
    throw new Error("Only provisioning receipt version 3 is supported.");
  }
  if (!receipt?.clientSlug || !receipt?.render?.serviceId || !receipt?.render?.url) {
    throw new Error("Receipt is missing the client slug, Render service ID, or Render URL.");
  }
  return { absolute, receipt };
}

function provisioningResultFromReceipt(receipt) {
  return {
    mode: "executed",
    clientSlug: receipt.clientSlug,
    industry: receipt.industry || null,
    requiredChannels: Array.isArray(receipt.requiredChannels)
      ? [...receipt.requiredChannels]
      : [],
    neon: { ...(receipt.neon || {}) },
    render: { ...(receipt.render || {}) },
    profileContract: { ...(receipt.profileContract || {}) },
  };
}

function recoveryLockName(receipt) {
  const value = String(receipt?.render?.serviceName || receipt?.clientSlug || "").trim();
  if (!value) throw new Error("Receipt is missing a stable client name for the provisioning lock.");
  return value;
}

function writeEnrollmentToReceipt(absolutePath, receipt, opsEnrollment, {
  deployedCommitSha = null,
} = {}) {
  const next = JSON.parse(JSON.stringify(receipt));
  next.opsEnrollment = JSON.parse(JSON.stringify(opsEnrollment));
  if (deployedCommitSha && next.render) {
    next.render.deployedCommitSha = deployedCommitSha;
  }
  const tempPath = `${absolutePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, absolutePath);
  return next;
}

function printHuman(result, receiptPath) {
  const state = result.opsEnrollment;
  console.log(`Ops Registry enrollment for ${result.clientSlug}`);
  console.log(`Status:          ${state.verified ? "VERIFIED" : state.status.toUpperCase()}`);
  console.log(`Token env:       ${state.tokenEnvKey}`);
  console.log(`Client deploy:   ${state.clientDeployId || "n/a"} (${state.clientDeployStatus || "n/a"})`);
  console.log(`Registry deploy: ${state.registryDeployId || "n/a"} (${state.registryDeployStatus || "n/a"})`);
  console.log(`Endpoint proof:  ${state.endpointVerified ? "verified" : "not verified"}`);
  console.log(`Registry record: ${state.registryRecordUpserted ? "upserted" : "not upserted"}`);
  if (state.readinessStatus) console.log(`Readiness:       ${state.readinessStatus}`);
  console.log(`Receipt:         ${receiptPath}`);
  console.log("Token value was rotated securely and was not written to the receipt or output.");
}

async function runEnrollmentFromReceipt({
  receipt,
  env = process.env,
  fetchImpl = global.fetch,
  createRenderClientImpl = createRenderClient,
} = {}) {
  const result = provisioningResultFromReceipt(receipt);
  requireOpsEnrollmentConfig({
    clientSlug: result.clientSlug,
    mode: "required",
    env,
  });
  if (!String(env.PROVISIONING_RENDER_API_KEY || "").trim()) {
    throw new OpsRegistryEnrollmentError(
      "Ops Registry enrollment requires PROVISIONING_RENDER_API_KEY.",
      {
        code: "OPS_ENROLLMENT_RENDER_API_KEY_REQUIRED",
        stage: "validation",
        retrySafe: true,
      }
    );
  }
  if (!String(env.PROVISIONING_RENDER_OWNER_ID || "").trim()) {
    throw new OpsRegistryEnrollmentError(
      "Ops Registry enrollment requires PROVISIONING_RENDER_OWNER_ID.",
      {
        code: "OPS_ENROLLMENT_RENDER_OWNER_REQUIRED",
        stage: "validation",
        retrySafe: true,
      }
    );
  }

  const renderClient = createRenderClientImpl({
    apiKey: env.PROVISIONING_RENDER_API_KEY,
    ownerId: env.PROVISIONING_RENDER_OWNER_ID,
    fetchImpl,
  });

  let prepared = await prepareOpsRegistryEnrollment({
    result,
    mode: "required",
    env,
    renderClient,
    fetchImpl,
  });
  prepared = await deployPreparedClientToken({
    prepared,
    result,
    env,
    renderClient,
    fetchImpl,
  });
  prepared = await deployPreparedRegistryToken({
    prepared,
    result,
    env,
    renderClient,
    fetchImpl,
  });
  const opsEnrollment = await verifyAndRegisterPreparedEnrollment({
    prepared,
    result,
    env,
    fetchImpl,
  });
  return { ...result, opsEnrollment };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let loaded;
  try {
    loaded = loadReceipt(args.receiptPath);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  // Use the same service/resource name as normal provisioning so recovery and
  // first-time provisioning cannot mutate the same client concurrently on one
  // operator machine. Do not touch the receipt when lock acquisition fails,
  // because another active process may be about to write a newer state.
  let lock;
  try {
    lock = acquireProvisioningLock(recoveryLockName(loaded.receipt));
  } catch (err) {
    console.error(`Ops Registry enrollment stopped: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const sensitiveValues = [
    process.env.PROVISIONING_RENDER_API_KEY,
    process.env.OPS_DATABASE_URL,
  ].filter(Boolean);

  try {
    const result = await runEnrollmentFromReceipt({
      receipt: loaded.receipt,
      env: process.env,
    });
    const saved = writeEnrollmentToReceipt(
      loaded.absolute,
      loaded.receipt,
      result.opsEnrollment,
      { deployedCommitSha: result.opsEnrollment.remoteCommitSha }
    );
    if (args.json) {
      console.log(JSON.stringify({
        clientSlug: result.clientSlug,
        opsEnrollment: result.opsEnrollment,
        receiptPath: path.relative(process.cwd(), loaded.absolute) || loaded.absolute,
      }, null, 2));
    } else {
      printHuman(result, path.relative(process.cwd(), loaded.absolute) || loaded.absolute);
    }
    return saved;
  } catch (err) {
    const failure = opsEnrollmentFailureState(err, err?.publicState);
    try {
      writeEnrollmentToReceipt(loaded.absolute, loaded.receipt, failure);
    } catch (_) {
      // The original failure is more actionable than a secondary receipt write.
    }
    const message = redactSensitiveText(err?.message || "Ops enrollment failed.", sensitiveValues);
    if (args.json) {
      console.error(JSON.stringify({
        error: message,
        code: err?.code || "OPS_ENROLLMENT_FAILED",
        stage: err?.stage || null,
        opsEnrollment: failure,
      }, null, 2));
    } else {
      console.error(`Ops Registry enrollment stopped: ${message}`);
      console.error(`Recovery state: ${failure.status} (${failure.failureCode || "unknown"})`);
      console.error("Re-run the same command after resolving the reported issue. A fresh token will be rotated safely.");
    }
    process.exitCode = 2;
    return null;
  } finally {
    try {
      lock.release();
    } catch (err) {
      console.error(`Warning: could not release local provisioning lock: ${err.message}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

module.exports = {
  loadReceipt,
  parseArgs,
  provisioningResultFromReceipt,
  recoveryLockName,
  runEnrollmentFromReceipt,
  usage,
  writeEnrollmentToReceipt,
};
