const crypto = require("crypto");
const {
  ProviderApiError,
  createJsonRequester,
} = require("./providerClients");

const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4/";
const DEFAULT_R2_LOCATION_HINT = "apac";
const R2_PROVISIONING_MODES = Object.freeze(["auto", "required", "off"]);
const R2_LOCATION_HINTS = Object.freeze(["apac", "eeur", "enam", "weur", "wnam", "oc"]);
const R2_BUCKET_ITEM_WRITE_PERMISSION = "Workers R2 Storage Bucket Item Write";
const R2_BUCKET_RESOURCE_SCOPE = "com.cloudflare.edge.r2.bucket";
const R2_JURISDICTION = "default";
const CONTROL_ACCOUNT_ID_KEY = "PROVISIONING_CLOUDFLARE_ACCOUNT_ID";
const CONTROL_API_TOKEN_KEY = "PROVISIONING_CLOUDFLARE_API_TOKEN";

class R2ProvisioningError extends Error {
  constructor(message, {
    code = "R2_PROVISIONING_ERROR",
    stage = null,
    status = null,
    ambiguous = false,
  } = {}) {
    super(message);
    this.name = "R2ProvisioningError";
    this.code = code;
    this.stage = stage;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function text(value) {
  return String(value || "").trim();
}

function normalizeR2ProvisioningMode(value, env = process.env) {
  const mode = text(value || env.PROVISIONING_R2_MODE || "auto").toLowerCase();
  if (!R2_PROVISIONING_MODES.includes(mode)) {
    throw new R2ProvisioningError(
      `Unsupported R2 provisioning mode "${value}". Use one of: ${R2_PROVISIONING_MODES.join(", ")}.`,
      { code: "R2_PROVISIONING_MODE_INVALID", stage: "validation" }
    );
  }
  return mode;
}

function normalizeR2LocationHint(value, env = process.env) {
  const hint = text(value || env.PROVISIONING_CLOUDFLARE_R2_LOCATION_HINT || DEFAULT_R2_LOCATION_HINT)
    .toLowerCase();
  if (!R2_LOCATION_HINTS.includes(hint)) {
    throw new R2ProvisioningError(
      `Unsupported Cloudflare R2 location hint "${value}". Use one of: ${R2_LOCATION_HINTS.join(", ")}.`,
      { code: "R2_LOCATION_HINT_INVALID", stage: "validation" }
    );
  }
  return hint;
}

function normalizeBucketBase(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function buildR2BucketName(resourceName) {
  const base = normalizeBucketBase(resourceName);
  if (!base) {
    throw new R2ProvisioningError("A resource name is required to derive the R2 bucket name.", {
      code: "R2_BUCKET_NAME_REQUIRED",
      stage: "validation",
    });
  }

  const suffix = "-media";
  const trimmed = base.slice(0, 63 - suffix.length).replace(/-+$/g, "");
  const name = `${trimmed}${suffix}`;
  if (name.length < 3 || name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new R2ProvisioningError(`Could not derive a valid R2 bucket name from "${resourceName}".`, {
      code: "R2_BUCKET_NAME_INVALID",
      stage: "validation",
    });
  }
  return name;
}

function buildR2TokenName(resourceName) {
  const base = normalizeBucketBase(resourceName);
  if (!base) {
    throw new R2ProvisioningError("A resource name is required to derive the R2 token name.", {
      code: "R2_TOKEN_NAME_REQUIRED",
      stage: "validation",
    });
  }
  return `${base.slice(0, 110).replace(/-+$/g, "")}-r2`;
}

function buildR2ProvisioningPlan({
  resourceName,
  mode = null,
  locationHint = null,
  env = process.env,
} = {}) {
  const normalizedMode = normalizeR2ProvisioningMode(mode, env);
  const accountId = text(env.PROVISIONING_CLOUDFLARE_ACCOUNT_ID);
  const apiToken = text(env.PROVISIONING_CLOUDFLARE_API_TOKEN);
  const configured = Boolean(accountId && apiToken);
  const partiallyConfigured = Boolean(accountId || apiToken) && !configured;
  const enabled = normalizedMode === "required" || (normalizedMode === "auto" && configured);
  const missing = [];
  if (!accountId) missing.push(CONTROL_ACCOUNT_ID_KEY);
  if (!apiToken) missing.push(CONTROL_API_TOKEN_KEY);

  return {
    mode: normalizedMode,
    enabled,
    configured,
    partiallyConfigured,
    bucketName: buildR2BucketName(resourceName),
    tokenName: buildR2TokenName(resourceName),
    locationHint: normalizeR2LocationHint(locationHint, env),
    jurisdiction: R2_JURISDICTION,
    accountId: accountId || null,
    missing,
  };
}

function publicR2ProvisioningPlan(plan) {
  return {
    mode: plan.mode,
    enabled: plan.enabled,
    configured: plan.configured,
    partiallyConfigured: plan.partiallyConfigured,
    bucketName: plan.bucketName,
    tokenName: plan.tokenName,
    locationHint: plan.locationHint,
    jurisdiction: plan.jurisdiction,
    missing: [...(plan.missing || [])],
  };
}

function requireR2ProvisioningConfig(plan) {
  if (!plan || plan.mode === "off") return plan;
  if (plan.partiallyConfigured || (plan.mode === "required" && !plan.configured)) {
    throw new R2ProvisioningError(
      `R2 provisioning is ${plan.mode === "required" ? "required" : "partially configured"}, but control-plane configuration is missing: ${(plan.missing || []).join(", ")}.`,
      { code: "R2_PROVISIONING_CONFIG_MISSING", stage: "validation" }
    );
  }
  return plan;
}

function cloudflareResult(payload, action) {
  if (!payload || payload.success === false) {
    const firstError = Array.isArray(payload?.errors) ? payload.errors.find((item) => item?.message) : null;
    throw new R2ProvisioningError(
      firstError?.message || `Cloudflare did not complete ${action}.`,
      { code: "R2_CLOUDFLARE_RESPONSE_ERROR", stage: action }
    );
  }
  return payload.result;
}

function bucketResourceId(accountId, bucketName, jurisdiction = R2_JURISDICTION) {
  return `com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction}_${bucketName}`;
}

function secretAccessKeyFromTokenValue(tokenValue) {
  const value = text(tokenValue);
  if (!value) {
    throw new R2ProvisioningError("Cloudflare did not return the one-time token value required for R2 S3 credentials.", {
      code: "R2_TOKEN_VALUE_MISSING",
      stage: "token_create",
    });
  }
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createCloudflareR2Client({
  apiToken,
  accountId,
  fetchImpl = global.fetch,
  baseUrl = DEFAULT_CLOUDFLARE_API_BASE_URL,
  timeoutMs,
} = {}) {
  const controlToken = text(apiToken);
  const normalizedAccountId = text(accountId);
  if (!controlToken) throw new Error("Cloudflare R2 provisioning requires PROVISIONING_CLOUDFLARE_API_TOKEN.");
  if (!normalizedAccountId) throw new Error("Cloudflare R2 provisioning requires PROVISIONING_CLOUDFLARE_ACCOUNT_ID.");

  const request = createJsonRequester({
    provider: "Cloudflare",
    baseUrl,
    token: controlToken,
    fetchImpl,
    timeoutMs,
  });
  const accountPath = `accounts/${encodeURIComponent(normalizedAccountId)}`;

  async function findPermissionGroup(name, scope) {
    const payload = await request(`${accountPath}/tokens/permission_groups`, {
      query: { name, scope },
    });
    const groups = cloudflareResult(payload, "permission_group_lookup");
    const list = Array.isArray(groups) ? groups : [];
    const exact = list.find((item) => (
      item?.name === name
      && (!scope || !Array.isArray(item.scopes) || item.scopes.includes(scope))
    ));
    if (!exact?.id) {
      throw new R2ProvisioningError(
        `Cloudflare permission group "${name}" was not available for scope "${scope}".`,
        { code: "R2_PERMISSION_GROUP_MISSING", stage: "permission_group_lookup" }
      );
    }
    return exact;
  }

  async function findBucketsByExactName(name) {
    try {
      const payload = await request(`${accountPath}/r2/buckets/${encodeURIComponent(name)}`);
      const bucket = cloudflareResult(payload, "bucket_lookup");
      return bucket?.name === name ? [bucket] : [];
    } catch (err) {
      if (err instanceof ProviderApiError && err.status === 404) return [];
      throw err;
    }
  }

  async function createBucket({ name, locationHint = DEFAULT_R2_LOCATION_HINT } = {}) {
    const payload = await request(`${accountPath}/r2/buckets`, {
      method: "POST",
      body: {
        name,
        locationHint,
        storageClass: "Standard",
      },
    });
    const bucket = cloudflareResult(payload, "bucket_create");
    if (!bucket?.name) {
      throw new R2ProvisioningError("Cloudflare created an R2 bucket but did not return its name.", {
        code: "R2_BUCKET_CREATE_RESPONSE_INCOMPLETE",
        stage: "bucket_create",
      });
    }
    return bucket;
  }

  async function createBucketCredentials({
    bucketName,
    tokenName,
    jurisdiction = R2_JURISDICTION,
  } = {}) {
    const permission = await findPermissionGroup(
      R2_BUCKET_ITEM_WRITE_PERMISSION,
      R2_BUCKET_RESOURCE_SCOPE
    );
    const resource = bucketResourceId(normalizedAccountId, bucketName, jurisdiction);
    const payload = await request(`${accountPath}/tokens`, {
      method: "POST",
      body: {
        name: tokenName,
        policies: [{
          effect: "allow",
          resources: { [resource]: "*" },
          permission_groups: [{ id: permission.id, name: permission.name }],
        }],
      },
    });
    const token = cloudflareResult(payload, "token_create");
    if (!token?.id) {
      throw new R2ProvisioningError("Cloudflare created an R2 token but did not return its token ID.", {
        code: "R2_TOKEN_CREATE_RESPONSE_INCOMPLETE",
        stage: "token_create",
      });
    }
    const secretAccessKey = secretAccessKeyFromTokenValue(token.value);
    return {
      tokenId: token.id,
      tokenName: token.name || tokenName,
      accessKeyId: token.id,
      secretAccessKey,
      resource,
    };
  }

  async function rollBucketCredentials(tokenId) {
    const payload = await request(
      `${accountPath}/tokens/${encodeURIComponent(tokenId)}/value`,
      { method: "PUT", body: {} }
    );
    const tokenValue = cloudflareResult(payload, "token_roll");
    const value = typeof tokenValue === "string" ? tokenValue : tokenValue?.value;
    return {
      tokenId,
      accessKeyId: tokenId,
      secretAccessKey: secretAccessKeyFromTokenValue(value),
    };
  }

  return {
    accountId: normalizedAccountId,
    createBucket,
    createBucketCredentials,
    findBucketsByExactName,
    findPermissionGroup,
    rollBucketCredentials,
  };
}

function r2RuntimeEnv({ accountId, bucketName, credentials } = {}) {
  if (!text(accountId) || !text(bucketName) || !credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new R2ProvisioningError("Complete R2 account, bucket, and S3 credentials are required to build client runtime variables.", {
      code: "R2_RUNTIME_ENV_INCOMPLETE",
      stage: "runtime_env",
    });
  }
  return {
    R2_ACCOUNT_ID: text(accountId),
    R2_ACCESS_KEY_ID: text(credentials.accessKeyId),
    R2_SECRET_ACCESS_KEY: text(credentials.secretAccessKey),
    R2_BUCKET_NAME: text(bucketName),
  };
}

module.exports = {
  CONTROL_ACCOUNT_ID_KEY,
  CONTROL_API_TOKEN_KEY,
  DEFAULT_CLOUDFLARE_API_BASE_URL,
  DEFAULT_R2_LOCATION_HINT,
  R2_BUCKET_ITEM_WRITE_PERMISSION,
  R2_BUCKET_RESOURCE_SCOPE,
  R2_JURISDICTION,
  R2_LOCATION_HINTS,
  R2_PROVISIONING_MODES,
  R2ProvisioningError,
  bucketResourceId,
  buildR2BucketName,
  buildR2ProvisioningPlan,
  buildR2TokenName,
  cloudflareResult,
  createCloudflareR2Client,
  normalizeR2LocationHint,
  normalizeR2ProvisioningMode,
  publicR2ProvisioningPlan,
  r2RuntimeEnv,
  requireR2ProvisioningConfig,
  secretAccessKeyFromTokenValue,
};
