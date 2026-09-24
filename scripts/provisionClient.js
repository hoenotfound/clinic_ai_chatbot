#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  ClientProvisioningError,
  buildProvisioningPlan,
  provisionClient,
  publicPlan,
  requireExecutionConfig,
} = require("../src/provisioning/clientProvisioner");
const {
  createNeonClient,
  createRenderClient,
  redactSensitiveText,
} = require("../src/provisioning/providerClients");
const {
  R2ProvisioningError,
} = require("../src/provisioning/r2Provisioning");
const {
  CURRENT_PROVISIONING_RECEIPT_VERSION,
  secretFreeR2ReceiptState,
} = require("../src/provisioning/provisioningReceipt");
const {
  CHANNEL_CHECK_KEYS,
  ClientReadinessError,
  normalizeRequiredChannels,
  validateRuntimeReadinessContract,
  verificationFailureReport,
  verifyAdminLogin,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");
const {
  extractRenderCommitSha,
  finalizeRenderRuntime,
} = require("../src/provisioning/renderFinalizer");
const {
  OpsRegistryEnrollmentError,
  buildOpsEnrollmentPlan,
  deployPreparedRegistryToken,
  markPreparedClientDeployment,
  opsEnrollmentFailureState,
  prepareOpsRegistryEnrollment,
  publicStateFromPlan,
  requireOpsEnrollmentConfig,
  verifyAndRegisterPreparedEnrollment,
} = require("../src/provisioning/opsRegistryEnrollment");

const PROVISIONING_STATE_DIR = ".provisioning";
const READINESS_NEEDS_ATTENTION_EXIT_CODE = 3;
const READINESS_VERIFICATION_FAILED_EXIT_CODE = 4;
const OPS_ENROLLMENT_FAILED_EXIT_CODE = 5;

function usage() {
  return `
Provision one client Render service + Neon database, optionally provision a
private per-client Cloudflare R2 bucket, automatically enroll it in the central
Ops Registry when configured, and verify the purchased channels.

Usage:
  npm run provision-client -- --client <slug> --industry <profile> --channels <csv> [options]

Required:
  --client <slug>             Stable client slug, e.g. acme-renovation
  --industry <profile>        aesthetic_clinic | tcm_clinic | home_renovation | generic
  --channels <csv>            Required channels: whatsapp, facebook, instagram
                              Example: whatsapp,instagram

Safe by default:
  Without --execute, this command only prints the provisioning/readiness plan
  and performs no network calls or cloud mutations.

Options:
  --execute                   Create infrastructure, wait for first deploy,
                              finalize the runtime, enroll Ops when enabled,
                              then verify production health
  --defer-channel-readiness   Staged onboarding only. Allow purchased channel
                              credentials to remain unset during infrastructure
                              creation. Core runtime/readiness checks still run,
                              and the client is not considered go-live ready.
  --runtime-env-file <path>   dotenv file containing client runtime variables.
                              With automated R2 enabled, do not include R2_*;
                              those values are generated and injected directly.
  --r2-provisioning <mode>    auto | required | off. Default: auto, or
                              PROVISIONING_R2_MODE when set. auto provisions R2
                              when both Cloudflare control values are configured.
  --r2-location <hint>        apac | eeur | enam | weur | wnam | oc.
                              Default: apac.
  --ops-enrollment <mode>     auto | required | off. Default: auto, or
                              PROVISIONING_OPS_ENROLLMENT_MODE when set.
                              auto enrolls when the full Ops control plane is
                              configured; required fails preflight if it is not.
  --render-plan <plan>        Render instance plan. Required for --execute
                              unless PROVISIONING_RENDER_PLAN is set.
  --render-region <region>    Default: singapore
  --neon-region <region-id>   Default: aws-ap-southeast-1
  --resource-prefix <prefix>  Default: da-chatbot
  --repo <url>                Render Git repository URL
  --branch <name>             Render Git branch, default: main
  --json                      Machine-readable output
  --help                      Show this help

Automated R2 provisioning:
  When enabled, provisioning creates a private Standard R2 bucket and an
  account-owned API token scoped only to that bucket. The derived S3 credentials
  are passed directly into the new Render service. The one-time token value and
  derived R2 secret are never printed or written to the provisioning receipt.

  Required Cloudflare control-plane shell values:
    PROVISIONING_CLOUDFLARE_ACCOUNT_ID
    PROVISIONING_CLOUDFLARE_API_TOKEN

  The control token must be able to manage R2 buckets and account-owned API
  tokens. Keep it only in the operator shell/control plane, never client config.

Go-live rules:
  Normal --execute remains strict: purchased-channel runtime credentials must be
  present before any cloud resources are created. --defer-channel-readiness is
  an explicit staged-onboarding exception for confirmed clients whose messaging
  assets are still pending. It never marks missing channels as ready.

  Required Setup Status checks must be configured and ready. Database migrations
  and inbound processing must be healthy. AI runtime errors block go-live while
  degraded-but-usable AI is reported as READY WITH WARNINGS. Every purchased
  channel must have real inbound activity, a provider-accepted AI reply to that
  conversation, and no newer failed AI reply attempt.

Runtime finalization:
  After the bootstrap admin login succeeds, the provisioner sets PUBLIC_BASE_URL
  to the actual Render URL, removes ADMIN_PASSWORD from Render, deploys those
  changes, and verifies the finalized deployment.

Automated Ops enrollment:
  When enabled, provisioning generates a fresh high-entropy readiness token,
  writes it directly to the client Render service as OPS_READINESS_TOKEN and to
  the central registry Render service as OPS_CLIENT_TOKEN_<CLIENT_SLUG>, deploys
  the registry, proves the exact client identity through /api/ops/readiness, and
  upserts the secret-free registry record. The token value is never printed,
  written to the receipt, committed, or stored in the Ops database.

  Required Ops control-plane shell values:
    PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID
    OPS_DATABASE_URL

  For production operators, PROVISIONING_OPS_ENROLLMENT_MODE=required is
  recommended so an untracked client cannot be created accidentally.

Exit codes:
  0  Provisioned and READY / READY WITH WARNINGS (or dry-run plan)
  2  Provisioning/input failure before a usable deployment exists
  3  Infrastructure is live and verification completed, but NEEDS ATTENTION
  4  Infrastructure is live, but readiness verification could not complete
  5  Client provisioning completed, but enabled Ops Registry enrollment did not
     reach verified state. Repair with npm run ops:enroll-client -- --receipt ...

Control-plane credentials are read only from the shell environment:
  PROVISIONING_RENDER_API_KEY
  PROVISIONING_RENDER_OWNER_ID
  PROVISIONING_NEON_API_KEY
  PROVISIONING_NEON_ORG_ID     optional for an organization-scoped Neon key
  PROVISIONING_CLOUDFLARE_ACCOUNT_ID
  PROVISIONING_CLOUDFLARE_API_TOKEN
  PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID
  OPS_DATABASE_URL             dedicated central Ops Registry database

Do not put control-plane API keys, OPS_DATABASE_URL, or generated secret values
in --runtime-env-file. They are used by this local command and are never copied
into ordinary client configuration or provisioning receipts.
`;
}

function parseArgs(argv) {
  const result = { execute: false, json: false, deferChannelReadiness: false };
  const valueFlags = new Map([
    ["--client", "clientSlug"],
    ["--industry", "industry"],
    ["--channels", "channels"],
    ["--runtime-env-file", "runtimeEnvFile"],
    ["--r2-provisioning", "r2Provisioning"],
    ["--r2-location", "r2Location"],
    ["--ops-enrollment", "opsEnrollment"],
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
  if (!filePath) return {};
  const absolute = path.resolve(process.cwd(), filePath);
  return dotenv.parse(fs.readFileSync(absolute));
}

function ensureProvisioningStateDir(baseDir = process.cwd()) {
  const directory = path.join(baseDir, PROVISIONING_STATE_DIR);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function isProcessRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

function acquireProvisioningLock(resourceName, {
  baseDir = process.cwd(),
  now = new Date(),
} = {}) {
  const directory = ensureProvisioningStateDir(baseDir);
  const lockPath = path.join(directory, `${resourceName}.lock`);

  const tryAcquire = () => {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        resourceName,
        pid: process.pid,
        startedAt: now.toISOString(),
      }, null, 2));
      fs.closeSync(fd);
      fd = null;
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) { /* ignore close failure */ }
      }
      if (err?.code !== "EEXIST") throw err;
      return false;
    }
  };

  if (!tryAcquire()) {
    let stale = false;
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      stale = !isProcessRunning(existing?.pid);
    } catch (_) {
      stale = false;
    }

    if (stale) {
      fs.unlinkSync(lockPath);
      if (!tryAcquire()) stale = false;
    }

    if (!stale) {
      throw new ClientProvisioningError(
        `Another local provisioning process already holds the lock for "${resourceName}".`,
        { code: "PROVISIONING_LOCKED", stage: "preflight", retrySafe: true }
      );
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (Number(existing?.pid) !== process.pid) return;
      } catch (_) {
        return;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    },
  };
}

function buildProvisioningReceipt(result, now = new Date()) {
  return {
    version: CURRENT_PROVISIONING_RECEIPT_VERSION,
    completedAt: now.toISOString(),
    lastVerifiedAt: result.readiness?.checkedAt || null,
    clientSlug: result.clientSlug,
    industry: result.industry,
    requiredChannels: [...(result.requiredChannels || [])],
    channelReadinessDeferred: result.channelReadinessDeferred === true,
    stagedReadiness: result.stagedReadiness
      ? JSON.parse(JSON.stringify(result.stagedReadiness))
      : null,
    profileContract: { ...result.profileContract },
    neon: { ...result.neon },
    r2: secretFreeR2ReceiptState(result.r2),
    render: { ...result.render },
    runtimeFinalization: result.runtimeFinalization
      ? { ...result.runtimeFinalization }
      : null,
    opsEnrollment: result.opsEnrollment
      ? JSON.parse(JSON.stringify(result.opsEnrollment))
      : null,
    readiness: result.readiness ? JSON.parse(JSON.stringify(result.readiness)) : null,
  };
}

function writeProvisioningReceipt(result, {
  baseDir = process.cwd(),
  now = new Date(),
} = {}) {
  const directory = ensureProvisioningStateDir(baseDir);
  const receiptPath = path.join(directory, `${result.clientSlug}.json`);
  const tempPath = `${receiptPath}.${process.pid}.tmp`;
  const receipt = buildProvisioningReceipt(result, now);
  fs.writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, receiptPath);
  return { receiptPath, receipt };
}

function requireReadinessAdminCredentials(runtimeEnv) {
  const username = String(runtimeEnv?.ADMIN_USERNAME || "").trim();
  const password = typeof runtimeEnv?.ADMIN_PASSWORD === "string" ? runtimeEnv.ADMIN_PASSWORD : "";
  if (!username || !password) {
    throw new ClientProvisioningError(
      "--execute requires ADMIN_USERNAME and ADMIN_PASSWORD in --runtime-env-file so the new portal can be readiness-verified.",
      { code: "READINESS_ADMIN_CREDENTIALS_REQUIRED", stage: "validation", retrySafe: true }
    );
  }
  return { username, password };
}

function runtimeEnvForReadinessPreflight(runtimeEnv, plan) {
  if (!plan?.r2?.enabled) return runtimeEnv;
  return {
    ...runtimeEnv,
    R2_ACCOUNT_ID: "managed-by-provisioner",
    R2_ACCESS_KEY_ID: "managed-by-provisioner",
    R2_SECRET_ACCESS_KEY: "managed-by-provisioner",
    R2_BUCKET_NAME: plan.r2.bucketName,
  };
}

function deferredChannelBlockerKeys(channels = []) {
  const keys = new Set();
  for (const channel of channels) {
    for (const key of CHANNEL_CHECK_KEYS[channel] || []) keys.add(key);
    keys.add(`${channel}_runtime`);
    keys.add(`${channel}_round_trip_inbound`);
    keys.add(`${channel}_round_trip_outbound`);
    keys.add(`${channel}_delivery_failure`);
  }
  return keys;
}

function evaluateDeferredChannelReadiness(readiness, channels = []) {
  const allowed = deferredChannelBlockerKeys(channels);
  const blocking = Array.isArray(readiness?.blocking) ? readiness.blocking : [];
  const pendingChannel = blocking.filter((item) => allowed.has(item?.key));
  const nonChannelBlocking = blocking.filter((item) => !allowed.has(item?.key));
  const verificationCompleted = readiness?.verificationCompleted === true
    && readiness?.status !== "verification_failed";

  return {
    acceptable: verificationCompleted && nonChannelBlocking.length === 0,
    verificationCompleted,
    pendingChannelCount: pendingChannel.length,
    nonChannelBlockingCount: nonChannelBlocking.length,
    pendingChannelKeys: [...new Set(pendingChannel.map((item) => item?.key).filter(Boolean))],
    nonChannelBlockingKeys: [...new Set(nonChannelBlocking.map((item) => item?.key).filter(Boolean))],
  };
}

function readinessFailureReport(err, { industry, channels } = {}) {
  return verificationFailureReport(err, {
    expectedIndustry: industry || null,
    requiredChannels: channels || [],
  });
}

function readinessLabel(readiness) {
  if (readiness?.status === "ready_with_warnings") return "READY WITH WARNINGS";
  if (readiness?.status === "verification_failed") return "VERIFICATION FAILED";
  return readiness?.ready ? "READY" : "NEEDS ATTENTION";
}

function printReadiness(readiness) {
  console.log("\nReadiness verification");
  console.log(`Status:         ${readinessLabel(readiness)}`);
  console.log(`Channels:       ${(readiness.requiredChannels || []).join(", ")}`);
  if (readiness.businessProfile) {
    console.log(`Business type:  ${readiness.actualIndustry || "unknown"} (${readiness.businessProfile.status})`);
  }
  for (const item of readiness.applicationChecks || []) {
    console.log(`${item.configured && item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  for (const item of readiness.channelChecks || []) {
    console.log(`${item.configured && item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  if (readiness.warnings?.length) {
    console.log("\nWarnings:");
    for (const item of readiness.warnings) console.log(`- ${item.summary}`);
  }
  if (readiness.blocking?.length) {
    console.log("\nNeeds attention:");
    for (const item of readiness.blocking) console.log(`- ${item.summary}`);
  }
}

function printOpsEnrollment(state) {
  if (!state) return;
  console.log("\nOps Registry enrollment");
  if (!state.enabled) {
    console.log(`Status:         SKIPPED (${state.mode})`);
    console.log(`Token env:      ${state.tokenEnvKey}`);
    return;
  }
  console.log(`Status:         ${state.verified ? "VERIFIED" : String(state.status || "pending").toUpperCase()}`);
  console.log(`Token env:      ${state.tokenEnvKey}`);
  console.log(`Client deploy:  ${state.clientDeployId || "n/a"} (${state.clientDeployStatus || "n/a"})`);
  console.log(`Registry deploy:${state.registryDeployId ? ` ${state.registryDeployId}` : " n/a"} (${state.registryDeployStatus || "n/a"})`);
  console.log(`Endpoint proof: ${state.endpointVerified ? "verified" : "not verified"}`);
  console.log(`Registry row:   ${state.registryRecordUpserted ? "upserted" : "not upserted"}`);
  if (state.failureCode) console.log(`Failure:        ${state.failureCode}${state.failureStage ? ` (${state.failureStage})` : ""}`);
}

function printHuman(result) {
  if (result.mode === "plan") {
    const plan = result.plan;
    console.log("Client provisioning plan (dry run; no cloud resources created)\n");
    console.log(`Client:         ${plan.clientSlug}`);
    console.log(`Industry:       ${plan.industry}`);
    console.log(`Channels:       ${(plan.readiness?.requiredChannels || []).join(", ")}`);
    if (plan.channelReadinessDeferred) {
      console.log("Execution mode:  staged (channel readiness deferred)");
    }
    console.log(`Neon project:   ${plan.neon.projectName} (${plan.neon.region})`);
    if (plan.r2) {
      const r2Label = plan.r2.enabled
        ? "will provision"
        : (plan.r2.mode === "auto" && !plan.r2.configured ? "not configured; manual runtime R2 expected" : "disabled");
      console.log(`R2 provisioning:${plan.r2.mode} (${r2Label})`);
      console.log(`R2 bucket:      ${plan.r2.bucketName} (${plan.r2.locationHint})`);
      if (plan.r2.missing?.length && plan.r2.mode === "required") {
        console.log(`R2 missing:     ${plan.r2.missing.join(", ")}`);
      }
    }
    console.log(`Render service: ${plan.render.serviceName} (${plan.render.region})`);
    console.log(`Render plan:    ${plan.render.plan || "<required before --execute>"}`);
    console.log(`Repo:           ${plan.render.repo}#${plan.render.branch}`);
    console.log(`Health check:   ${plan.render.healthCheckPath}`);
    console.log(`Runtime keys:   ${plan.render.runtimeEnvKeys.length ? plan.render.runtimeEnvKeys.join(", ") : "none"}`);
    console.log(`Profile env:    ${plan.profileContract.envKey}=${plan.profileContract.value}`);
    console.log(`Channel env:    ${plan.channelContract.envKey}=${plan.channelContract.value}`);
    if (plan.opsEnrollment) {
      const ops = plan.opsEnrollment;
      const opsLabel = ops.enabled
        ? "will enroll"
        : (ops.mode === "auto" && !ops.configured ? "not configured; will skip" : "disabled");
      console.log(`Ops enrollment: ${ops.mode} (${opsLabel})`);
      console.log(`Ops token env:  ${ops.tokenEnvKey}`);
      if (ops.missing?.length) console.log(`Ops missing:    ${ops.missing.join(", ")}`);
    }
    console.log("\nRun the same command with --execute only after reviewing this plan.");
    return;
  }

  console.log("Client infrastructure provisioning completed; Render is live.\n");
  console.log(`Client:         ${result.clientSlug}`);
  console.log(`Industry:       ${result.industry}`);
  if (result.channelReadinessDeferred) {
    console.log("Execution mode:  staged (channel readiness deferred)");
  }
  console.log(`Neon project:   ${result.neon.projectName} (${result.neon.projectId})`);
  if (result.r2?.enabled) {
    console.log(`R2 bucket:      ${result.r2.bucketName}`);
    console.log(`R2 token:       ${result.r2.tokenName} (${result.r2.tokenId || "unknown"})`);
  } else if (result.r2) {
    console.log(`R2 provisioning:${result.r2.mode} (manual/disabled)`);
  }
  console.log(`Render service: ${result.render.serviceName} (${result.render.serviceId})`);
  if (result.render.url) console.log(`Render URL:     ${result.render.url}`);
  console.log(`Initial deploy: ${result.render.deployId} (${result.render.deployStatus})`);
  if (result.runtimeFinalization?.deployId) {
    console.log(`Final deploy:   ${result.runtimeFinalization.deployId} (${result.runtimeFinalization.deployStatus})`);
  }
  if (result.render.deployedCommitSha) console.log(`Commit:         ${result.render.deployedCommitSha}`);
  console.log(`Profile lock:   ${result.profileContract.envKey}=${result.profileContract.value}`);
  console.log(`Channel contract: ${result.channelContract.envKey}=${result.channelContract.value}`);
  if (result.runtimeFinalization?.adminPasswordRemoved) {
    console.log("Bootstrap secret: ADMIN_PASSWORD removed from Render after verified admin login");
  }
  printOpsEnrollment(result.opsEnrollment);
  printReadiness(result.readiness);
  if (result.channelReadinessDeferred && result.stagedReadiness) {
    console.log("\nStaged onboarding");
    console.log(`Status:         ${result.stagedReadiness.acceptable
      ? "INFRASTRUCTURE READY; CHANNELS PENDING"
      : "NEEDS ATTENTION"}`);
    console.log(`Channel blockers deferred: ${result.stagedReadiness.pendingChannelCount}`);
    if (result.stagedReadiness.nonChannelBlockingKeys.length) {
      console.log(`Non-channel blockers: ${result.stagedReadiness.nonChannelBlockingKeys.join(", ")}`);
    }
  }
  if (result.receiptPath) console.log(`\nReceipt:        ${result.receiptPath}`);
  if (result.receiptWarning) console.log(`Receipt warning: ${result.receiptWarning}`);
}

function safeErrorOutput(err, sensitiveValues = []) {
  return {
    error: redactSensitiveText(err?.message || "Provisioning failed", sensitiveValues),
    code: err.code || "PROVISIONING_COMMAND_FAILED",
    stage: err.stage || null,
    partialResources: err.partialResources || null,
    retrySafe: err.retrySafe ?? null,
  };
}

async function captureInitialCommit(renderClient, result) {
  try {
    const deploy = await renderClient.getDeploy(result.render.serviceId, result.render.deployId);
    return extractRenderCommitSha(deploy);
  } catch (_) {
    return null;
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

  let runtimeEnv;
  try {
    runtimeEnv = loadRuntimeEnv(args.runtimeEnvFile);
  } catch (err) {
    console.error(`Could not read --runtime-env-file: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const input = {
    clientSlug: args.clientSlug,
    industry: args.industry,
    requiredChannels: args.channels,
    runtimeEnv,
    r2ProvisioningMode: args.r2Provisioning,
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
    process.env.OPS_DATABASE_URL,
    ...Object.values(runtimeEnv || {}),
  ].filter(Boolean);

  let lock = null;
  try {
    const channels = normalizeRequiredChannels(args.channels);
    const plan = buildProvisioningPlan(input, process.env);
    const opsPlan = args.execute
      ? requireOpsEnrollmentConfig({
          clientSlug: plan.clientSlug,
          mode: args.opsEnrollment,
          env: process.env,
        })
      : buildOpsEnrollmentPlan({
          clientSlug: plan.clientSlug,
          mode: args.opsEnrollment,
          env: process.env,
        });

    let result;
    if (!args.execute) {
      result = {
        mode: "plan",
        plan: {
          ...publicPlan(plan),
          readiness: { requiredChannels: channels },
          channelReadinessDeferred: args.deferChannelReadiness === true,
          opsEnrollment: opsPlan,
        },
      };
    } else {
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
      result = await provisionClient(input, {
        execute: true,
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
      let opsEnrollment = publicStateFromPlan(opsPlan);
      let preparedOps = null;
      try {
        await verifyAdminLogin({
          baseUrl: result.render.url,
          username: admin.username,
          password: admin.password,
        });

        if (opsPlan.enabled) {
          try {
            preparedOps = await prepareOpsRegistryEnrollment({
              result,
              mode: opsPlan.mode,
              env: process.env,
              renderClient,
            });
            opsEnrollment = { ...preparedOps.state };
          } catch (err) {
            opsEnrollment = opsEnrollmentFailureState(err, opsEnrollment);
          }
        }

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

        if (preparedOps) {
          markPreparedClientDeployment(preparedOps, {
            deployId: runtimeFinalization.deployId,
            deployStatus: runtimeFinalization.deployStatus,
          });
          try {
            await deployPreparedRegistryToken({
              prepared: preparedOps,
              result,
              env: process.env,
              renderClient,
            });
            opsEnrollment = await verifyAndRegisterPreparedEnrollment({
              prepared: preparedOps,
              result,
              env: process.env,
            });
          } catch (err) {
            opsEnrollment = opsEnrollmentFailureState(err, preparedOps.state);
          }
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
        opsEnrollment,
        readiness,
        stagedReadiness,
      };

      try {
        const receipt = writeProvisioningReceipt(result);
        result.receiptPath = path.relative(process.cwd(), receipt.receiptPath) || receipt.receiptPath;
      } catch (err) {
        result.receiptWarning = `Could not write local provisioning receipt: ${redactSensitiveText(err.message, sensitiveValues)}`;
      }
    }

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);

    if (result.mode === "executed") {
      if (result.readiness?.status === "verification_failed") {
        process.exitCode = READINESS_VERIFICATION_FAILED_EXIT_CODE;
      } else if (result.opsEnrollment?.enabled && result.opsEnrollment?.verified !== true) {
        process.exitCode = OPS_ENROLLMENT_FAILED_EXIT_CODE;
      } else if (
        result.channelReadinessDeferred
        && result.stagedReadiness?.acceptable === true
      ) {
        // Staged provisioning succeeded: infrastructure/core health is ready
        // and only purchased-channel readiness is intentionally pending.
      } else if (result.readiness?.ready !== true) {
        process.exitCode = READINESS_NEEDS_ATTENTION_EXIT_CODE;
      }
    }
  } catch (err) {
    const output = safeErrorOutput(err, sensitiveValues);
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else {
      console.error(`Provisioning stopped: ${output.error}`);
      if (output.partialResources) {
        console.error(`Preserved resources: ${JSON.stringify(output.partialResources)}`);
      }
    }
    process.exitCode = err instanceof ClientProvisioningError
      || err instanceof ClientReadinessError
      || err instanceof OpsRegistryEnrollmentError
      || err instanceof R2ProvisioningError
      ? 2
      : 1;
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch (err) {
        console.error(`Warning: could not release local provisioning lock: ${err.message}`);
      }
    }
  }
}

if (require.main === module) main();

module.exports = {
  OPS_ENROLLMENT_FAILED_EXIT_CODE,
  PROVISIONING_STATE_DIR,
  READINESS_NEEDS_ATTENTION_EXIT_CODE,
  READINESS_VERIFICATION_FAILED_EXIT_CODE,
  acquireProvisioningLock,
  buildProvisioningReceipt,
  captureInitialCommit,
  deferredChannelBlockerKeys,
  ensureProvisioningStateDir,
  evaluateDeferredChannelReadiness,
  isProcessRunning,
  loadRuntimeEnv,
  parseArgs,
  readinessFailureReport,
  requireReadinessAdminCredentials,
  runtimeEnvForReadinessPreflight,
  safeErrorOutput,
  usage,
  writeProvisioningReceipt,
};
