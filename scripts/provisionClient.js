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
  ClientReadinessError,
  normalizeRequiredChannels,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");

const PROVISIONING_STATE_DIR = ".provisioning";
const READINESS_NEEDS_ATTENTION_EXIT_CODE = 3;

function usage() {
  return `
Provision one client Render service + Neon database and verify that the new
chatbot is ready for its purchased messaging channels.

Usage:
  npm run provision-client -- --client <slug> --industry <profile> --channels <csv> [options]

Required:
  --client <slug>             Stable client slug, e.g. acme-renovation
  --industry <profile>        aesthetic_clinic | home_renovation | generic
  --channels <csv>            Required channels: whatsapp, facebook, instagram
                              Example: whatsapp,instagram

Safe by default:
  Without --execute, this command only prints the provisioning/readiness plan
  and performs no network calls or cloud mutations.

Options:
  --execute                   Create Neon + Render, wait for first deploy to be
                              live, then run authenticated Setup Status checks
  --runtime-env-file <path>   dotenv file containing client runtime variables.
                              For --execute it must include ADMIN_USERNAME and
                              ADMIN_PASSWORD so readiness can authenticate.
  --render-plan <plan>        Render instance plan. Required for --execute
                              unless PROVISIONING_RENDER_PLAN is set.
  --render-region <region>    Default: singapore
  --neon-region <region-id>   Default: aws-ap-southeast-1
  --resource-prefix <prefix>  Default: da-chatbot
  --repo <url>                Render Git repository URL
  --branch <name>             Render Git branch, default: main
  --json                      Machine-readable output
  --help                      Show this help

Readiness rules:
  Core application checks must be ready, the locked business profile must match
  --industry, and only the channels listed in --channels are mandatory.
  Messenger/Instagram/WhatsApp webhook checks may require a real inbound test
  message before the final status becomes READY.

Exit codes:
  0  Provisioned and READY (or dry-run plan)
  2  Provisioning/input failure
  3  Infrastructure is live but readiness NEEDS ATTENTION

Control-plane credentials are read only from the shell environment:
  PROVISIONING_RENDER_API_KEY
  PROVISIONING_RENDER_OWNER_ID
  PROVISIONING_NEON_API_KEY
  PROVISIONING_NEON_ORG_ID     optional for an organization-scoped Neon key

Do not put Render/Neon control-plane API keys in --runtime-env-file. They are
used by this local command and are never copied into the client.
`;
}

function parseArgs(argv) {
  const result = { execute: false, json: false };
  const valueFlags = new Map([
    ["--client", "clientSlug"],
    ["--industry", "industry"],
    ["--channels", "channels"],
    ["--runtime-env-file", "runtimeEnvFile"],
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
  const contents = fs.readFileSync(absolute);
  return dotenv.parse(contents);
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
    version: 2,
    completedAt: now.toISOString(),
    clientSlug: result.clientSlug,
    industry: result.industry,
    requiredChannels: [...(result.requiredChannels || [])],
    profileContract: { ...result.profileContract },
    neon: { ...result.neon },
    render: { ...result.render },
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

function readinessFailureReport(err, { industry, channels } = {}) {
  return {
    status: "needs_attention",
    ready: false,
    checkedAt: new Date().toISOString(),
    expectedIndustry: industry || null,
    actualIndustry: null,
    requiredChannels: [...(channels || [])],
    businessProfile: null,
    applicationChecks: [],
    channelChecks: [],
    blocking: [{
      key: err?.code || "readiness_verification",
      status: "error",
      summary: err?.message || "Readiness verification could not be completed.",
    }],
    summary: { blocking: 1, applicationReady: 0, applicationTotal: 0, channelReady: 0, channelTotal: 0 },
  };
}

function printReadiness(readiness) {
  console.log("\nReadiness verification");
  console.log(`Status:         ${readiness.ready ? "READY" : "NEEDS ATTENTION"}`);
  console.log(`Channels:       ${(readiness.requiredChannels || []).join(", ")}`);
  if (readiness.businessProfile) {
    console.log(`Business type:  ${readiness.actualIndustry || "unknown"} (${readiness.businessProfile.status})`);
  }
  for (const item of readiness.applicationChecks || []) {
    console.log(`${item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  for (const item of readiness.channelChecks || []) {
    console.log(`${item.status === "ready" ? "[OK]" : "[!!]"} ${item.label}: ${item.summary}`);
  }
  if (readiness.blocking?.length) {
    console.log("\nNeeds attention:");
    for (const item of readiness.blocking) console.log(`- ${item.summary}`);
  }
}

function printHuman(result) {
  if (result.mode === "plan") {
    const plan = result.plan;
    console.log("Client provisioning plan (dry run; no cloud resources created)\n");
    console.log(`Client:         ${plan.clientSlug}`);
    console.log(`Industry:       ${plan.industry}`);
    console.log(`Channels:       ${(plan.readiness?.requiredChannels || []).join(", ")}`);
    console.log(`Neon project:   ${plan.neon.projectName} (${plan.neon.region})`);
    console.log(`Render service: ${plan.render.serviceName} (${plan.render.region})`);
    console.log(`Render plan:    ${plan.render.plan || "<required before --execute>"}`);
    console.log(`Repo:           ${plan.render.repo}#${plan.render.branch}`);
    console.log(`Health check:   ${plan.render.healthCheckPath}`);
    console.log(`Runtime keys:   ${plan.render.runtimeEnvKeys.length ? plan.render.runtimeEnvKeys.join(", ") : "none"}`);
    console.log(`Profile env:    ${plan.profileContract.envKey}=${plan.profileContract.value}`);
    console.log("\nRun the same command with --execute only after reviewing this plan.");
    return;
  }

  console.log("Client infrastructure provisioning completed; initial Render deploy is live.\n");
  console.log(`Client:         ${result.clientSlug}`);
  console.log(`Industry:       ${result.industry}`);
  console.log(`Neon project:   ${result.neon.projectName} (${result.neon.projectId})`);
  console.log(`Render service: ${result.render.serviceName} (${result.render.serviceId})`);
  if (result.render.url) console.log(`Render URL:     ${result.render.url}`);
  console.log(`Initial deploy: ${result.render.deployId} (${result.render.deployStatus})`);
  console.log(`Profile lock:   ${result.profileContract.envKey}=${result.profileContract.value}`);
  printReadiness(result.readiness);
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
    runtimeEnv,
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
    ...Object.values(runtimeEnv || {}),
  ].filter(Boolean);

  let lock = null;
  try {
    const channels = normalizeRequiredChannels(args.channels);
    const plan = buildProvisioningPlan(input, process.env);

    let result;
    if (!args.execute) {
      result = {
        mode: "plan",
        plan: {
          ...publicPlan(plan),
          readiness: { requiredChannels: channels },
        },
      };
    } else {
      requireExecutionConfig(plan, process.env);
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

      let readiness;
      try {
        readiness = await verifyClientReadiness({
          baseUrl: result.render.url,
          username: admin.username,
          password: admin.password,
          expectedIndustry: result.industry,
          requiredChannels: channels,
        });
      } catch (err) {
        readiness = readinessFailureReport(err, { industry: result.industry, channels });
      }

      result = { ...result, requiredChannels: channels, readiness };

      // Cloud provisioning has already succeeded at this point. A local disk
      // issue must never turn a live client deployment into a false failure.
      try {
        const receipt = writeProvisioningReceipt(result);
        result.receiptPath = path.relative(process.cwd(), receipt.receiptPath) || receipt.receiptPath;
      } catch (err) {
        result.receiptWarning = `Could not write local provisioning receipt: ${redactSensitiveText(err.message, sensitiveValues)}`;
      }
    }

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);

    if (result.mode === "executed" && result.readiness?.ready !== true) {
      process.exitCode = READINESS_NEEDS_ATTENTION_EXIT_CODE;
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
    process.exitCode = err instanceof ClientProvisioningError || err instanceof ClientReadinessError ? 2 : 1;
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
  PROVISIONING_STATE_DIR,
  READINESS_NEEDS_ATTENTION_EXIT_CODE,
  acquireProvisioningLock,
  buildProvisioningReceipt,
  ensureProvisioningStateDir,
  isProcessRunning,
  loadRuntimeEnv,
  parseArgs,
  readinessFailureReport,
  requireReadinessAdminCredentials,
  safeErrorOutput,
  usage,
  writeProvisioningReceipt,
};
