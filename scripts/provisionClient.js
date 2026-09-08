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
} = require("../src/provisioning/clientProvisioner");
const {
  createNeonClient,
  createRenderClient,
} = require("../src/provisioning/providerClients");

function usage() {
  return `
Provision one client Render service + Neon database with an explicit industry profile.

Usage:
  npm run provision-client -- --client <slug> --industry <profile> [options]

Required:
  --client <slug>             Stable client slug, e.g. acme-renovation
  --industry <profile>        aesthetic_clinic | home_renovation | generic

Safe by default:
  With no --execute flag, this command only prints the provisioning plan and
  performs no network calls or cloud mutations.

Options:
  --execute                   Create the Neon project and Render web service
  --runtime-env-file <path>   dotenv file containing app runtime variables
                              (Meta, Gemini, R2, admin credentials, etc.)
  --render-plan <plan>        Render instance plan. Required for --execute
                              unless PROVISIONING_RENDER_PLAN is set.
  --render-region <region>    Default: singapore
  --neon-region <region-id>   Default: aws-ap-southeast-1
  --resource-prefix <prefix>  Default: da-chatbot
  --repo <url>                Render Git repository URL
  --branch <name>             Render Git branch, default: main
  --json                      Machine-readable output
  --help                      Show this help

Control-plane credentials are read only from the shell environment:
  PROVISIONING_RENDER_API_KEY
  PROVISIONING_RENDER_OWNER_ID
  PROVISIONING_NEON_API_KEY
  PROVISIONING_NEON_ORG_ID     optional for an organization-scoped Neon key

Do not put Render/Neon control-plane API keys in --runtime-env-file. They are
used by this local provisioning command and are never copied into the client.
`;
}

function parseArgs(argv) {
  const result = {
    execute: false,
    json: false,
  };

  const valueFlags = new Map([
    ["--client", "clientSlug"],
    ["--industry", "industry"],
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

function printHuman(result) {
  if (result.mode === "plan") {
    const plan = result.plan;
    console.log("Client provisioning plan (dry run; no cloud resources created)\n");
    console.log(`Client:        ${plan.clientSlug}`);
    console.log(`Industry:      ${plan.industry}`);
    console.log(`Neon project:  ${plan.neon.projectName} (${plan.neon.region})`);
    console.log(`Render service:${plan.render.serviceName} (${plan.render.region})`);
    console.log(`Render plan:   ${plan.render.plan || "<required before --execute>"}`);
    console.log(`Repo:          ${plan.render.repo}#${plan.render.branch}`);
    console.log(`Runtime keys:  ${plan.render.runtimeEnvKeys.length ? plan.render.runtimeEnvKeys.join(", ") : "none"}`);
    console.log(`Profile env:   ${plan.profileContract.envKey}=${plan.profileContract.value}`);
    console.log("\nRun the same command with --execute only after reviewing this plan.");
    return;
  }

  console.log("Client provisioning completed.\n");
  console.log(`Client:         ${result.clientSlug}`);
  console.log(`Industry:       ${result.industry}`);
  console.log(`Neon project:   ${result.neon.projectName} (${result.neon.projectId})`);
  console.log(`Render service: ${result.render.serviceName} (${result.render.serviceId || "id unavailable"})`);
  if (result.render.url) console.log(`Render URL:     ${result.render.url}`);
  if (result.render.deployId) console.log(`Initial deploy: ${result.render.deployId}`);
  console.log(`Profile lock:   ${result.profileContract.envKey}=${result.profileContract.value}`);
}

function safeErrorOutput(err) {
  return {
    error: err.message,
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

  try {
    // Validate and normalize before initializing any provider client. This keeps
    // bad client/industry/runtime-env input completely local and side-effect free.
    const plan = buildProvisioningPlan(input, process.env);

    let result;
    if (!args.execute) {
      result = { mode: "plan", plan: publicPlan(plan) };
    } else {
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
    }

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } catch (err) {
    const output = safeErrorOutput(err);
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else {
      console.error(`Provisioning stopped: ${output.error}`);
      if (output.partialResources) {
        console.error(`Preserved resources: ${JSON.stringify(output.partialResources)}`);
      }
    }
    process.exitCode = err instanceof ClientProvisioningError ? 2 : 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadRuntimeEnv,
  parseArgs,
  safeErrorOutput,
  usage,
};
