const crypto = require("crypto");

const {
  buildOpsPoolConfig,
  createOpsPool,
} = require("../ops/db");
const { runOpsMigrations } = require("../ops/migrationRunner");
const { createClientRegistryRepo } = require("../ops/clientRegistryRepo");
const {
  createClientPoller,
  normalizedBaseUrl,
} = require("../ops/clientPoller");
const {
  createJsonRequester,
  redactSensitiveText,
} = require("./providerClients");

const DEFAULT_OPS_ENROLLMENT_MODE = "auto";
const OPS_ENROLLMENT_MODES = Object.freeze(["auto", "required", "off"]);
const CLIENT_TOKEN_ENV_KEY = "OPS_READINESS_TOKEN";
const REQUIRED_CONTROL_ENV_KEYS = Object.freeze([
  "PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID",
  "OPS_DATABASE_URL",
]);

class OpsRegistryEnrollmentError extends Error {
  constructor(message, {
    code = "OPS_ENROLLMENT_FAILED",
    stage = null,
    publicState = null,
    retrySafe = true,
    cause = null,
  } = {}) {
    super(message);
    this.name = "OpsRegistryEnrollmentError";
    this.code = code;
    this.stage = stage;
    this.publicState = publicState ? { ...publicState } : null;
    this.retrySafe = retrySafe;
    this.cause = cause || null;
  }
}

function normalizeOpsEnrollmentMode(value, env = process.env) {
  const mode = String(
    value || env.PROVISIONING_OPS_ENROLLMENT_MODE || DEFAULT_OPS_ENROLLMENT_MODE
  ).trim().toLowerCase();
  if (!OPS_ENROLLMENT_MODES.includes(mode)) {
    throw new OpsRegistryEnrollmentError(
      `Unsupported Ops Registry enrollment mode "${value}". Use: ${OPS_ENROLLMENT_MODES.join(", ")}.`,
      {
        code: "OPS_ENROLLMENT_MODE_UNSUPPORTED",
        stage: "validation",
        retrySafe: true,
      }
    );
  }
  return mode;
}

function defaultTokenEnvKey(clientSlug) {
  const suffix = String(clientSlug || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!suffix) {
    throw new OpsRegistryEnrollmentError("A client slug is required for Ops Registry enrollment.", {
      code: "OPS_ENROLLMENT_CLIENT_SLUG_REQUIRED",
      stage: "validation",
      retrySafe: true,
    });
  }
  return `OPS_CLIENT_TOKEN_${suffix}`;
}

function buildOpsEnrollmentPlan({
  clientSlug,
  mode,
  env = process.env,
} = {}) {
  const normalizedMode = normalizeOpsEnrollmentMode(mode, env);
  const registryServiceId = String(
    env.PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID || ""
  ).trim();
  const hasOpsDatabase = Boolean(String(env.OPS_DATABASE_URL || "").trim());
  const missing = [];
  if (!registryServiceId) missing.push("PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID");
  if (!hasOpsDatabase) missing.push("OPS_DATABASE_URL");

  let enabled = false;
  if (normalizedMode === "required") enabled = true;
  else if (normalizedMode === "auto" && missing.length === 0) enabled = true;

  return {
    mode: normalizedMode,
    enabled,
    configured: missing.length === 0,
    missing,
    tokenEnvKey: defaultTokenEnvKey(clientSlug),
    registryServiceId: registryServiceId || null,
  };
}

function requireOpsEnrollmentConfig({
  clientSlug,
  mode,
  env = process.env,
} = {}) {
  const plan = buildOpsEnrollmentPlan({ clientSlug, mode, env });
  if (plan.mode === "off") return plan;

  // Auto mode remains backwards compatible when no Ops control-plane values
  // are present. A partially configured control plane is different: failing
  // before Neon/Render creation is safer than silently creating an untracked
  // production client.
  const shouldRequireCompleteConfig = plan.mode === "required"
    || (plan.mode === "auto" && plan.missing.length < REQUIRED_CONTROL_ENV_KEYS.length);
  if (shouldRequireCompleteConfig && plan.missing.length) {
    throw new OpsRegistryEnrollmentError(
      `Ops Registry enrollment is ${plan.mode} but control-plane configuration is incomplete: ${plan.missing.join(", ")}.`,
      {
        code: "OPS_ENROLLMENT_CONFIG_MISSING",
        stage: "validation",
        retrySafe: true,
      }
    );
  }

  if (plan.enabled) {
    try {
      // Validate the dedicated Ops DB connection string before any customer
      // cloud resource is created. This function does not open a connection.
      buildOpsPoolConfig(env);
    } catch (err) {
      throw new OpsRegistryEnrollmentError(
        `Ops Registry database configuration is invalid: ${redactSensitiveText(err.message, [env.OPS_DATABASE_URL])}`,
        {
          code: "OPS_ENROLLMENT_DATABASE_CONFIG_INVALID",
          stage: "validation",
          retrySafe: true,
          cause: err,
        }
      );
    }
  }
  return plan;
}

function publicStateFromPlan(plan) {
  return {
    mode: plan.mode,
    enabled: plan.enabled,
    status: plan.enabled ? "pending" : "skipped",
    tokenEnvKey: plan.tokenEnvKey,
    registryServiceId: plan.registryServiceId,
    clientTokenConfigured: false,
    registryTokenConfigured: false,
    clientDeployId: null,
    clientDeployStatus: null,
    registryDeployId: null,
    registryDeployStatus: null,
    endpointVerified: false,
    registryRecordUpserted: false,
    verified: false,
    verifiedAt: null,
    readinessStatus: null,
    remoteCommitSha: null,
    failureCode: null,
    failureStage: null,
  };
}

function opsEnrollmentFailureState(error, fallbackState = null) {
  const source = error?.publicState || fallbackState || {};
  return {
    ...source,
    status: "failed",
    verified: false,
    failureCode: error?.code || "OPS_ENROLLMENT_FAILED",
    failureStage: error?.stage || null,
  };
}

function generateOpsReadinessToken(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32).toString("base64url");
  if (token.length < 32) {
    throw new OpsRegistryEnrollmentError("Generated Ops readiness token did not meet the minimum entropy length.", {
      code: "OPS_ENROLLMENT_TOKEN_GENERATION_FAILED",
      stage: "token_generation",
      retrySafe: true,
    });
  }
  return token;
}

function registryRecordFromProvisionedResult(result, tokenEnvKey, snapshot = null) {
  const clientSlug = String(result?.clientSlug || "").trim();
  const serviceId = String(result?.render?.serviceId || "").trim();
  const baseUrl = normalizedBaseUrl(result?.render?.url);
  if (!clientSlug || !serviceId) {
    throw new OpsRegistryEnrollmentError(
      "Provisioning result is missing the client slug or Render service ID required for Ops Registry enrollment.",
      {
        code: "OPS_ENROLLMENT_RESULT_INCOMPLETE",
        stage: "validation",
        retrySafe: true,
      }
    );
  }

  return {
    clientSlug,
    displayName: String(snapshot?.client?.businessName || clientSlug).trim(),
    baseUrl,
    industry: result?.industry || null,
    purchasedChannels: Array.isArray(result?.requiredChannels)
      ? [...result.requiredChannels]
      : [],
    tokenEnvKey,
    render: {
      serviceId,
      serviceName: result?.render?.serviceName || null,
    },
    neon: {
      projectId: result?.neon?.projectId || null,
      projectName: result?.neon?.projectName || null,
    },
    provisionedCommitSha: result?.render?.deployedCommitSha || null,
  };
}

function createRenderOpsEnrollmentApi({
  apiKey,
  fetchImpl = global.fetch,
  baseUrl = "https://api.render.com/v1/",
} = {}) {
  if (!apiKey) {
    throw new OpsRegistryEnrollmentError(
      "Ops Registry enrollment requires PROVISIONING_RENDER_API_KEY.",
      {
        code: "OPS_ENROLLMENT_RENDER_API_KEY_REQUIRED",
        stage: "validation",
        retrySafe: true,
      }
    );
  }
  const request = createJsonRequester({
    provider: "Render",
    baseUrl,
    token: apiKey,
    fetchImpl,
  });

  return {
    async setSecretEnvVar(serviceId, key, value) {
      if (!serviceId) throw new Error("Render service ID is required.");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(String(key || ""))) {
        throw new Error(`Invalid Render environment key: ${key}`);
      }
      await request(
        `services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          body: { value },
          sensitiveValues: [value],
        }
      );
    },

    async triggerDeploy(serviceId) {
      const payload = await request(
        `services/${encodeURIComponent(serviceId)}/deploys`,
        {
          method: "POST",
          body: { clearCache: "do_not_clear" },
        }
      );
      const deploy = payload?.deploy || payload || {};
      if (!deploy.id) {
        throw new Error(`Render deploy response for ${serviceId} did not include a deploy ID.`);
      }
      return deploy;
    },
  };
}

function wrapEnrollmentError(error, {
  code,
  stage,
  state,
  env,
  token,
  retrySafe = true,
} = {}) {
  if (error instanceof OpsRegistryEnrollmentError) {
    if (!error.publicState && state) error.publicState = { ...state };
    return error;
  }
  const safeMessage = redactSensitiveText(error?.message || "Ops Registry enrollment failed.", [
    token,
    env?.OPS_DATABASE_URL,
    env?.PROVISIONING_RENDER_API_KEY,
  ].filter(Boolean));
  return new OpsRegistryEnrollmentError(
    `Ops Registry enrollment failed during ${stage}: ${safeMessage}`,
    {
      code,
      stage,
      publicState: state,
      retrySafe,
      cause: error,
    }
  );
}

function preparedResult(state, token, record) {
  const prepared = { state: { ...state }, record: { ...record } };
  // The token must stay usable for the in-process deployment/verification
  // steps, but must never appear in JSON output, receipts, logs or accidental
  // object spreads.
  Object.defineProperty(prepared, "token", {
    value: token,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return prepared;
}

async function prepareOpsRegistryEnrollment({
  result,
  mode,
  env = process.env,
  fetchImpl = global.fetch,
  tokenFactory = generateOpsReadinessToken,
} = {}) {
  const plan = requireOpsEnrollmentConfig({
    clientSlug: result?.clientSlug,
    mode,
    env,
  });
  const state = publicStateFromPlan(plan);
  const record = registryRecordFromProvisionedResult(result, plan.tokenEnvKey);
  if (!plan.enabled) return preparedResult(state, null, record);

  let token;
  try {
    token = String(tokenFactory() || "").trim();
    if (token.length < 32) {
      throw new Error("token is shorter than 32 characters");
    }
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: "OPS_ENROLLMENT_TOKEN_GENERATION_FAILED",
      stage: "token_generation",
      state,
      env,
      token,
    });
  }

  const renderApi = createRenderOpsEnrollmentApi({
    apiKey: env.PROVISIONING_RENDER_API_KEY,
    fetchImpl,
  });

  try {
    await renderApi.setSecretEnvVar(
      result.render.serviceId,
      CLIENT_TOKEN_ENV_KEY,
      token
    );
    state.clientTokenConfigured = true;
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: "OPS_ENROLLMENT_CLIENT_TOKEN_CONFIG_FAILED",
      stage: "client_token_config",
      state,
      env,
      token,
      retrySafe: true,
    });
  }

  try {
    await renderApi.setSecretEnvVar(
      plan.registryServiceId,
      plan.tokenEnvKey,
      token
    );
    state.registryTokenConfigured = true;
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: "OPS_ENROLLMENT_REGISTRY_TOKEN_CONFIG_FAILED",
      stage: "registry_token_config",
      state,
      env,
      token,
      retrySafe: true,
    });
  }

  state.status = "prepared";
  return preparedResult(state, token, record);
}

function markPreparedClientDeployment(prepared, {
  deployId = null,
  deployStatus = "live",
} = {}) {
  if (!prepared?.state?.enabled) return prepared;
  prepared.state = {
    ...prepared.state,
    clientDeployId: deployId || prepared.state.clientDeployId || null,
    clientDeployStatus: String(deployStatus || "live").toLowerCase(),
  };
  return prepared;
}

async function deployServiceForEnrollment({
  prepared,
  serviceId,
  role,
  env = process.env,
  renderClient,
  fetchImpl = global.fetch,
} = {}) {
  if (!prepared?.state?.enabled) return prepared;
  if (!renderClient || typeof renderClient.waitForDeploy !== "function") {
    throw new OpsRegistryEnrollmentError(
      "Ops Registry enrollment requires the provisioning Render client to wait for deployments.",
      {
        code: "OPS_ENROLLMENT_RENDER_CLIENT_REQUIRED",
        stage: `${role}_deploy`,
        publicState: prepared?.state || null,
        retrySafe: true,
      }
    );
  }
  const renderApi = createRenderOpsEnrollmentApi({
    apiKey: env.PROVISIONING_RENDER_API_KEY,
    fetchImpl,
  });
  const state = { ...prepared.state };
  try {
    const queued = await renderApi.triggerDeploy(serviceId);
    const live = await renderClient.waitForDeploy(serviceId, queued.id);
    const status = String(live?.status || "live").toLowerCase();
    if (role === "client") {
      state.clientDeployId = queued.id;
      state.clientDeployStatus = status;
    } else {
      state.registryDeployId = queued.id;
      state.registryDeployStatus = status;
    }
    prepared.state = state;
    return prepared;
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: role === "client"
        ? "OPS_ENROLLMENT_CLIENT_DEPLOY_FAILED"
        : "OPS_ENROLLMENT_REGISTRY_DEPLOY_FAILED",
      stage: `${role}_deploy`,
      state,
      env,
      token: prepared.token,
      retrySafe: err?.ambiguous !== true,
    });
  }
}

async function deployPreparedClientToken(options = {}) {
  return deployServiceForEnrollment({
    ...options,
    serviceId: options?.result?.render?.serviceId,
    role: "client",
  });
}

async function deployPreparedRegistryToken(options = {}) {
  return deployServiceForEnrollment({
    ...options,
    serviceId: options?.prepared?.state?.registryServiceId,
    role: "registry",
  });
}

async function withOpsRepo(env, {
  createPool = createOpsPool,
  migrate = runOpsMigrations,
  createRepo = createClientRegistryRepo,
} = {}, task) {
  const pool = createPool(env);
  try {
    await migrate(pool);
    const repo = createRepo(pool);
    return await task(repo);
  } finally {
    await pool.end?.();
  }
}

async function verifyAndRegisterPreparedEnrollment({
  prepared,
  result,
  env = process.env,
  fetchImpl = global.fetch,
  createPool = createOpsPool,
  migrate = runOpsMigrations,
  createRepo = createClientRegistryRepo,
  now = () => new Date(),
} = {}) {
  if (!prepared?.state?.enabled) return { ...prepared?.state };
  const state = { ...prepared.state };
  if (!prepared.token || prepared.token.length < 32) {
    throw new OpsRegistryEnrollmentError("Prepared Ops Registry enrollment token is unavailable.", {
      code: "OPS_ENROLLMENT_PREPARED_TOKEN_MISSING",
      stage: "verification",
      publicState: state,
      retrySafe: true,
    });
  }
  if (state.clientDeployStatus !== "live") {
    throw new OpsRegistryEnrollmentError(
      "Client deployment applying OPS_READINESS_TOKEN was not confirmed live.",
      {
        code: "OPS_ENROLLMENT_CLIENT_TOKEN_NOT_APPLIED",
        stage: "verification",
        publicState: state,
        retrySafe: true,
      }
    );
  }
  if (state.registryDeployStatus !== "live") {
    throw new OpsRegistryEnrollmentError(
      "Ops Registry deployment applying the client token was not confirmed live.",
      {
        code: "OPS_ENROLLMENT_REGISTRY_TOKEN_NOT_APPLIED",
        stage: "verification",
        publicState: state,
        retrySafe: true,
      }
    );
  }

  let pollResult;
  try {
    const localTokenEnv = { [state.tokenEnvKey]: prepared.token };
    const poller = createClientPoller({ fetchImpl, env: localTokenEnv });
    pollResult = await poller.pollClient(prepared.record);
    const remoteIndustry = pollResult.snapshot?.client?.businessType || null;
    if (result?.industry && remoteIndustry && remoteIndustry !== result.industry) {
      throw new Error(
        `Client profile mismatch: expected ${result.industry}, received ${remoteIndustry}.`
      );
    }
    state.endpointVerified = true;
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: "OPS_ENROLLMENT_ENDPOINT_VERIFICATION_FAILED",
      stage: "endpoint_verification",
      state,
      env,
      token: prepared.token,
      retrySafe: true,
    });
  }

  const snapshot = pollResult.snapshot;
  const record = registryRecordFromProvisionedResult(
    result,
    state.tokenEnvKey,
    snapshot
  );
  const polledAt = now();
  try {
    await withOpsRepo(env, { createPool, migrate, createRepo }, async (repo) => {
      await repo.upsertClient(record);
      state.registryRecordUpserted = true;
      await repo.recordPollSuccess(record.clientSlug, {
        httpStatus: pollResult.httpStatus,
        snapshot,
        polledAt,
      });
    });
  } catch (err) {
    throw wrapEnrollmentError(err, {
      code: "OPS_ENROLLMENT_REGISTRY_UPSERT_FAILED",
      stage: "registry_upsert",
      state,
      env,
      token: prepared.token,
      retrySafe: true,
    });
  }

  state.status = "verified";
  state.verified = true;
  state.verifiedAt = polledAt.toISOString();
  state.readinessStatus = snapshot?.readiness?.status || null;
  state.remoteCommitSha = snapshot?.deployment?.commitSha || null;
  state.failureCode = null;
  state.failureStage = null;
  prepared.state = state;
  prepared.record = record;
  return { ...state };
}

module.exports = {
  CLIENT_TOKEN_ENV_KEY,
  DEFAULT_OPS_ENROLLMENT_MODE,
  OPS_ENROLLMENT_MODES,
  OpsRegistryEnrollmentError,
  buildOpsEnrollmentPlan,
  createRenderOpsEnrollmentApi,
  defaultTokenEnvKey,
  deployPreparedClientToken,
  deployPreparedRegistryToken,
  generateOpsReadinessToken,
  markPreparedClientDeployment,
  normalizeOpsEnrollmentMode,
  opsEnrollmentFailureState,
  prepareOpsRegistryEnrollment,
  publicStateFromPlan,
  registryRecordFromProvisionedResult,
  requireOpsEnrollmentConfig,
  verifyAndRegisterPreparedEnrollment,
  withOpsRepo,
};
