const {
  buildProvisioningPlan,
  requireExecutionConfig,
} = require("./clientProvisioner");
const {
  createJsonRequester,
} = require("./providerClients");
const {
  createCloudflareR2Client,
  r2RuntimeEnv,
} = require("./r2Provisioning");
const {
  extractRenderDeploy,
} = require("./renderFinalizer");

class ClientRecoveryError extends Error {
  constructor(message, {
    code = "CLIENT_RECOVERY_ERROR",
    stage = null,
    retrySafe = null,
  } = {}) {
    super(message);
    this.name = "ClientRecoveryError";
    this.code = code;
    this.stage = stage;
    this.retrySafe = retrySafe;
  }
}

function exactlyOne(items, label, code) {
  const list = Array.isArray(items) ? items : [];
  if (list.length !== 1) {
    throw new ClientRecoveryError(
      list.length
        ? `Recovery found ${list.length} ${label} resources. Resolve the ambiguity before continuing.`
        : `Recovery could not find the expected ${label} resource.`,
      { code, stage: "recovery_preflight", retrySafe: true }
    );
  }
  return list[0];
}

function selectNeonBranch(branches = []) {
  const list = Array.isArray(branches) ? branches : [];
  const active = list.filter((branch) => !branch?.deleted_at);
  const activeMain = active.filter((branch) => branch?.name === "main");
  const branch = activeMain.length === 1
    ? activeMain[0]
    : (active.length === 1 ? active[0] : null);
  if (!branch?.id) {
    throw new ClientRecoveryError(
      "Recovery could not determine a unique Neon branch for the interrupted project.",
      { code: "RECOVERY_NEON_BRANCH_AMBIGUOUS", stage: "neon_recovery", retrySafe: true }
    );
  }
  return branch;
}

function selectNeonDefaults({ branches, databases, roles } = {}) {
  const branch = selectNeonBranch(branches);
  const databaseList = Array.isArray(databases) ? databases : [];
  const matchingDatabases = databaseList.filter((item) => item?.name === "neondb");
  const database = matchingDatabases.length === 1
    ? matchingDatabases[0]
    : (databaseList.length === 1 ? databaseList[0] : null);
  if (!database?.name) {
    throw new ClientRecoveryError(
      "Recovery could not determine a unique Neon database for the interrupted project.",
      { code: "RECOVERY_NEON_DATABASE_AMBIGUOUS", stage: "neon_recovery", retrySafe: true }
    );
  }

  const roleList = Array.isArray(roles) ? roles : [];
  const ownerName = database.owner_name || database.ownerName || null;
  const matchingRoles = ownerName ? roleList.filter((item) => item?.name === ownerName) : [];
  const role = matchingRoles.length === 1
    ? matchingRoles[0]
    : (roleList.length === 1 ? roleList[0] : null);
  if (!role?.name) {
    throw new ClientRecoveryError(
      "Recovery could not determine the Neon database owner role for the interrupted project.",
      { code: "RECOVERY_NEON_ROLE_AMBIGUOUS", stage: "neon_recovery", retrySafe: true }
    );
  }

  return {
    branchId: branch.id,
    databaseName: database.name,
    roleName: role.name,
  };
}

async function discoverNeonDefaults({
  projectId,
  apiKey,
  fetchImpl = global.fetch,
  baseUrl = "https://console.neon.tech/api/v2/",
} = {}) {
  if (!projectId || !apiKey) {
    throw new ClientRecoveryError("Neon recovery requires a project ID and provisioning API key.", {
      code: "RECOVERY_NEON_CONFIG_REQUIRED",
      stage: "validation",
      retrySafe: true,
    });
  }
  const request = createJsonRequester({
    provider: "Neon",
    baseUrl,
    token: apiKey,
    fetchImpl,
  });
  const encodedProject = encodeURIComponent(projectId);
  const branchPayload = await request(`projects/${encodedProject}/branches`, {
    query: { search: "main", limit: 100 },
  });
  const branches = Array.isArray(branchPayload?.branches) ? branchPayload.branches : [];
  const branch = selectNeonBranch(branches);
  const encodedBranch = encodeURIComponent(branch.id);
  const [databasePayload, rolePayload] = await Promise.all([
    request(`projects/${encodedProject}/branches/${encodedBranch}/databases`),
    request(`projects/${encodedProject}/branches/${encodedBranch}/roles`),
  ]);
  return selectNeonDefaults({
    branches,
    databases: Array.isArray(databasePayload?.databases) ? databasePayload.databases : [],
    roles: Array.isArray(rolePayload?.roles) ? rolePayload.roles : [],
  });
}

function fullRenderEnvVars(plan, databaseUrl, managedRuntimeEnv) {
  return [
    { key: "CLIENT_SLUG", value: plan.clientSlug },
    { key: "INITIAL_BUSINESS_TYPE", value: plan.industry },
    { key: "PURCHASED_CHANNELS", value: plan.requiredChannels.join(",") },
    { key: "DATABASE_URL", value: databaseUrl },
    { key: "SESSION_SECRET", generateValue: true },
    ...Object.entries(managedRuntimeEnv).map(([key, value]) => ({ key, value })),
    ...Object.entries(plan.runtimeEnv).map(([key, value]) => ({ key, value })),
  ];
}

function validateExistingRenderService(service, plan) {
  if (!service?.id) {
    throw new ClientRecoveryError("Existing Render service is missing its service ID.", {
      code: "RECOVERY_RENDER_SERVICE_ID_MISSING",
      stage: "render_recovery",
      retrySafe: false,
    });
  }
  const actualRepo = service.repo || service.repository || service.serviceDetails?.repo || null;
  const actualBranch = service.branch || service.serviceDetails?.branch || null;
  if (actualRepo && actualRepo !== plan.render.repo) {
    throw new ClientRecoveryError(
      `Existing Render service repository does not match the recovery plan. Expected ${plan.render.repo}, found ${actualRepo}.`,
      { code: "RECOVERY_RENDER_REPO_MISMATCH", stage: "recovery_preflight", retrySafe: false }
    );
  }
  if (actualBranch && actualBranch !== plan.render.branch) {
    throw new ClientRecoveryError(
      `Existing Render service branch does not match the recovery plan. Expected ${plan.render.branch}, found ${actualBranch}.`,
      { code: "RECOVERY_RENDER_BRANCH_MISMATCH", stage: "recovery_preflight", retrySafe: false }
    );
  }
  return service;
}

async function redeployExistingRenderWithR2({
  serviceId,
  managedRuntimeEnv,
  apiKey,
  renderClient,
  fetchImpl = global.fetch,
  baseUrl = "https://api.render.com/v1/",
} = {}) {
  if (!serviceId || !apiKey || !renderClient) {
    throw new ClientRecoveryError("Render recovery requires the service ID, provisioning API key, and Render client.", {
      code: "RECOVERY_RENDER_CONFIG_REQUIRED",
      stage: "validation",
      retrySafe: true,
    });
  }
  const request = createJsonRequester({
    provider: "Render",
    baseUrl,
    token: apiKey,
    fetchImpl,
  });
  const encodedService = encodeURIComponent(serviceId);
  for (const [key, value] of Object.entries(managedRuntimeEnv || {})) {
    await request(`services/${encodedService}/env-vars/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
      sensitiveValues: [value],
    });
  }
  const deployPayload = await request(`services/${encodedService}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  const queued = extractRenderDeploy(deployPayload);
  if (!queued?.id) {
    throw new ClientRecoveryError("Render recovery deploy response did not include a deploy ID.", {
      code: "RECOVERY_RENDER_DEPLOY_ID_MISSING",
      stage: "render_recovery",
      retrySafe: false,
    });
  }
  const live = await renderClient.waitForDeploy(serviceId, queued.id);
  return {
    deployId: queued.id,
    deployStatus: String(live?.status || "live").toLowerCase(),
  };
}

async function recoverInterruptedProvisioning(input = {}, {
  env = process.env,
  renderClient,
  neonClient,
  r2Client = null,
  fetchImpl = global.fetch,
  discoverNeonDefaultsImpl = discoverNeonDefaults,
  redeployExistingRenderImpl = redeployExistingRenderWithR2,
} = {}) {
  const plan = buildProvisioningPlan({
    ...input,
    r2ProvisioningMode: input.r2ProvisioningMode || "required",
  }, env);
  requireExecutionConfig(plan, env);
  if (!plan.r2.enabled) {
    throw new ClientRecoveryError("Interrupted provisioning recovery requires automated R2 provisioning to be enabled.", {
      code: "RECOVERY_R2_NOT_ENABLED",
      stage: "validation",
      retrySafe: true,
    });
  }
  if (!renderClient || !neonClient) {
    throw new ClientRecoveryError("Recovery requires initialized Render and Neon clients.", {
      code: "RECOVERY_PROVIDER_CLIENTS_REQUIRED",
      stage: "validation",
      retrySafe: true,
    });
  }
  const activeR2Client = r2Client || createCloudflareR2Client({
    apiToken: env.PROVISIONING_CLOUDFLARE_API_TOKEN,
    accountId: plan.r2.accountId,
    fetchImpl,
  });

  const [renderMatches, neonMatches, bucketMatches] = await Promise.all([
    renderClient.findServicesByExactName(plan.render.serviceName),
    neonClient.findProjectsByExactName(plan.neon.projectName),
    activeR2Client.findBucketsByExactName(plan.r2.bucketName),
  ]);
  const neonProject = exactlyOne(neonMatches, "Neon project", "RECOVERY_NEON_PROJECT_NOT_UNIQUE");
  if (Array.isArray(renderMatches) && renderMatches.length > 1) {
    throw new ClientRecoveryError("Recovery found multiple Render services with the expected name. Resolve the ambiguity first.", {
      code: "RECOVERY_RENDER_SERVICE_AMBIGUOUS",
      stage: "recovery_preflight",
      retrySafe: true,
    });
  }
  if (Array.isArray(bucketMatches) && bucketMatches.length > 1) {
    throw new ClientRecoveryError("Recovery found multiple R2 buckets with the expected name. Resolve the ambiguity first.", {
      code: "RECOVERY_R2_BUCKET_AMBIGUOUS",
      stage: "recovery_preflight",
      retrySafe: true,
    });
  }
  if (renderMatches.length === 1) validateExistingRenderService(renderMatches[0], plan);

  let bucket = bucketMatches[0] || null;
  let createdR2Bucket = false;
  if (!bucket) {
    try {
      bucket = await activeR2Client.createBucket({
        name: plan.r2.bucketName,
        locationHint: plan.r2.locationHint,
      });
      createdR2Bucket = true;
    } catch (err) {
      throw new ClientRecoveryError(
        `Recovery confirmed the expected R2 bucket was absent but could not create it: ${err?.message || "R2 bucket creation failed"}.`,
        {
          code: "RECOVERY_R2_BUCKET_CREATE_FAILED",
          stage: "r2_recovery",
          retrySafe: err?.ambiguous === true ? false : null,
        }
      );
    }
  }
  if (bucket.location && bucket.location !== plan.r2.locationHint) {
    throw new ClientRecoveryError(
      `Existing R2 bucket location ${bucket.location} does not match the recovery plan ${plan.r2.locationHint}.`,
      { code: "RECOVERY_R2_LOCATION_MISMATCH", stage: "recovery_preflight", retrySafe: false }
    );
  }

  const neonDefaults = await discoverNeonDefaultsImpl({
    projectId: neonProject.id,
    apiKey: env.PROVISIONING_NEON_API_KEY,
    fetchImpl,
  });
  const databaseUrl = await neonClient.getPooledConnectionUri({
    projectId: neonProject.id,
    databaseName: neonDefaults.databaseName,
    roleName: neonDefaults.roleName,
  });

  const credentials = await activeR2Client.recoverBucketCredentials({
    bucketName: plan.r2.bucketName,
    tokenName: plan.r2.tokenName,
    jurisdiction: plan.r2.jurisdiction,
  });
  const managedRuntimeEnv = r2RuntimeEnv({
    accountId: plan.r2.accountId,
    bucketName: plan.r2.bucketName,
    credentials,
  });

  let service;
  let deployId;
  let deployStatus;
  let reusedRender = false;
  if (renderMatches.length === 1) {
    service = renderMatches[0];
    const redeployed = await redeployExistingRenderImpl({
      serviceId: service.id,
      managedRuntimeEnv,
      apiKey: env.PROVISIONING_RENDER_API_KEY,
      renderClient,
      fetchImpl,
    });
    deployId = redeployed.deployId;
    deployStatus = redeployed.deployStatus;
    reusedRender = true;
  } else {
    const created = await renderClient.createWebService({
      name: plan.render.serviceName,
      repo: plan.render.repo,
      branch: plan.render.branch,
      region: plan.render.region,
      plan: plan.render.plan,
      buildCommand: plan.render.buildCommand,
      startCommand: plan.render.startCommand,
      healthCheckPath: plan.render.healthCheckPath,
      envVars: fullRenderEnvVars(plan, databaseUrl, managedRuntimeEnv),
    });
    service = created?.service || created || {};
    deployId = created?.deployId || null;
    if (!service?.id || !deployId) {
      throw new ClientRecoveryError("Recovered Render creation did not return a service ID and deploy ID.", {
        code: "RECOVERY_RENDER_CREATE_RESPONSE_INCOMPLETE",
        stage: "render_recovery",
        retrySafe: false,
      });
    }
    const live = await renderClient.waitForDeploy(service.id, deployId);
    deployStatus = String(live?.status || "live").toLowerCase();
  }

  return {
    mode: "executed",
    recovered: true,
    recovery: {
      reusedNeon: true,
      reusedR2Bucket: !createdR2Bucket,
      createdR2Bucket,
      recoveredR2Token: credentials.recovered === true,
      createdR2Token: credentials.created === true,
      reusedRender,
    },
    clientSlug: plan.clientSlug,
    industry: plan.industry,
    requiredChannels: [...plan.requiredChannels],
    neon: {
      projectId: neonProject.id,
      projectName: plan.neon.projectName,
      databaseName: neonDefaults.databaseName,
      roleName: neonDefaults.roleName,
      region: plan.neon.region,
    },
    r2: {
      mode: plan.r2.mode,
      enabled: true,
      provisioned: true,
      bucketName: plan.r2.bucketName,
      tokenId: credentials.tokenId,
      tokenName: plan.r2.tokenName,
      locationHint: plan.r2.locationHint,
      jurisdiction: plan.r2.jurisdiction,
    },
    render: {
      serviceId: service.id,
      serviceName: service.name || plan.render.serviceName,
      url: service.serviceDetails?.url || service.url || null,
      deployId,
      deployStatus,
      region: plan.render.region,
      plan: plan.render.plan,
      repo: plan.render.repo,
      branch: plan.render.branch,
      healthCheckPath: plan.render.healthCheckPath,
    },
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: plan.industry,
      lockedOnFirstStartup: true,
    },
    channelContract: {
      envKey: "PURCHASED_CHANNELS",
      value: plan.requiredChannels.join(","),
    },
  };
}

module.exports = {
  ClientRecoveryError,
  discoverNeonDefaults,
  exactlyOne,
  fullRenderEnvVars,
  recoverInterruptedProvisioning,
  redeployExistingRenderWithR2,
  selectNeonBranch,
  selectNeonDefaults,
  validateExistingRenderService,
};
