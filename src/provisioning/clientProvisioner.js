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

const RESERVED_RUNTIME_ENV_KEYS = new Set([
  "DATABASE_URL",
  "SESSION_SECRET",
  "INITIAL_BUSINESS_TYPE",
  "BUSINESS_TYPE",
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
    if (RESERVED_RUNTIME_ENV_KEYS.has(key)) {
      throw new ClientProvisioningError(
        `${key} is managed by the provisioner and cannot be overridden by runtime environment input.`,
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
  const prefix = normalizeClientSlug(input.resourcePrefix || env.PROVISIONING_RESOURCE_PREFIX || DEFAULT_RESOURCE_PREFIX);
  const name = resourceName(prefix, clientSlug);
  const renderPlan = String(input.renderPlan || env.PROVISIONING_RENDER_PLAN || "").trim() || null;

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
      region: String(input.renderRegion || env.PROVISIONING_RENDER_REGION || DEFAULT_RENDER_REGION).trim(),
      plan: renderPlan,
      buildCommand: String(input.buildCommand || env.PROVISIONING_RENDER_BUILD_COMMAND || DEFAULT_BUILD_COMMAND).trim(),
      startCommand: String(input.startCommand || env.PROVISIONING_RENDER_START_COMMAND || DEFAULT_START_COMMAND).trim(),
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
  if (!String(env.PROVISIONING_RENDER_API_KEY || "").trim()) missing.push("PROVISIONING_RENDER_API_KEY");
  if (!plan.render.ownerId) missing.push("PROVISIONING_RENDER_OWNER_ID");
  if (!String(env.PROVISIONING_NEON_API_KEY || "").trim()) missing.push("PROVISIONING_NEON_API_KEY");
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
  return collisions.length ? `${collisions.join(" and ")} already exists. Provisioning stopped before creating anything.` : null;
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

async function provisionClient(input = {}, {
  execute = false,
  env = process.env,
  renderClient = null,
  neonClient = null,
} = {}) {
  const plan = buildProvisioningPlan(input, env);
  if (!execute) {
    return { mode: "plan", plan: publicPlan(plan) };
  }

  requireExecutionConfig(plan, env);
  if (!renderClient || !neonClient) {
    throw new ClientProvisioningError("Execution requires initialized Render and Neon clients.", {
      code: "PROVIDER_CLIENTS_REQUIRED",
      stage: "validation",
    });
  }

  let renderMatches;
  let neonMatches;
  try {
    [renderMatches, neonMatches] = await Promise.all([
      renderClient.findServicesByExactName(plan.render.serviceName),
      neonClient.findProjectsByExactName(plan.neon.projectName),
    ]);
  } catch (err) {
    throw new ClientProvisioningError(`Could not verify that provisioning names are unused: ${err.message}`, {
      code: "COLLISION_CHECK_FAILED",
      stage: "preflight",
      retrySafe: true,
    });
  }

  const collision = exactCollisionMessage(plan, renderMatches, neonMatches);
  if (collision) {
    throw new ClientProvisioningError(collision, {
      code: "RESOURCE_NAME_COLLISION",
      stage: "preflight",
      retrySafe: false,
    });
  }

  let neonResponse;
  try {
    neonResponse = await neonClient.createProject({
      name: plan.neon.projectName,
      regionId: plan.neon.region,
    });
  } catch (err) {
    throw new ClientProvisioningError(
      `Neon project creation failed: ${err.message}. Because create requests are non-idempotent, rerun the command only after the preflight confirms that "${plan.neon.projectName}" does not exist.`,
      {
        code: "NEON_CREATE_FAILED",
        stage: "neon_create",
        retrySafe: err?.ambiguous === true ? false : null,
      }
    );
  }

  const neon = neonDefaultsFromCreate(neonResponse);
  const partialResources = {
    neonProjectId: neon.projectId,
    neonProjectName: plan.neon.projectName,
  };

  try {
    await neonClient.waitForOperations(neon.projectId, neonResponse.operations || []);
  } catch (err) {
    throw new ClientProvisioningError(
      `Neon project was created but did not become ready: ${err.message}. The project was left intact for inspection/recovery.`,
      {
        code: "NEON_NOT_READY",
        stage: "neon_created",
        partialResources,
        retrySafe: true,
      }
    );
  }

  let databaseUrl;
  try {
    databaseUrl = await neonClient.getPooledConnectionUri({
      projectId: neon.projectId,
      databaseName: neon.databaseName,
      roleName: neon.roleName,
    });
  } catch (err) {
    throw new ClientProvisioningError(
      `Neon project was created but its pooled connection URI could not be retrieved: ${err.message}. The project was left intact for recovery.`,
      {
        code: "NEON_CONNECTION_URI_FAILED",
        stage: "neon_created",
        partialResources,
        retrySafe: true,
      }
    );
  }

  let renderResponse;
  try {
    renderResponse = await renderClient.createWebService({
      name: plan.render.serviceName,
      repo: plan.render.repo,
      branch: plan.render.branch,
      region: plan.render.region,
      plan: plan.render.plan,
      buildCommand: plan.render.buildCommand,
      startCommand: plan.render.startCommand,
      envVars: renderEnvVars(plan, databaseUrl),
    });
  } catch (err) {
    throw new ClientProvisioningError(
      `Render service creation failed after Neon project ${neon.projectId} was created: ${err.message}. Neon was not deleted automatically. Resolve the Render issue, then either complete provisioning deliberately or remove the unused Neon project manually.`,
      {
        code: "RENDER_CREATE_FAILED",
        stage: "render_create",
        partialResources,
        retrySafe: false,
      }
    );
  }

  const service = renderResponse?.service || renderResponse || {};
  return {
    mode: "executed",
    clientSlug: plan.clientSlug,
    industry: plan.industry,
    neon: {
      projectId: neon.projectId,
      projectName: plan.neon.projectName,
      region: plan.neon.region,
    },
    render: {
      serviceId: service.id || null,
      serviceName: service.name || plan.render.serviceName,
      url: service.serviceDetails?.url || service.url || null,
      deployId: renderResponse?.deployId || null,
      region: plan.render.region,
      plan: plan.render.plan,
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
  DEFAULT_NEON_REGION,
  DEFAULT_RENDER_BRANCH,
  DEFAULT_RENDER_REGION,
  DEFAULT_RENDER_REPO,
  DEFAULT_RESOURCE_PREFIX,
  DEFAULT_START_COMMAND,
  RESERVED_RUNTIME_ENV_KEYS,
  buildProvisioningPlan,
  normalizeClientSlug,
  normalizeRuntimeEnv,
  provisionClient,
  publicPlan,
  renderEnvVars,
  requireIndustry,
};
