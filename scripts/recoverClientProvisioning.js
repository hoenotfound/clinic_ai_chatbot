#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  buildProvisioningPlan,
  publicPlan,
  requireExecutionConfig,
} = require("../src/provisioning/clientProvisioner");
const {
  createNeonClient,
  createRenderClient,
  redactSensitiveText,
} = require("../src/provisioning/providerClients");
const {
  recoverInterruptedProvisioning,
  ClientRecoveryError,
} = require("../src/provisioning/clientRecovery");
const {
  normalizeRequiredChannels,
  validateRuntimeReadinessContract,
  verifyAdminLogin,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");
const {
  finalizeRenderRuntime,
} = require("../src/provisioning/renderFinalizer");
const {
  acquireProvisioningLock,
  captureInitialCommit,
  evaluateDeferredChannelReadiness,
  readinessFailureReport,
  requireReadinessAdminCredentials,
  runtimeEnvForReadinessPreflight,
  writeProvisioningReceipt,
} = require("./provisionClient");

const READINESS_NEEDS_ATTENTION_EXIT_CODE = 3;
const READINESS_VERIFICATION_FAILED_EXIT_CODE = 4;

function usage() {
  return `
Recover an interrupted automated client provisioning run by adopting the exact
existing Neon project and R2 bucket, safely recovering/rotating the deterministic
bucket-scoped R2 token, then creating or repairing the exact Render service.

Usage:
  npm run recover-client -- --client <slug> --industry <profile> --channels <csv> \\
    --runtime-env-file <path> [options] [--execute]

Required:
  --client <slug>
  --industry <profile>        aesthetic_clinic | tcm_clinic | home_renovation | generic
  --channels <csv>            whatsapp, facebook, instagram
  --runtime-env-file <path>   Same secret runtime input used for the interrupted run

Options:
  --execute                   Actually mutate Cloudflare/Render. Without this flag,
                              only the deterministic recovery plan is printed.
  --defer-channel-readiness   Recover a staged onboarding run while purchased
                              messaging credentials are still pending. Core
                              readiness remains mandatory.
  --r2-location <hint>        Default: apac
  --render-plan <plan>        Required for --execute unless set in the shell
  --render-region <region>    Default: singapore
  --neon-region <region-id>   Default: aws-ap-southeast-1
  --resource-prefix <prefix>  Default: da-chatbot
  --repo <url>                Render Git repository URL
  --branch <name>             Render Git branch, default: main
  --json                      Machine-readable output
  --help

Required control-plane shell values:
  PROVISIONING_RENDER_API_KEY
  PROVISIONING_RENDER_OWNER_ID
  PROVISIONING_NEON_API_KEY
  PROVISIONING_CLOUDFLARE_ACCOUNT_ID
  PROVISIONING_CLOUDFLARE_API_TOKEN

Recovery is deliberately non-destructive. It never deletes Neon, R2, or Render
resources. If a same-name R2 token exists, its policy must match the exact expected
bucket before its one-time value is rolled. Raw token values, derived R2 secrets,
DATABASE_URL, and runtime secrets are never written to the receipt or output.
`;
}

function parseArgs(argv) {
  const result = { execute: false, json: false, deferChannelReadiness: false };
  const valueFlags = new Map([
    ["--client", "clientSlug"],
    ["--industry", "industry"],
    ["--channels", "channels"],
    ["--runtime-env-file", "runtimeEnvFile"],
    ["--r2-location", "r2Location"],
    ["--render-plan", "renderPlan"],
    ["--render-region", "renderRegion"],
    ["--neon-region", "neonRegion"],
    ["--resource-prefix", "resourcePrefix"],
    ["--repo", "renderRepo"],
    ["--branch", "renderBranch"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      result.execute = true;
      continue;
    }
    if (arg === "--defer-channel-readiness") {
      result.deferChannelReadiness = true;
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
  if (!filePath) throw new Error("--runtime-env-file is required for recovery.");
  return dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), filePath)));
}

function printHuman(result) {
  if (result.mode === "plan") {
    const plan = result.plan;
    console.log("Interrupted provisioning recovery plan (dry run; no provider calls)\n");
    console.log(`Client:         ${plan.clientSlug}`);
    console.log(`Industry:       ${plan.industry}`);
    if (result.channelReadinessDeferred) {
      console.log("Recovery mode:   staged (channel readiness deferred)");
    }
    console.log(`Neon project:   ${plan.neon.projectName}`);
    console.log(`R2 bucket:      ${plan.r2.bucketName}`);
    console.log(`R2 token:       ${plan.r2.tokenName}`);
    console.log(`Render service: ${plan.render.serviceName}`);
    console.log("\nWith --execute, recovery adopts these exact resources only. It will not delete or rename provider resources.");
    return;
  }

  console.log("Interrupted provisioning recovery completed.\n");
  console.log(`Client:         ${result.clientSlug}`);
  if (result.channelReadinessDeferred) {
    console.log("Recovery mode:   staged (channel readiness deferred)");
  }
  console.log(`Neon project:   ${result.neon.projectName} (${result.neon.projectId})`);
  console.log(`R2 bucket:      ${result.r2.bucketName}`);
  console.log(`R2 token:       ${result.r2.tokenName} (${result.r2.tokenId})`);
  console.log(`Render service: ${result.render.serviceName} (${result.render.serviceId})`);
  if (result.render.url) console.log(`Render URL:     ${result.render.url}`);
  console.log(`Recovery deploy:${result.render.deployId} (${result.render.deployStatus})`);
  console.log(`Reused Render:  ${result.recovery?.reusedRender ? "yes" : "no; created during recovery"}`);
  console.log(`R2 token action:${result.recovery?.recoveredR2Token ? "verified + rotated" : "created after confirming no same-name token"}`);
  if (result.runtimeFinalization?.deployId) {
    console.log(`Final deploy:   ${result.runtimeFinalization.deployId} (${result.runtimeFinalization.deployStatus})`);
  }
  if (result.readiness) {
    console.log(`Readiness:      ${result.readiness.ready ? "READY" : String(result.readiness.status || "needs_attention").toUpperCase()}`);
  }
  if (result.channelReadinessDeferred && result.stagedReadiness) {
    console.log(`Staged status:  ${result.stagedReadiness.acceptable
      ? "INFRASTRUCTURE READY; CHANNELS PENDING"
      : "NEEDS ATTENTION"}`);
  }
  if (result.receiptPath) console.log(`Receipt:        ${result.receiptPath}`);
  console.log("\nIf Ops Registry enrollment is enabled for production, run:");
  console.log(`npm run ops:enroll-client -- --receipt ${result.receiptPath || `.provisioning/${result.clientSlug}.json`}`);
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

  let runtimeEnv;
  try {
    runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
  } catch (err) {
    console.error(`Could not read runtime env: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const input = {
    clientSlug: args.clientSlug,
    industry: args.industry,
    requiredChannels: args.channels,
    runtimeEnv,
    r2ProvisioningMode: "required",
    r2LocationHint: args.r2Location,
    renderPlan: args.renderPlan,
    renderRegion: args.renderRegion,
    neonRegion: args.neonRegion,
    resourcePrefix: args.resourcePrefix,
    renderRepo: args.renderRepo,
    renderBranch: args.renderBranch,
  };
  const sensitiveValues = [
    process.env.PROVISIONING_RENDER_API_KEY,
    process.env.PROVISIONING_NEON_API_KEY,
    process.env.PROVISIONING_CLOUDFLARE_API_TOKEN,
    ...Object.values(runtimeEnv || {}),
  ].filter(Boolean);

  let lock = null;
  try {
    const channels = normalizeRequiredChannels(args.channels);
    const plan = buildProvisioningPlan(input, process.env);
    if (!args.execute) {
      const result = {
        mode: "plan",
        channelReadinessDeferred: args.deferChannelReadiness === true,
        plan: publicPlan(plan),
      };
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else printHuman(result);
      return;
    }

    requireExecutionConfig(plan, process.env);
    validateRuntimeReadinessContract(
      runtimeEnvForReadinessPreflight(runtimeEnv, plan),
      channels,
      { deferChannelReadiness: args.deferChannelReadiness }
    );
    const admin = requireReadinessAdminCredentials(runtimeEnv);
    lock = acquireProvisioningLock(plan.resourceName);

    const renderClient = createRenderClient({
      apiKey: process.env.PROVISIONING_RENDER_API_KEY,
      ownerId: plan.render.ownerId,
    });
    const neonClient = createNeonClient({
      apiKey: process.env.PROVISIONING_NEON_API_KEY,
      orgId: plan.neon.orgId,
    });

    let result = await recoverInterruptedProvisioning(input, {
      env: process.env,
      renderClient,
      neonClient,
    });
    result = {
      ...result,
      requiredChannels: channels,
      channelReadinessDeferred: args.deferChannelReadiness === true,
      render: {
        ...result.render,
        deployedCommitSha: await captureInitialCommit(renderClient, result),
      },
    };

    let readiness;
    let runtimeFinalization = null;
    try {
      await verifyAdminLogin({
        baseUrl: result.render.url,
        username: admin.username,
        password: admin.password,
      });
      const finalized = await finalizeRenderRuntime({
        apiKey: process.env.PROVISIONING_RENDER_API_KEY,
        serviceId: result.render.serviceId,
        publicBaseUrl: result.render.url,
        renderClient,
      });
      runtimeFinalization = { ...finalized, completed: true, failureCode: null };
      if (runtimeFinalization.deployedCommitSha) {
        result.render.deployedCommitSha = runtimeFinalization.deployedCommitSha;
      }
      readiness = await verifyClientReadiness({
        baseUrl: result.render.url,
        username: admin.username,
        password: admin.password,
        expectedIndustry: result.industry,
        requiredChannels: channels,
      });
    } catch (err) {
      if (err?.partialFinalization) {
        runtimeFinalization = {
          ...err.partialFinalization,
          completed: false,
          failureCode: err.code || "RENDER_RUNTIME_FINALIZATION_FAILED",
        };
      }
      readiness = readinessFailureReport(err, { industry: result.industry, channels });
    }

    const stagedReadiness = args.deferChannelReadiness
      ? evaluateDeferredChannelReadiness(readiness, channels)
      : null;

    result = {
      ...result,
      runtimeFinalization,
      opsEnrollment: null,
      readiness,
      stagedReadiness,
    };
    const receipt = writeProvisioningReceipt(result);
    result.receiptPath = path.relative(process.cwd(), receipt.receiptPath) || receipt.receiptPath;

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);

    if (readiness?.status === "verification_failed") {
      process.exitCode = READINESS_VERIFICATION_FAILED_EXIT_CODE;
    } else if (
      result.channelReadinessDeferred
      && result.stagedReadiness?.acceptable === true
    ) {
      // Recovery restored a staged client whose only remaining blockers are
      // intentionally deferred messaging-channel readiness checks.
    } else if (readiness?.ready !== true) {
      process.exitCode = READINESS_NEEDS_ATTENTION_EXIT_CODE;
    }
  } catch (err) {
    const message = redactSensitiveText(err?.message || "Recovery failed", sensitiveValues);
    const output = {
      error: message,
      code: err?.code || "RECOVERY_COMMAND_FAILED",
      stage: err?.stage || null,
      retrySafe: err?.retrySafe ?? null,
    };
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else console.error(`Recovery stopped: ${message}`);
    process.exitCode = err instanceof ClientRecoveryError ? 2 : 1;
  } finally {
    if (lock) {
      try { lock.release(); } catch (err) {
        console.error(`Warning: could not release local provisioning lock: ${err.message}`);
      }
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
  loadRuntimeEnv,
  main,
  parseArgs,
  printHuman,
  usage,
};
