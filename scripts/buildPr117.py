from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}")
    write(path, text.replace(old, new, 1))


write("src/db/migrations/016_ops_registry.sql", r'''CREATE TABLE IF NOT EXISTS ops_registry_clients (
  id BIGSERIAL PRIMARY KEY,
  client_slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  industry TEXT,
  purchased_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  render_service_id TEXT,
  render_service_name TEXT,
  neon_project_id TEXT,
  deployed_commit_sha TEXT,
  ops_token_encrypted TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  readiness_schema_version INTEGER,
  readiness_status TEXT,
  readiness_checked_at TIMESTAMPTZ,
  readiness_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ops_registry_clients_slug_format CHECK (client_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT ops_registry_clients_channels_array CHECK (jsonb_typeof(purchased_channels) = 'array')
);

CREATE INDEX IF NOT EXISTS ops_registry_clients_active_status_idx
  ON ops_registry_clients (is_active, readiness_status, display_name);
''')

write("src/services/opsRegistryCrypto.js", r'''const crypto = require("crypto");

const KEY_ENV = "OPS_REGISTRY_ENCRYPTION_KEY";

class OpsRegistryCryptoError extends Error {
  constructor(message, code = "OPS_REGISTRY_CRYPTO_ERROR") {
    super(message);
    this.name = "OpsRegistryCryptoError";
    this.code = code;
  }
}

function decodeKey(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    throw new OpsRegistryCryptoError(
      `${KEY_ENV} is required when the multi-client ops registry is enabled.`,
      "OPS_REGISTRY_KEY_MISSING"
    );
  }

  let key = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch (_) {
      key = null;
    }
  }

  if (!key || key.length !== 32) {
    throw new OpsRegistryCryptoError(
      `${KEY_ENV} must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.`,
      "OPS_REGISTRY_KEY_INVALID"
    );
  }
  return key;
}

function registryKey(env = process.env) {
  return decodeKey(env[KEY_ENV]);
}

function encryptOpsToken(token, env = process.env) {
  const value = String(token || "");
  if (value.length < 32) {
    throw new OpsRegistryCryptoError(
      "Client ops tokens must be at least 32 characters.",
      "OPS_READINESS_TOKEN_WEAK"
    );
  }
  const key = registryKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decryptOpsToken(payload, env = process.env) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new OpsRegistryCryptoError("Stored client ops credential has an unsupported format.", "OPS_REGISTRY_TOKEN_FORMAT_INVALID");
  }
  try {
    const key = registryKey(env);
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof OpsRegistryCryptoError) throw err;
    throw new OpsRegistryCryptoError("Stored client ops credential could not be decrypted.", "OPS_REGISTRY_TOKEN_DECRYPT_FAILED");
  }
}

module.exports = {
  KEY_ENV,
  OpsRegistryCryptoError,
  decodeKey,
  decryptOpsToken,
  encryptOpsToken,
  registryKey,
};
''')

write("src/db/opsRegistryRepo.js", r'''const { pool } = require("./db");

function toClient(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    clientSlug: row.client_slug,
    displayName: row.display_name,
    baseUrl: row.base_url,
    industry: row.industry || null,
    purchasedChannels: Array.isArray(row.purchased_channels) ? row.purchased_channels : [],
    renderServiceId: row.render_service_id || null,
    renderServiceName: row.render_service_name || null,
    neonProjectId: row.neon_project_id || null,
    deployedCommitSha: row.deployed_commit_sha || null,
    isActive: row.is_active !== false,
    lastPollAt: row.last_poll_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastHttpStatus: row.last_http_status == null ? null : Number(row.last_http_status),
    lastError: row.last_error || null,
    readinessSchemaVersion: row.readiness_schema_version == null ? null : Number(row.readiness_schema_version),
    readinessStatus: row.readiness_status || null,
    readinessCheckedAt: row.readiness_checked_at || null,
    readinessSnapshot: row.readiness_snapshot || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listClients(queryable = pool) {
  const result = await queryable.query(
    `SELECT * FROM ops_registry_clients ORDER BY is_active DESC, display_name ASC, id ASC`
  );
  return result.rows.map(toClient);
}

async function getClientById(id, queryable = pool) {
  const result = await queryable.query(`SELECT * FROM ops_registry_clients WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function saveClient(input, queryable = pool) {
  const result = await queryable.query(
    `INSERT INTO ops_registry_clients (
       client_slug, display_name, base_url, industry, purchased_channels,
       render_service_id, render_service_name, neon_project_id, deployed_commit_sha,
       ops_token_encrypted, is_active, updated_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (client_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       base_url = EXCLUDED.base_url,
       industry = EXCLUDED.industry,
       purchased_channels = EXCLUDED.purchased_channels,
       render_service_id = EXCLUDED.render_service_id,
       render_service_name = EXCLUDED.render_service_name,
       neon_project_id = EXCLUDED.neon_project_id,
       deployed_commit_sha = EXCLUDED.deployed_commit_sha,
       ops_token_encrypted = EXCLUDED.ops_token_encrypted,
       is_active = EXCLUDED.is_active,
       updated_at = NOW()
     RETURNING *`,
    [
      input.clientSlug,
      input.displayName,
      input.baseUrl,
      input.industry,
      JSON.stringify(input.purchasedChannels || []),
      input.renderServiceId,
      input.renderServiceName,
      input.neonProjectId,
      input.deployedCommitSha,
      input.opsTokenEncrypted,
      input.isActive !== false,
    ]
  );
  return toClient(result.rows[0]);
}

async function updateClient(id, input, queryable = pool) {
  const existing = await getClientById(id, queryable);
  if (!existing) return null;
  const token = input.opsTokenEncrypted || existing.ops_token_encrypted;
  const result = await queryable.query(
    `UPDATE ops_registry_clients SET
       display_name = $2,
       base_url = $3,
       industry = $4,
       purchased_channels = $5::jsonb,
       render_service_id = $6,
       render_service_name = $7,
       neon_project_id = $8,
       deployed_commit_sha = $9,
       ops_token_encrypted = $10,
       is_active = $11,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.displayName,
      input.baseUrl,
      input.industry,
      JSON.stringify(input.purchasedChannels || []),
      input.renderServiceId,
      input.renderServiceName,
      input.neonProjectId,
      input.deployedCommitSha,
      token,
      input.isActive !== false,
    ]
  );
  return toClient(result.rows[0]);
}

async function recordPollSuccess(id, snapshot, { httpStatus = 200, now = new Date() } = {}, queryable = pool) {
  const result = await queryable.query(
    `UPDATE ops_registry_clients SET
       last_poll_at = $2,
       last_success_at = $2,
       last_http_status = $3,
       last_error = NULL,
       readiness_schema_version = $4,
       readiness_status = $5,
       readiness_checked_at = $6,
       readiness_snapshot = $7::jsonb,
       deployed_commit_sha = COALESCE($8, deployed_commit_sha),
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      now,
      httpStatus,
      snapshot.schemaVersion,
      snapshot.status,
      snapshot.checkedAt || null,
      JSON.stringify(snapshot),
      snapshot.deployedCommitSha || null,
    ]
  );
  return toClient(result.rows[0]);
}

async function recordPollFailure(id, error, { httpStatus = null, now = new Date() } = {}, queryable = pool) {
  const result = await queryable.query(
    `UPDATE ops_registry_clients SET
       last_poll_at = $2,
       last_http_status = $3,
       last_error = $4,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, now, httpStatus, String(error || "Monitoring request failed.").slice(0, 500)]
  );
  return toClient(result.rows[0]);
}

module.exports = {
  getClientById,
  listClients,
  recordPollFailure,
  recordPollSuccess,
  saveClient,
  toClient,
  updateClient,
};
''')

write("src/services/goLiveGateLoaderService.js", r'''const configRepo = require("../db/configRepo");
const { evaluateClientSetup } = require("./clientSetupService");
const { evaluateGoLiveGate } = require("./goLiveGateService");
const { decorateOverview, setupStatus } = require("./setupStatusOverviewService");

async function loadGoLiveGate({ runChecks = false, baseUrl } = {}) {
  const rawOverview = runChecks
    ? await setupStatus.runAll({ requestBaseUrl: baseUrl })
    : await setupStatus.getOverview({ requestBaseUrl: baseUrl });
  const setupOverview = await decorateOverview(rawOverview);
  const config = configRepo.getConfig();
  const clientSetup = evaluateClientSetup(config);
  return evaluateGoLiveGate({ config, clientSetup, setupOverview });
}

module.exports = { loadGoLiveGate };
''')

replace_once(
    "src/routes/goLive.js",
    '''const configRepo = require("../db/configRepo");\nconst { evaluateClientSetup } = require("../services/clientSetupService");\nconst { evaluateGoLiveGate } = require("../services/goLiveGateService");\nconst {\n  decorateOverview,\n  setupStatus,\n} = require("../services/setupStatusOverviewService");''',
    '''const { loadGoLiveGate } = require("../services/goLiveGateLoaderService");'''
)

old_loader = '''async function loadGoLiveGate({ runChecks = false, baseUrl } = {}) {\n  const rawOverview = runChecks\n    ? await setupStatus.runAll({ requestBaseUrl: baseUrl })\n    : await setupStatus.getOverview({ requestBaseUrl: baseUrl });\n  const setupOverview = await decorateOverview(rawOverview);\n  const config = configRepo.getConfig();\n  const clientSetup = evaluateClientSetup(config);\n\n  return evaluateGoLiveGate({\n    config,\n    clientSetup,\n    setupOverview,\n  });\n}\n\n'''
replace_once("src/routes/goLive.js", old_loader, "")
replace_once(
    "src/routes/goLive.js",
    '''module.exports.loadGoLiveGate = loadGoLiveGate;\nmodule.exports.requestBaseUrl = requestBaseUrl;\nmodule.exports.requireAdministrator = requireAdministrator;\nmodule.exports.setupStatus = setupStatus;''',
    '''module.exports.loadGoLiveGate = loadGoLiveGate;\nmodule.exports.requestBaseUrl = requestBaseUrl;\nmodule.exports.requireAdministrator = requireAdministrator;'''
)

write("src/services/opsReadinessService.js", r'''function safeIssue(item) {
  if (!item) return null;
  return {
    key: item.key || null,
    category: item.category || null,
    severity: item.severity || null,
    channel: item.channel || null,
    channels: Array.isArray(item.channels) ? [...item.channels] : [],
    status: item.status || null,
    summary: item.summary || null,
    action: item.action || null,
    remediationRoute: item.remediationRoute || null,
  };
}

function buildOpsReadinessSnapshot(gate, env = process.env) {
  const channels = Array.isArray(gate?.channels) ? gate.channels : [];
  return {
    schemaVersion: Number(gate?.schemaVersion) || 1,
    instanceId: String(env.OPS_CLIENT_ID || "").trim() || null,
    status: gate?.status || "blocked",
    ready: gate?.ready === true,
    checkedAt: gate?.checkedAt || new Date().toISOString(),
    lastTechnicalRunAt: gate?.lastTechnicalRunAt || null,
    businessType: gate?.businessType || null,
    deployedCommitSha: String(env.RENDER_GIT_COMMIT || env.GIT_COMMIT_SHA || "").trim() || null,
    profileAlignment: {
      ready: gate?.profileAlignment?.ready === true,
      expectedIndustry: gate?.profileAlignment?.expectedIndustry || null,
      actualIndustry: gate?.profileAlignment?.actualIndustry || null,
    },
    channelContract: {
      configured: gate?.channelContract?.configured === true,
      channels: Array.isArray(gate?.channelContract?.channels) ? [...gate.channelContract.channels] : [],
    },
    system: {
      ready: gate?.system?.ready === true,
      applicationReady: Number(gate?.system?.applicationReady) || 0,
      applicationTotal: Number(gate?.system?.applicationTotal) || 0,
    },
    channels: channels.map((item) => ({
      channel: item.channel,
      ready: item.ready === true,
      verificationState: item.verificationState || null,
      configured: item.configured === true,
      runtimeReady: item.runtimeReady === true,
      latestCustomerInboundAt: item.latestCustomerInboundAt || null,
      lastVerifiedRoundTripInboundAt: item.lastVerifiedRoundTripInboundAt || null,
      lastVerifiedAutomatedReplyAt: item.lastVerifiedAutomatedReplyAt || null,
      lastReadinessDeliveryFailureAt: item.lastReadinessDeliveryFailureAt || null,
    })),
    blockers: (gate?.blockers || []).map(safeIssue).filter(Boolean),
    testingRequired: (gate?.testingRequired || []).map(safeIssue).filter(Boolean),
    warnings: (gate?.warnings || []).map(safeIssue).filter(Boolean),
    summary: {
      blockers: Number(gate?.summary?.blockers) || 0,
      testingRequired: Number(gate?.summary?.testingRequired) || 0,
      warnings: Number(gate?.summary?.warnings) || 0,
      purchasedChannels: Number(gate?.summary?.purchasedChannels) || 0,
      channelsReady: Number(gate?.summary?.channelsReady) || 0,
    },
  };
}

module.exports = { buildOpsReadinessSnapshot, safeIssue };
''')

write("src/routes/opsReadiness.js", r'''const crypto = require("crypto");
const express = require("express");
const { loadGoLiveGate } = require("../services/goLiveGateLoaderService");
const { buildOpsReadinessSnapshot } = require("../services/opsReadinessService");

function tokenMatches(actual, expected) {
  const actualHash = crypto.createHash("sha256").update(String(actual || "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function bearerToken(req) {
  const header = String(req.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function createOpsReadinessRouter({ loadGate = loadGoLiveGate, env = process.env } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    const configuredToken = String(env.OPS_READINESS_TOKEN || "");
    if (!configuredToken) {
      return res.status(404).json({ error: "Ops readiness monitoring is not enabled on this client." });
    }
    if (!tokenMatches(bearerToken(req), configuredToken)) {
      return res.status(401).json({ error: "Invalid ops readiness credential." });
    }
    try {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const gate = await loadGate({ runChecks: false, baseUrl });
      return res.json(buildOpsReadinessSnapshot(gate, env));
    } catch (err) {
      console.error("Failed to load sanitized ops readiness:", err);
      return res.status(503).json({
        error: "Readiness snapshot is temporarily unavailable.",
        code: "OPS_READINESS_UNAVAILABLE",
      });
    }
  });

  return router;
}

module.exports = createOpsReadinessRouter();
module.exports.bearerToken = bearerToken;
module.exports.createOpsReadinessRouter = createOpsReadinessRouter;
module.exports.tokenMatches = tokenMatches;
''')

write("src/services/opsRegistryService.js", r'''const {
  SUPPORTED_PURCHASED_CHANNELS,
  normalizeClientSlug,
  normalizePurchasedChannels,
} = require("../provisioning/clientProvisioner");
const { decryptOpsToken, encryptOpsToken } = require("./opsRegistryCrypto");
const defaultRepo = require("../db/opsRegistryRepo");

const VALID_STATUSES = new Set(["ready", "ready_with_warnings", "needs_testing", "blocked"]);
const POLL_TIMEOUT_MS = 8000;

class OpsRegistryError extends Error {
  constructor(message, code = "OPS_REGISTRY_ERROR", status = 400) {
    super(message);
    this.name = "OpsRegistryError";
    this.code = code;
    this.status = status;
  }
}

function registryEnabled(env = process.env) {
  return String(env.OPS_REGISTRY_ENABLED || "").trim().toLowerCase() === "true";
}

function allowedHostSuffixes(env = process.env) {
  const configured = String(env.OPS_REGISTRY_ALLOWED_HOST_SUFFIXES || "onrender.com")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean);
  return [...new Set(configured)];
}

function hostAllowed(hostname, env = process.env) {
  const host = String(hostname || "").toLowerCase();
  if (env.NODE_ENV === "test" && ["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  return allowedHostSuffixes(env).some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeBaseUrl(value, env = process.env) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch (_) {
    throw new OpsRegistryError("Client base URL must be a valid HTTPS URL.", "OPS_REGISTRY_URL_INVALID");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new OpsRegistryError("Client base URL must contain only scheme and host.", "OPS_REGISTRY_URL_INVALID");
  }
  if (url.protocol !== "https:" && !(env.NODE_ENV === "test" && url.protocol === "http:")) {
    throw new OpsRegistryError("Client base URL must use HTTPS.", "OPS_REGISTRY_HTTPS_REQUIRED");
  }
  if (!hostAllowed(url.hostname, env)) {
    throw new OpsRegistryError(
      `Client host is not allowed for ops polling. Configure OPS_REGISTRY_ALLOWED_HOST_SUFFIXES to permit trusted custom domains.`,
      "OPS_REGISTRY_HOST_NOT_ALLOWED"
    );
  }
  return `${url.protocol}//${url.host}`;
}

function optionalText(value, max = 200) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function prepareClientInput(input = {}, env = process.env, { existing = null } = {}) {
  const clientSlug = existing?.client_slug || normalizeClientSlug(input.clientSlug);
  const displayName = String(input.displayName || existing?.display_name || clientSlug).trim();
  if (!displayName || displayName.length > 120) {
    throw new OpsRegistryError("Display name is required and must be 120 characters or fewer.", "OPS_REGISTRY_DISPLAY_NAME_INVALID");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl || existing?.base_url, env);
  const purchasedChannels = normalizePurchasedChannels(
    input.purchasedChannels ?? existing?.purchased_channels ?? []
  );
  if (purchasedChannels.some((channel) => !SUPPORTED_PURCHASED_CHANNELS.includes(channel))) {
    throw new OpsRegistryError("Purchased channels contain an unsupported value.", "OPS_REGISTRY_CHANNEL_INVALID");
  }
  const token = typeof input.opsToken === "string" ? input.opsToken : "";
  const opsTokenEncrypted = token
    ? encryptOpsToken(token, env)
    : existing?.ops_token_encrypted || null;
  if (!opsTokenEncrypted) {
    throw new OpsRegistryError("An ops readiness token is required for a new client.", "OPS_READINESS_TOKEN_REQUIRED");
  }
  return {
    clientSlug,
    displayName,
    baseUrl,
    industry: optionalText(input.industry ?? existing?.industry, 80),
    purchasedChannels,
    renderServiceId: optionalText(input.renderServiceId ?? existing?.render_service_id),
    renderServiceName: optionalText(input.renderServiceName ?? existing?.render_service_name),
    neonProjectId: optionalText(input.neonProjectId ?? existing?.neon_project_id),
    deployedCommitSha: optionalText(input.deployedCommitSha ?? existing?.deployed_commit_sha, 100),
    opsTokenEncrypted,
    isActive: input.isActive === undefined ? existing?.is_active !== false : input.isActive === true,
  };
}

function publicClient(row) {
  if (!row) return null;
  const lastPollFailed = Boolean(row.last_poll_at && (!row.last_success_at || new Date(row.last_poll_at) > new Date(row.last_success_at)));
  return {
    id: Number(row.id),
    clientSlug: row.client_slug,
    displayName: row.display_name,
    baseUrl: row.base_url,
    industry: row.industry || null,
    purchasedChannels: Array.isArray(row.purchased_channels) ? row.purchased_channels : [],
    renderServiceId: row.render_service_id || null,
    renderServiceName: row.render_service_name || null,
    neonProjectId: row.neon_project_id || null,
    deployedCommitSha: row.deployed_commit_sha || null,
    isActive: row.is_active !== false,
    monitoringStatus: !row.is_active ? "disabled" : lastPollFailed ? "offline" : row.readiness_status || "not_checked",
    lastPollAt: row.last_poll_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastHttpStatus: row.last_http_status == null ? null : Number(row.last_http_status),
    lastError: row.last_error || null,
    readinessSchemaVersion: row.readiness_schema_version == null ? null : Number(row.readiness_schema_version),
    readinessStatus: row.readiness_status || null,
    readinessCheckedAt: row.readiness_checked_at || null,
    readinessSnapshot: row.readiness_snapshot || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function fleetSummary(clients) {
  const summary = { total: clients.length, ready: 0, warning: 0, testing: 0, blocked: 0, offline: 0, notChecked: 0, disabled: 0 };
  for (const client of clients) {
    const status = client.monitoringStatus;
    if (status === "ready") summary.ready += 1;
    else if (status === "ready_with_warnings") summary.warning += 1;
    else if (status === "needs_testing") summary.testing += 1;
    else if (status === "blocked") summary.blocked += 1;
    else if (status === "offline") summary.offline += 1;
    else if (status === "disabled") summary.disabled += 1;
    else summary.notChecked += 1;
  }
  return summary;
}

function validateSnapshot(snapshot) {
  if (!snapshot || Number(snapshot.schemaVersion) !== 1) {
    throw new OpsRegistryError("Client returned an unsupported readiness schema version.", "OPS_READINESS_SCHEMA_UNSUPPORTED", 502);
  }
  if (!VALID_STATUSES.has(snapshot.status)) {
    throw new OpsRegistryError("Client returned an invalid readiness status.", "OPS_READINESS_STATUS_INVALID", 502);
  }
  return snapshot;
}

function createOpsRegistryService({ repo = defaultRepo, fetchImpl = fetch, env = process.env } = {}) {
  async function list() {
    const rows = await repo.listClients();
    const clients = rows.map(publicClient);
    return { enabled: true, clients, summary: fleetSummary(clients) };
  }

  async function register(input) {
    const prepared = prepareClientInput(input, env);
    const saved = await repo.saveClient(prepared);
    return publicClient(saved);
  }

  async function update(id, input) {
    const existing = await repo.getClientById(id);
    if (!existing) throw new OpsRegistryError("Registry client was not found.", "OPS_REGISTRY_CLIENT_NOT_FOUND", 404);
    const prepared = prepareClientInput(input, env, { existing });
    const saved = await repo.updateClient(id, prepared);
    return publicClient(saved);
  }

  async function poll(id) {
    const existing = await repo.getClientById(id);
    if (!existing) throw new OpsRegistryError("Registry client was not found.", "OPS_REGISTRY_CLIENT_NOT_FOUND", 404);
    if (existing.is_active === false) return publicClient(existing);

    let httpStatus = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const token = decryptOpsToken(existing.ops_token_encrypted, env);
      const response = await fetchImpl(`${existing.base_url}/api/ops/readiness`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
      httpStatus = response.status;
      if (!response.ok) {
        throw new OpsRegistryError(`Client readiness endpoint returned HTTP ${response.status}.`, "OPS_READINESS_HTTP_ERROR", 502);
      }
      const snapshot = validateSnapshot(await response.json());
      if (snapshot.instanceId && snapshot.instanceId !== existing.client_slug) {
        throw new OpsRegistryError("Client readiness identity does not match the registry record.", "OPS_READINESS_IDENTITY_MISMATCH", 502);
      }
      return publicClient(await repo.recordPollSuccess(id, snapshot, { httpStatus }));
    } catch (err) {
      const message = err?.name === "AbortError"
        ? "Client readiness request timed out."
        : err?.message || "Client readiness request failed.";
      const row = await repo.recordPollFailure(id, message, { httpStatus });
      return publicClient(row);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollAll() {
    const rows = (await repo.listClients()).filter((row) => row.is_active !== false);
    const clients = [];
    for (let index = 0; index < rows.length; index += 4) {
      const batch = rows.slice(index, index + 4);
      clients.push(...await Promise.all(batch.map((row) => poll(row.id))));
    }
    const fresh = await list();
    return { ...fresh, polled: clients.length };
  }

  return { list, poll, pollAll, register, update };
}

module.exports = {
  OpsRegistryError,
  POLL_TIMEOUT_MS,
  allowedHostSuffixes,
  createOpsRegistryService,
  fleetSummary,
  hostAllowed,
  normalizeBaseUrl,
  prepareClientInput,
  publicClient,
  registryEnabled,
  validateSnapshot,
};
''')

write("src/routes/opsRegistry.js", r'''const express = require("express");
const {
  OpsRegistryError,
  createOpsRegistryService,
  registryEnabled,
} = require("../services/opsRegistryService");

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Only administrators can access the multi-client ops registry." });
  }
  next();
}

function createOpsRegistryRouter({ service = createOpsRegistryService(), env = process.env } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!registryEnabled(env)) {
      return res.status(404).json({ error: "Multi-client ops registry is not enabled on this deployment." });
    }
    next();
  });
  router.use(requireAdministrator);

  function handleError(res, err, fallback) {
    if (err instanceof OpsRegistryError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    console.error(fallback, err);
    return res.status(500).json({ error: fallback, code: "OPS_REGISTRY_INTERNAL_ERROR" });
  }

  router.get("/", async (_req, res) => {
    try { return res.json(await service.list()); }
    catch (err) { return handleError(res, err, "Could not load the client registry."); }
  });

  router.post("/clients", async (req, res) => {
    try { return res.status(201).json(await service.register(req.body || {})); }
    catch (err) { return handleError(res, err, "Could not register the client."); }
  });

  router.patch("/clients/:id", async (req, res) => {
    try { return res.json(await service.update(Number(req.params.id), req.body || {})); }
    catch (err) { return handleError(res, err, "Could not update the registry client."); }
  });

  router.post("/clients/:id/poll", async (req, res) => {
    try { return res.json(await service.poll(Number(req.params.id))); }
    catch (err) { return handleError(res, err, "Could not poll the registry client."); }
  });

  router.post("/poll-all", async (_req, res) => {
    try { return res.json(await service.pollAll()); }
    catch (err) { return handleError(res, err, "Could not refresh the client registry."); }
  });

  return router;
}

module.exports = createOpsRegistryRouter();
module.exports.createOpsRegistryRouter = createOpsRegistryRouter;
module.exports.requireAdministrator = requireAdministrator;
''')

replace_once(
    "src/server.js",
    '''const setupStatusRoutes = require("./routes/setupStatus");\nconst goLiveRoutes = require("./routes/goLive");''',
    '''const setupStatusRoutes = require("./routes/setupStatus");\nconst goLiveRoutes = require("./routes/goLive");\nconst opsReadinessRoutes = require("./routes/opsReadiness");\nconst opsRegistryRoutes = require("./routes/opsRegistry");'''
)
replace_once(
    "src/server.js",
    '''app.use("/api/contacts", requireAuth, contactsRoutes);\napp.use("/api/pipeline", requireAuth, pipelineRoutes);\napp.use("/api/setup-status", requireAuth, setupStatusRoutes);\napp.use("/api/go-live", requireAuth, goLiveRoutes);''',
    '''app.use("/api/ops/readiness", opsReadinessRoutes);\napp.use("/api/contacts", requireAuth, contactsRoutes);\napp.use("/api/pipeline", requireAuth, pipelineRoutes);\napp.use("/api/setup-status", requireAuth, setupStatusRoutes);\napp.use("/api/go-live", requireAuth, goLiveRoutes);\napp.use("/api/ops-registry", requireAuth, opsRegistryRoutes);'''
)

replace_once(
    "src/utils/permissions.js",
    '''    businessProfile: {\n      businessType: clinicConfig.businessType,\n      terminology: { ...(clinicConfig.terminology || {}) },\n    },''',
    '''    businessProfile: {\n      businessType: clinicConfig.businessType,\n      terminology: { ...(clinicConfig.terminology || {}) },\n      opsRegistryEnabled: String(process.env.OPS_REGISTRY_ENABLED || "").trim().toLowerCase() === "true",\n    },'''
)

write("portal-frontend/src/pages/OpsRegistry.jsx", r'''import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const STATUS = {
  ready: { label: "Ready", icon: "●" },
  ready_with_warnings: { label: "Warnings", icon: "●" },
  needs_testing: { label: "Testing", icon: "●" },
  blocked: { label: "Blocked", icon: "●" },
  offline: { label: "Offline", icon: "●" },
  not_checked: { label: "Not checked", icon: "○" },
  disabled: { label: "Disabled", icon: "○" },
};

function formatTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortSha(value) {
  return value ? String(value).slice(0, 8) : "—";
}

function StatusBadge({ value }) {
  const meta = STATUS[value] || STATUS.not_checked;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-semibold">
      <span aria-hidden="true">{meta.icon}</span>{meta.label}
    </span>
  );
}

const EMPTY_FORM = {
  clientSlug: "",
  displayName: "",
  baseUrl: "",
  industry: "",
  purchasedChannels: ["whatsapp"],
  renderServiceId: "",
  renderServiceName: "",
  neonProjectId: "",
  deployedCommitSha: "",
  opsToken: "",
};

export default function OpsRegistry() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  async function load() {
    setError("");
    try { setData(await api.getOpsRegistry()); }
    catch (err) { setError(err.message || "Could not load the client registry."); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const selected = useMemo(
    () => data?.clients?.find((item) => item.id === selectedId) || null,
    [data, selectedId]
  );

  async function refreshAll() {
    setRefreshing(true);
    setError("");
    try { setData(await api.pollAllOpsClients()); }
    catch (err) { setError(err.message || "Could not refresh clients."); }
    finally { setRefreshing(false); }
  }

  async function pollOne(id) {
    setRefreshing(true);
    setError("");
    try {
      await api.pollOpsClient(id);
      await load();
    } catch (err) { setError(err.message || "Could not poll client."); }
    finally { setRefreshing(false); }
  }

  function toggleChannel(channel) {
    setForm((current) => ({
      ...current,
      purchasedChannels: current.purchasedChannels.includes(channel)
        ? current.purchasedChannels.filter((item) => item !== channel)
        : [...current.purchasedChannels, channel],
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.registerOpsClient(form);
      setForm(EMPTY_FORM);
      setShowAdd(false);
      await load();
    } catch (err) { setError(err.message || "Could not register client."); }
    finally { setSaving(false); }
  }

  if (loading) {
    return <div className="p-6 text-sm text-[var(--color-text-muted)]">Loading client registry…</div>;
  }

  const summary = data?.summary || {};
  const cards = [
    ["Clients", summary.total || 0],
    ["Ready", (summary.ready || 0) + (summary.warning || 0)],
    ["Testing", summary.testing || 0],
    ["Blocked", summary.blocked || 0],
    ["Offline", summary.offline || 0],
  ];

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--color-text-muted)]">DA Operations</p>
            <h1 className="mt-1 font-display text-2xl font-bold">Multi-Client Ops Registry</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-text-muted)]">
              Read-only fleet monitoring for client deployments. This registry stores deployment metadata and encrypted monitoring credentials only; it does not fetch conversations, contacts or customer data.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowAdd((value) => !value)} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold">
              {showAdd ? "Cancel" : "Add client"}
            </button>
            <button type="button" onClick={refreshAll} disabled={refreshing} className="rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
              {refreshing ? "Refreshing…" : "Refresh all"}
            </button>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">{error}</div>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {cards.map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
              <p className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</p>
              <p className="mt-1 font-display text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {showAdd && (
          <form onSubmit={submit} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
            <div className="mb-4">
              <h2 className="font-display text-lg font-bold">Register client deployment</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">The ops token is encrypted before database storage and is never shown again.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["clientSlug", "Client slug", "acme-renovation"],
                ["displayName", "Display name", "Acme Renovation"],
                ["baseUrl", "Client URL", "https://da-chatbot-acme.onrender.com"],
                ["industry", "Industry", "home_renovation"],
                ["renderServiceId", "Render service ID", "Optional"],
                ["neonProjectId", "Neon project ID", "Optional"],
                ["deployedCommitSha", "Known deployed commit", "Optional"],
                ["opsToken", "Ops readiness token", "At least 32 characters"],
              ].map(([key, label, placeholder]) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
                  <input
                    type={key === "opsToken" ? "password" : "text"}
                    value={form[key]}
                    onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                    placeholder={placeholder}
                    required={["clientSlug", "displayName", "baseUrl", "opsToken"].includes(key)}
                    className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20"
                  />
                </label>
              ))}
            </div>
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">Purchased channels</p>
              <div className="flex flex-wrap gap-2">
                {["whatsapp", "facebook", "instagram"].map((channel) => (
                  <label key={channel} className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm">
                    <input type="checkbox" checked={form.purchasedChannels.includes(channel)} onChange={() => toggleChannel(channel)} />
                    {channel === "facebook" ? "Messenger" : channel[0].toUpperCase() + channel.slice(1)}
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" disabled={saving} className="mt-5 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? "Saving…" : "Register client"}
            </button>
          </form>
        )}

        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg)] text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="px-4 py-3 font-semibold">Industry</th>
                  <th className="px-4 py-3 font-semibold">Channels</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last seen</th>
                  <th className="px-4 py-3 font-semibold">Commit</th>
                  <th className="px-4 py-3 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {(data?.clients || []).map((client) => (
                  <tr key={client.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => setSelectedId(client.id === selectedId ? null : client.id)} className="text-left font-semibold hover:underline">
                        {client.displayName}
                      </button>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{client.clientSlug}</p>
                    </td>
                    <td className="px-4 py-3">{client.industry || "—"}</td>
                    <td className="px-4 py-3">{(client.purchasedChannels || []).join(", ") || "—"}</td>
                    <td className="px-4 py-3"><StatusBadge value={client.monitoringStatus} /></td>
                    <td className="px-4 py-3 text-xs">{formatTime(client.lastSuccessAt)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{shortSha(client.deployedCommitSha)}</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => pollOne(client.id)} disabled={refreshing || !client.isActive} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Check</button>
                    </td>
                  </tr>
                ))}
                {!data?.clients?.length && (
                  <tr><td colSpan="7" className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">No client deployments registered yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold">{selected.displayName}</h2>
                <p className="mt-1 break-all text-xs text-[var(--color-text-muted)]">{selected.baseUrl}</p>
              </div>
              <StatusBadge value={selected.monitoringStatus} />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-xs text-[var(--color-text-muted)]">Last poll</p><p className="mt-1 text-sm font-semibold">{formatTime(selected.lastPollAt)}</p></div>
              <div><p className="text-xs text-[var(--color-text-muted)]">Last successful contact</p><p className="mt-1 text-sm font-semibold">{formatTime(selected.lastSuccessAt)}</p></div>
              <div><p className="text-xs text-[var(--color-text-muted)]">Readiness checked</p><p className="mt-1 text-sm font-semibold">{formatTime(selected.readinessCheckedAt)}</p></div>
              <div><p className="text-xs text-[var(--color-text-muted)]">Deployment commit</p><p className="mt-1 font-mono text-sm font-semibold">{shortSha(selected.deployedCommitSha)}</p></div>
            </div>
            {selected.lastError && <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">{selected.lastError}</div>}
            {selected.readinessSnapshot?.blockers?.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Current blockers</p>
                <div className="mt-2 space-y-2">
                  {selected.readinessSnapshot.blockers.map((item, index) => (
                    <div key={`${item.key}-${index}`} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                      <p className="text-sm font-semibold">{item.summary}</p>
                      {item.action && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{item.action}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
''')

replace_once(
    "portal-frontend/src/api.js",
    '''  getGoLiveGate: () => request("/go-live"),\n  runGoLiveGate: () => request("/go-live/run", { method: "POST" }),''',
    '''  getGoLiveGate: () => request("/go-live"),\n  runGoLiveGate: () => request("/go-live/run", { method: "POST" }),\n  getOpsRegistry: () => request("/ops-registry"),\n  registerOpsClient: (data) => request("/ops-registry/clients", { method: "POST", body: JSON.stringify(data) }),\n  updateOpsClient: (id, data) => request(`/ops-registry/clients/${id}`, { method: "PATCH", body: JSON.stringify(data) }),\n  pollOpsClient: (id) => request(`/ops-registry/clients/${id}/poll`, { method: "POST" }),\n  pollAllOpsClients: () => request("/ops-registry/poll-all", { method: "POST" }),'''
)

replace_once(
    "portal-frontend/src/App.jsx",
    '''import GoLive from "./pages/GoLive";\nimport ClientSetupWizard from "./pages/ClientSetupWizard";''',
    '''import GoLive from "./pages/GoLive";\nimport OpsRegistry from "./pages/OpsRegistry";\nimport ClientSetupWizard from "./pages/ClientSetupWizard";'''
)
replace_once(
    "portal-frontend/src/App.jsx",
    '''            <Route\n              path="/settings/setup"\n              element={(\n                <ProtectedRoute adminOnly>\n                  <SettingsSectionLayout><SetupStatus /></SettingsSectionLayout>\n                </ProtectedRoute>\n              )}\n            />''',
    '''            <Route\n              path="/settings/setup"\n              element={(\n                <ProtectedRoute adminOnly>\n                  <SettingsSectionLayout><SetupStatus /></SettingsSectionLayout>\n                </ProtectedRoute>\n              )}\n            />\n            <Route\n              path="/settings/ops-registry"\n              element={(\n                <ProtectedRoute adminOnly>\n                  <SettingsSectionLayout><OpsRegistry /></SettingsSectionLayout>\n                </ProtectedRoute>\n              )}\n            />'''
)

replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''  const isGoLive = location.pathname === "/settings/go-live";\n  const isSetup = location.pathname === "/settings/setup";''',
    '''  const isGoLive = location.pathname === "/settings/go-live";\n  const isSetup = location.pathname === "/settings/setup";\n  const isOpsRegistry = location.pathname === "/settings/ops-registry";'''
)
replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''      : isGoLive\n        ? "goLive"\n        : isSetup\n          ? "setup"\n          : "general";''',
    '''      : isGoLive\n        ? "goLive"\n        : isSetup\n          ? "setup"\n          : isOpsRegistry\n            ? "opsRegistry"\n            : "general";'''
)
replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''  const setupItem = user?.role === "admin"\n    ? { id: "setup", to: "/settings/setup", label: "Setup Status" }\n    : null;\n  const destinationItems = [teamItem, clientSetupItem, goLiveItem, setupItem].filter(Boolean);''',
    '''  const setupItem = user?.role === "admin"\n    ? { id: "setup", to: "/settings/setup", label: "Setup Status" }\n    : null;\n  const opsRegistryItem = user?.role === "admin" && config?.opsRegistryEnabled === true\n    ? { id: "opsRegistry", to: "/settings/ops-registry", label: "Client Registry" }\n    : null;\n  const destinationItems = [teamItem, clientSetupItem, goLiveItem, setupItem, opsRegistryItem].filter(Boolean);'''
)
replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''          {(clientSetupItem || goLiveItem || setupItem) && (''',
    '''          {(clientSetupItem || goLiveItem || setupItem || opsRegistryItem) && ('''
)
replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''                {setupItem && <SettingsNavLink item={setupItem} />}\n              </div>''',
    '''                {setupItem && <SettingsNavLink item={setupItem} />}\n                {opsRegistryItem && <SettingsNavLink item={opsRegistryItem} />}\n              </div>'''
)
replace_once(
    "portal-frontend/src/components/SettingsSectionLayout.jsx",
    '''              {setupItem && <option value={setupItem.id}>{setupItem.label}</option>}\n            </select>''',
    '''              {setupItem && <option value={setupItem.id}>{setupItem.label}</option>}\n              {opsRegistryItem && <option value={opsRegistryItem.id}>{opsRegistryItem.label}</option>}\n            </select>'''
)

write("test/opsRegistryCrypto.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { decryptOpsToken, encryptOpsToken } = require("../src/services/opsRegistryCrypto");

const env = { OPS_REGISTRY_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") };

test("ops registry encrypts client tokens at rest and decrypts them only for polling", () => {
  const token = "client-ops-token-abcdefghijklmnopqrstuvwxyz-123456";
  const encrypted = encryptOpsToken(token, env);
  assert.match(encrypted, /^v1:/);
  assert.doesNotMatch(encrypted, /client-ops-token/);
  assert.equal(decryptOpsToken(encrypted, env), token);
});

test("ops registry rejects invalid encryption keys and weak client tokens", () => {
  assert.throws(() => encryptOpsToken("short", env), /at least 32/i);
  assert.throws(
    () => encryptOpsToken("a".repeat(40), { OPS_REGISTRY_ENCRYPTION_KEY: "bad-key" }),
    /32 bytes/i
  );
});
''')

write("test/opsReadinessRoute.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createOpsReadinessRouter } = require("../src/routes/opsReadiness");

async function withServer(env, loadGate, callback) {
  const app = express();
  app.use("/api/ops/readiness", createOpsReadinessRouter({ env, loadGate }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const gate = {
  schemaVersion: 1,
  status: "ready",
  ready: true,
  checkedAt: "2026-09-10T00:00:00.000Z",
  businessType: "home_renovation",
  profileAlignment: { ready: true, expectedIndustry: "home_renovation", actualIndustry: "home_renovation" },
  channelContract: { configured: true, channels: ["whatsapp"] },
  system: { ready: true, applicationReady: 5, applicationTotal: 5, health: { secretInternalDetail: "do-not-expose" } },
  channels: [{ channel: "whatsapp", ready: true, verificationState: "ready", configured: true, runtimeReady: true }],
  blockers: [], testingRequired: [], warnings: [],
  summary: { blockers: 0, testingRequired: 0, warnings: 0, purchasedChannels: 1, channelsReady: 1 },
};

test("client ops readiness endpoint is disabled unless a token is configured", async () => {
  await withServer({}, async () => gate, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ops/readiness`);
    assert.equal(response.status, 404);
  });
});

test("client ops readiness requires the per-client bearer token and returns only sanitized readiness", async () => {
  const env = { OPS_READINESS_TOKEN: "x".repeat(40), OPS_CLIENT_ID: "acme-renovation", RENDER_GIT_COMMIT: "abc123" };
  await withServer(env, async () => gate, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/ops/readiness`)).status, 401);
    const response = await fetch(`${baseUrl}/api/ops/readiness`, {
      headers: { Authorization: `Bearer ${env.OPS_READINESS_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.instanceId, "acme-renovation");
    assert.equal(body.deployedCommitSha, "abc123");
    assert.equal(body.status, "ready");
    assert.equal(body.system.health, undefined);
    assert.equal(body.businessName, undefined);
  });
});
''')

write("test/opsRegistryService.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  createOpsRegistryService,
  fleetSummary,
  normalizeBaseUrl,
} = require("../src/services/opsRegistryService");
const { encryptOpsToken } = require("../src/services/opsRegistryCrypto");

const env = {
  NODE_ENV: "test",
  OPS_REGISTRY_ENABLED: "true",
  OPS_REGISTRY_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
};

test("registry only permits trusted HTTPS hosts outside tests", () => {
  assert.equal(normalizeBaseUrl("https://client-a.onrender.com/", {}), "https://client-a.onrender.com");
  assert.throws(() => normalizeBaseUrl("http://client-a.onrender.com", {}), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://127.0.0.1", {}), /not allowed/);
  assert.throws(() => normalizeBaseUrl("https://example.com/private", {}), /scheme and host/);
  assert.equal(
    normalizeBaseUrl("https://chat.example.com", { OPS_REGISTRY_ALLOWED_HOST_SUFFIXES: "example.com" }),
    "https://chat.example.com"
  );
});

test("fleet summary keeps offline separate from chatbot readiness", () => {
  assert.deepEqual(fleetSummary([
    { monitoringStatus: "ready" },
    { monitoringStatus: "ready_with_warnings" },
    { monitoringStatus: "needs_testing" },
    { monitoringStatus: "blocked" },
    { monitoringStatus: "offline" },
  ]), { total: 5, ready: 1, warning: 1, testing: 1, blocked: 1, offline: 1, notChecked: 0, disabled: 0 });
});

test("polling uses bearer auth, refuses redirects and stores a sanitized v1 snapshot", async () => {
  const token = "ops-token-abcdefghijklmnopqrstuvwxyz-123456789";
  const row = {
    id: 1, client_slug: "acme", display_name: "Acme", base_url: "http://127.0.0.1:9999",
    purchased_channels: ["whatsapp"], ops_token_encrypted: encryptOpsToken(token, env), is_active: true,
  };
  let request = null;
  let saved = null;
  const repo = {
    getClientById: async () => row,
    listClients: async () => [row],
    recordPollSuccess: async (_id, snapshot) => {
      saved = snapshot;
      return { ...row, last_poll_at: new Date(), last_success_at: new Date(), readiness_status: snapshot.status, readiness_snapshot: snapshot };
    },
    recordPollFailure: async () => { throw new Error("should not fail"); },
  };
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ schemaVersion: 1, instanceId: "acme", status: "ready", ready: true, checkedAt: "2026-09-10T00:00:00Z" }),
    };
  };
  const service = createOpsRegistryService({ repo, fetchImpl, env });
  const result = await service.poll(1);
  assert.equal(result.monitoringStatus, "ready");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(saved.schemaVersion, 1);
});
''')

write("test/opsRegistryRouteBehavior.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createOpsRegistryRouter } = require("../src/routes/opsRegistry");

async function withServer(role, env, service, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = role ? { role } : null; next(); });
  app.use("/api/ops-registry", createOpsRegistryRouter({ service, env }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const service = {
  list: async () => ({ enabled: true, clients: [], summary: { total: 0 } }),
  register: async (body) => ({ id: 1, clientSlug: body.clientSlug }),
  update: async () => ({ id: 1 }),
  poll: async () => ({ id: 1, monitoringStatus: "ready" }),
  pollAll: async () => ({ enabled: true, clients: [], summary: { total: 0 }, polled: 0 }),
};

test("ops registry stays hidden on ordinary client deployments", async () => {
  await withServer("admin", {}, service, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/ops-registry`)).status, 404);
  });
});

test("enabled ops registry is administrator-only", async () => {
  const env = { OPS_REGISTRY_ENABLED: "true" };
  await withServer("sales", env, service, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/ops-registry`)).status, 403);
  });
  await withServer("admin", env, service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ops-registry`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, true);
  });
});
''')

write("test/opsRegistryArchitecture.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

function source(path) { return fs.readFileSync(path, "utf8"); }

test("ops registry is isolated from customer messaging and hidden unless enabled", () => {
  const server = source("src/server.js");
  const permissions = source("src/utils/permissions.js");
  const layout = source("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const page = source("portal-frontend/src/pages/OpsRegistry.jsx");
  const readiness = source("src/routes/opsReadiness.js");
  const registry = source("src/routes/opsRegistry.js");

  assert.match(server, /app\.use\("\/api\/ops\/readiness", opsReadinessRoutes\)/);
  assert.match(server, /app\.use\("\/api\/ops-registry", requireAuth, opsRegistryRoutes\)/);
  assert.match(permissions, /opsRegistryEnabled/);
  assert.match(layout, /config\?\.opsRegistryEnabled === true/);
  assert.match(page, /Read-only fleet monitoring/);
  assert.match(readiness, /OPS_READINESS_TOKEN/);
  assert.match(registry, /registryEnabled/);
  assert.doesNotMatch(registry, /sendMessage|sendMedia|sendVoice|takeOver|returnToAi/);
});

test("registry database stores monitoring metadata and encrypted token, not customer records", () => {
  const migration = source("src/db/migrations/016_ops_registry.sql");
  assert.match(migration, /ops_token_encrypted TEXT NOT NULL/);
  assert.doesNotMatch(migration, /phone|conversation|message_body|contact_id/);
});
''')

# Add a small static check that the extracted loader remains the shared source of truth.
write("test/goLiveGateLoader.test.js", r'''const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("Go Live UI and ops readiness share one gate loader", () => {
  const route = fs.readFileSync("src/routes/goLive.js", "utf8");
  const ops = fs.readFileSync("src/routes/opsReadiness.js", "utf8");
  assert.match(route, /goLiveGateLoaderService/);
  assert.match(ops, /goLiveGateLoaderService/);
});
''')
