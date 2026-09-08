const {
  SUPPORTED_BUSINESS_TYPES,
  normalizeBusinessType,
} = require("../config/industryProfiles");

const DEFAULT_RENDER_REPO = "https://github.com/hoenotfound/clinic_ai_chatbot";
const DEFAULT_RENDER_BRANCH = "main";
const DEFAULT_RENDER_REGION = "singapore";
const DEFAULT_NEON_REGION = "aws-ap-southeast-1";
const DEFAULT_BUILD_COMMAND = "npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build";
const DEFAULT_START_COMMAND = "npm start";
const DEFAULT_RESOURCE_PREFIX = "da-chatbot";
const DEFAULT_HEALTH_CHECK_PATH = "/";

const RENDER_REGIONS = Object.freeze([
  "frankfurt",
  "oregon",
  "ohio",
  "singapore",
  "virginia",
]);

const RENDER_PLANS = Object.freeze([
  "starter",
  "starter_plus",
  "standard",
  "standard_plus",
  "pro",
  "pro_plus",
  "pro_max",
  "pro_ultra",
  "free",
  "custom",
  "starter_legacy",
  "standard_legacy",
  "standard_plus_legacy",
  "pro_legacy",
  "pro_plus_legacy",
]);

const RESERVED_RUNTIME_ENV_KEYS = new Set([
  "DATABASE_URL",
  "SESSION_SECRET",
  "INITIAL_BUSINESS_TYPE",
  "BUSINESS_TYPE",
  "PUBLIC_BASE_URL",
  "PORT",
]);

class ClientProvisioningError extends Error {
  constructor(message, {
    code = "CLIENT_PROVISIONING_ERROR",
    stage = null,
    partialResources = null,
    retrySafe = null,
  } = {}) {
    super(message);
    this.name = "ClientProvisioningError";
    this.code = code;
    this.stage = stage;
    this.partialResources = partialResources;
    this.retrySafe = retrySafe;
  }
}

function normalizeClientSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!slug) {
    throw new ClientProvisioningError("A client slug is required.", {
      code: "CLIENT_SLUG_REQUIRED",
      stage: "validation",
    });
  }
  if (slug.length > 40) {
    throw new ClientProvisioningError("Client slug must be 40 characters or fewer after normalization.", {
      code: "CLIENT_SLUG_TOO_LONG",
      stage: "validation",
    });
  }
  return slug;
}

function requireIndustry(value) {
  if (!String(value || "").trim()) {
    throw new ClientProvisioningError(
      `Industry is required for provisioning. Use one of: ${SUPPORTED_BUSINESS_TYPES.join(", ")}.`,
      { code: "INDUSTRY_REQUIRED", stage: "validation" }
    );
  }
  const normalized = normalizeBusinessType(value);
  if (!normalized) {
    throw new ClientProvisioningError(
      `Unsupported industry "${value}". Use one of: ${SUPPORTED_BUSINESS_TYPES.join(", ")}.`,
      { code: "INDUSTRY_UNSUPPORTED", stage: "validation" }
    );
  }
  return normalized;
}

function requireRenderRegion(value) {
  const region = String(value || "").trim().toLowerCase();
  if (!RENDER_REGIONS.includes(region)) {
    throw new ClientProvisioningError(
      `Unsupported Render region "${value}". Use one of: ${RENDER_REGIONS.join(", ")}.`,
      { code: "RENDER_REGION_UNSUPPORTED", stage: "validation" }
    );
  }
  return region;
}

function normalizeRenderPlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  if (!plan) return null;
  if (!RENDER_PLANS.includes(plan)) {
    throw new ClientProvisioningError(
      `Unsupported Render plan "${value}". Use one of: ${RENDER_PLANS.join(", ")}.`,
      { code: "RENDER_PLAN_UNSUPPORTED", stage: "validation" }
    );
  }
  return plan;
}

function normalizeRuntimeEnv(runtimeEnv = {}) {
  if (!runtimeEnv || typeof runtimeEnv !== "object" || Array.isArray(runtimeEnv)) {
    throw new ClientProvisioningError("Runtime environment values must be provided as a key/value object.", {
      code: "RUNTIME_ENV_INVALID",
      stage: "validation",
    });
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(runtimeEnv)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new ClientProvisioningError(`Invalid runtime environment key "${key}".`, {
        code: "RUNTIME_ENV_KEY_INVALID",
        stage: "validation",
      });
    }
    if (RESERVED_RUNTIME_ENV_KEYS.has(key) || key.startsWith("PROVISIONING_")) {
      throw new ClientProvisioningError(
        `${key} is reserved for provisioning control and cannot be copied into client runtime environment input.`,
        { code: "RUNTIME_ENV_RESERVED", stage: "validation" }
      );
    }
    if (rawValue === undefined || rawValue === null) continue;
    normalized[key] = String(rawValue);
  }
  return normalized;
}

function resourceName(prefix, slug) {
  return `${prefix}-${slug}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function buildProvisioningPlan(input = {}, env = process.env) {
  const clientSlug = normalizeClientSlug(input.clientSlug);
  const industry = requireIndustry(input.industry);
  const runtimeEnv = normalizeRuntimeEnv(input.runtimeEnv || {});
  const prefix = normalizeClientSlug(
    input.resourcePrefix || env.PROVISIONING_RESOURCE_PREFIX || DEFAULT_RESOURCE_PREFIX
  );
  const name = resourceName(prefix, clientSlug);
  const renderPlan = normalizeRenderPlan(
    input.renderPlan || env.PROVISIONING_RENDER_PLAN || ""
  );
  const renderRegion = requireRenderRegion(
    input.renderRegion || env.PROVISIONING_RENDER_REGION || DEFAULT_RENDER_REGION
  );

  return {
    clientSlug,
    industry,
    resourceName: name,
    neon: {
      projectName: name,
      region: String(input.neonRegion || env.PROVISIONING_NEON_REGION || DEFAULT_NEON_REGION).trim(),
      orgId: String(input.neonOrgId || env.PROVISIONING_NEON_ORG_ID || "").trim() || null,
    },
    render: {
      serviceName: name,
      ownerId: String(input.renderOwnerId || env.PROVISIONING_RENDER_OWNER_ID || "").trim() || null,
      repo: String(input.renderRepo || env.PROVISIONING_RENDER_REPO || DEFAULT_RENDER_REPO).trim(),
      branch: String(input.renderBranch || env.PROVISIONING_RENDER_BRANCH || DEFAULT_RENDER_BRANCH).trim(),
      region: renderRegion,
      plan: renderPlan,
      buildCommand: String(
        input.buildCommand || env.PROVISIONING_RENDER_BUILD_COMMAND || DEFAULT_BUILD_COMMAND
      ).trim(),
      startCommand: String(
        input.startCommand || env.PROVISIONING_RENDER_START_COMMAND || DEFAULT_START_COMMAND
      ).trim(),
      healthCheckPath: DEFAULT_HEALTH_CHECK_PATH,
      runtimeEnvKeys: Object.keys(runtimeEnv).sort(),
    },
    runtimeEnv,
  };
}

function publicPlan(plan) {
  return {
    clientSlug: plan.clientSlug,
    industry: plan.industry,
    resourceName: plan.resourceName,
    neon: { ...plan.neon },
    render: { ...plan.render },
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: plan.industry,
      lockedOnFirstStartup: true,
    },
  };
}

function renderEnvVars(plan, databaseUrl) {
  const custom = Object.entries(plan.runtimeEnv).map(([key, value]) => ({ key, value }));
  return [
    { key: "INITIAL_BUSINESS_TYPE", value: plan.industry },
    { key: "DATABASE_URL", value: databaseUrl },
    { key: "SESSION_SECRET", generateValue: true },
    ...custom,
  ];
}

function requireExecutionConfig(plan, env = process.env) {
  const missing = [];
  if (!String(env.PROVISIONING_RENDER_API_KEY || "").trim()) {
    missing.push("PROVISIONING_RENDER_API_KEY");
  }
  if (!plan.render.ownerId) missing.push("PROVISIONING_RENDER_OWNER_ID");
  if (!String(env.PROVISIONING_NEON_API_KEY || "").trim()) {
    missing.push("PROVISIONING_NEON_API_KEY");
  }
  if (!plan.render.plan) missing.push("PROVISIONING_RENDER_PLAN or --render-plan");
  if (missing.length) {
    throw new ClientProvisioningError(
      `Execution is missing required provisioning configuration: ${missing.join(", ")}.`,
      { code: "PROVISIONING_CONFIG_MISSING", stage: "validation" }
    );
  }
}

function exactCollisionMessage(plan, renderMatches, neonMatches) {
  const collisions = [];
  if (renderMatches.length) collisions.push(`Render service "${plan.render.serviceName}"`);
  if (neonMatches.length) collisions.push(`Neon project "${plan.neon.projectName}"`);
  return collisions.length
    ? `${collisions.join(" and ")} already exists. Provisioning stopped before creating anything.`
    : null;
}

function neonDefaultsFromCreate(response) {
  const projectId = response?.project?.id;
  const databaseName = response?.databases?.[0]?.name;
  const roleName = response?.roles?.[0]?.name;
  if (!projectId || !databaseName || !roleName) {
    throw new ClientProvisioningError(
      "Neon created a project but did not return the project/database/role details required to build DATABASE_URL.",
      {
        code: "NEON_CREATE_RESPONSE_INCOMPLETE",
        stage: "neon_created",
        partialResources: projectId ? { neonProjectId: projectId } : null,
        retrySafe: false,
      }
    );
  }
  return { projectId, databaseName, roleName };
}

function renderDefaultsFromCreate(response) {
  const service = response?.service || response;
  const serviceId = service?.id;
  const deployId = response?.deployId || response?.deploy?.id || service?.deployId;
  const url = service?.serviceDetails?.url || service?.url || null;
  if (!serviceId || !deployId) {
    throw new ClientProvisioningError(
      "Render accepted service creation but did not return both the service ID and initial deploy ID required for verification.",
      {
        code: "RENDER_CREATE_RESPONSE_INCOMPLETE",
        stage: "render_created",
        partialResources: serviceId ? { renderServiceId: serviceId } : null,
        retrySafe: false,
      }
    );
  }
  return { serviceId, deployId, url };
}

async function provisionClient(
  input = {},
  {
    execute = false,
    env = process.env,
    renderClient = null,
    neonClient = null,
  } = {}
) {
  const plan = buildProvisioningPlan(input, env);
  if (!execute) return { mode: "plan", plan: publicPlan(plan) };
  requireExecutionConfig(plan, env);

  if (!renderClient || !neonClient) {
    throw new ClientProvisioningError("Provisioning provider clients are required for execution.", {
      code: "PROVIDER_CLIENTS_REQUIRED",
      stage: "preflight",
    });
  }

  const [renderMatches, neonMatches] = await Promise.all([
    renderClient.findServicesByExactName(plan.render.serviceName),
    neonClient.findProjectsByExactName(plan.neon.projectName),
  ]);
  const collision = exactCollisionMessage(plan, renderMatches, neonMatches);
  if (collision) {
    throw new ClientProvisioningError(collision, {
      code: "RESOURCE_NAME_COLLISION",
      stage: "preflight",
      retrySafe: true,
    });
  }

  let neonProject = null;
  try {
    const created = await neonClient.createProject({
      name: plan.neon.projectName,
      region: plan.neon.region,
    });
    const defaults = neonDefaultsFromCreate(created);
    neonProject = {
      projectId: defaults.projectId,
      projectName: plan.neon.projectName,
      databaseName: defaults.databaseName,
      roleName: defaults.roleName,
      region: plan.neon.region,
    };
    const operations = Array.isArray(created?.operations) ? created.operations : [];
    await neonClient.waitForOperations(defaults.projectId, operations);
    neonProject.connectionUri = await neonClient.getPooledConnectionUri({
      projectId: defaults.projectId,
      databaseName: defaults.databaseName,
      roleName: defaults.roleName,
    });
  } catch (err) {
    if (err instanceof ClientProvisioningError) throw err;
    if (err?.status === 409) {
      throw new ClientProvisioningError(
        `Neon reported that resource "${plan.neon.projectName}" already exists or was created by a concurrent operator.`,
        {
          code: "RESOURCE_NAME_COLLISION",
          stage: "neon_create",
          retrySafe: false,
        }
      );
    }
    throw new ClientProvisioningError(`Neon provisioning failed: ${err.message}`, {
      code: "NEON_PROVISIONING_FAILED",
      stage: neonProject ? "neon_created" : "neon_create",
      partialResources: neonProject
        ? { neonProjectId: neonProject.projectId, neonProjectName: neonProject.projectName }
        : null,
      retrySafe: !neonProject,
    });
  }

  let renderCreated;
  try {
    renderCreated = await renderClient.createWebService({
      name: plan.render.serviceName,
      ownerId: plan.render.ownerId,
      repo: plan.render.repo,
      branch: plan.render.branch,
      region: plan.render.region,
      plan: plan.render.plan,
      buildCommand: plan.render.buildCommand,
      startCommand: plan.render.startCommand,
      healthCheckPath: plan.render.healthCheckPath,
      envVars: renderEnvVars(plan, neonProject.connectionUri),
    });
  } catch (err) {
    if (err?.status === 409) {
      throw new ClientProvisioningError(
        `Render reported that service "${plan.render.serviceName}" already exists or was created by a concurrent operator.`,
        {
          code: "RESOURCE_NAME_COLLISION",
          stage: "render_create",
          partialResources: {
            neonProjectId: neonProject.projectId,
            neonProjectName: neonProject.projectName,
          },
          retrySafe: false,
        }
      );
    }
    throw new ClientProvisioningError(`Render service creation failed: ${err.message}`, {
      code: "RENDER_CREATE_FAILED",
      stage: "render_create",
      partialResources: {
        neonProjectId: neonProject.projectId,
        neonProjectName: neonProject.projectName,
      },
      retrySafe: false,
    });
  }

  let renderDefaults;
  try {
    renderDefaults = renderDefaultsFromCreate(renderCreated);
  } catch (err) {
    if (err instanceof ClientProvisioningError) {
      err.partialResources = {
        ...(err.partialResources || {}),
        neonProjectId: neonProject.projectId,
        neonProjectName: neonProject.projectName,
      };
    }
    throw err;
  }

  let liveDeploy;
  try {
    liveDeploy = await renderClient.waitForDeploy(renderDefaults.serviceId, renderDefaults.deployId);
  } catch (err) {
    throw new ClientProvisioningError(`Render initial deployment failed: ${err.message}`, {
      code: "RENDER_DEPLOY_FAILED",
      stage: "render_deploy",
      partialResources: {
        neonProjectId: neonProject.projectId,
        neonProjectName: neonProject.projectName,
        renderServiceId: renderDefaults.serviceId,
        renderServiceName: plan.render.serviceName,
        renderDeployId: renderDefaults.deployId,
      },
      retrySafe: false,
    });
  }

  return {
    mode: "executed",
    clientSlug: plan.clientSlug,
    industry: plan.industry,
    neon: {
      projectId: neonProject.projectId,
      projectName: neonProject.projectName,
      databaseName: neonProject.databaseName,
      roleName: neonProject.roleName,
      region: neonProject.region,
    },
    render: {
      serviceId: renderDefaults.serviceId,
      serviceName: plan.render.serviceName,
      url: renderDefaults.url,
      deployId: renderDefaults.deployId,
      deployStatus: liveDeploy?.status || "live",
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
  };
}

module.exports = {
  ClientProvisioningError,
  DEFAULT_BUILD_COMMAND,
  DEFAULT_HEALTH_CHECK_PATH,
  DEFAULT_NEON_REGION,
  DEFAULT_RENDER_BRANCH,
  DEFAULT_RENDER_REGION,
  DEFAULT_RENDER_REPO,
  DEFAULT_RESOURCE_PREFIX,
  RENDER_PLANS,
  RENDER_REGIONS,
  RESERVED_RUNTIME_ENV_KEYS,
  buildProvisioningPlan,
  normalizeClientSlug,
  normalizeRenderPlan,
  normalizeRuntimeEnv,
  provisionClient,
  publicPlan,
  renderEnvVars,
  requireExecutionConfig,
  requireIndustry,
  requireRenderRegion,
  resourceName,
};