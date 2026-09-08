const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_NEON_OPERATION_TIMEOUT_MS = 120000;
const DEFAULT_NEON_OPERATION_POLL_MS = 1500;
const DEFAULT_RENDER_DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RENDER_DEPLOY_POLL_MS = 5000;

const RENDER_DEPLOY_SUCCESS_STATUSES = new Set(["live"]);
const RENDER_DEPLOY_FAILURE_STATUSES = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "pre_deploy_failed",
  "deactivated",
]);

class ProviderApiError extends Error {
  constructor(provider, message, {
    status = null,
    method = null,
    path = null,
    ambiguous = false,
    resourceStatus = null,
  } = {}) {
    super(`${provider}: ${message}`);
    this.name = "ProviderApiError";
    this.provider = provider;
    this.status = status;
    this.method = method;
    this.path = path;
    this.ambiguous = ambiguous;
    this.resourceStatus = resourceStatus;
  }
}

function redactSensitiveText(value, sensitiveValues = []) {
  let output = String(value || "");

  const candidates = Array.from(new Set(
    sensitiveValues
      .map((item) => String(item || ""))
      .filter((item) => item.length >= 4)
  )).sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    output = output.split(candidate).join("[REDACTED]");
  }

  output = output
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");

  return output.slice(0, 500);
}

function providerErrorMessage(payload, status, sensitiveValues = []) {
  if (payload && typeof payload === "object") {
    const value = payload.message || payload.error || payload.detail || payload.code;
    if (typeof value === "string" && value.trim()) {
      return redactSensitiveText(value.trim(), sensitiveValues);
    }
    if (value && typeof value === "object") {
      const nested = value.message || value.detail || value.code;
      if (typeof nested === "string" && nested.trim()) {
        return redactSensitiveText(nested.trim(), sensitiveValues);
      }
    }
  }
  return `request failed with HTTP ${status}`;
}

function joinUrl(baseUrl, path, query = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function createJsonRequester({
  provider,
  baseUrl,
  token,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error(`${provider}: fetch is not available in this Node runtime.`);
  }

  return async function request(path, {
    method = "GET",
    query,
    body,
    sensitiveValues = [],
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = joinUrl(baseUrl, path, query);
    const upperMethod = method.toUpperCase();
    const redactions = [token, ...sensitiveValues];

    try {
      const response = await fetchImpl(url, {
        method: upperMethod,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (_) {
          payload = null;
        }
      }

      if (!response.ok) {
        throw new ProviderApiError(
          provider,
          providerErrorMessage(payload, response.status, redactions),
          {
            status: response.status,
            method: upperMethod,
            path: url.pathname,
          }
        );
      }

      return payload;
    } catch (err) {
      if (err instanceof ProviderApiError) throw err;
      const ambiguous = !["GET", "HEAD", "OPTIONS"].includes(upperMethod);
      const detail = err?.name === "AbortError"
        ? `request timed out after ${timeoutMs}ms`
        : "network request failed";
      throw new ProviderApiError(provider, detail, {
        method: upperMethod,
        path: url.pathname,
        ambiguous,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function unwrapRenderService(entry) {
  return entry?.service || entry;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRenderClient({
  apiKey,
  ownerId,
  fetchImpl,
  baseUrl = "https://api.render.com/v1/",
  timeoutMs,
  deployTimeoutMs = DEFAULT_RENDER_DEPLOY_TIMEOUT_MS,
  deployPollMs = DEFAULT_RENDER_DEPLOY_POLL_MS,
  sleep = delay,
}) {
  if (!apiKey) throw new Error("Render provisioning requires PROVISIONING_RENDER_API_KEY.");
  if (!ownerId) throw new Error("Render provisioning requires PROVISIONING_RENDER_OWNER_ID.");

  const request = createJsonRequester({
    provider: "Render",
    baseUrl,
    token: apiKey,
    fetchImpl,
    timeoutMs,
  });

  async function getDeploy(serviceId, deployId) {
    return request(
      `services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`
    );
  }

  return {
    async findServicesByExactName(name) {
      const payload = await request("services", {
        query: { name, ownerId, limit: 100 },
      });
      const entries = Array.isArray(payload) ? payload : [];
      return entries
        .map(unwrapRenderService)
        .filter((service) => service?.name === name && (!service.ownerId || service.ownerId === ownerId));
    },

    async createWebService({
      name,
      repo,
      branch,
      region,
      plan,
      buildCommand,
      startCommand,
      envVars,
      healthCheckPath = "/",
    }) {
      const payload = {
        type: "web_service",
        name,
        ownerId,
        repo,
        branch,
        autoDeploy: "yes",
        envVars,
        serviceDetails: {
          runtime: "node",
          region,
          plan,
          numInstances: 1,
          healthCheckPath,
          envSpecificDetails: {
            buildCommand,
            startCommand,
          },
        },
      };
      const sensitiveValues = (envVars || [])
        .map((entry) => entry?.value)
        .filter((value) => value !== undefined && value !== null);
      return request("services", {
        method: "POST",
        body: payload,
        sensitiveValues,
      });
    },

    getDeploy,

    async waitForDeploy(serviceId, deployId) {
      const startedAt = Date.now();
      while (true) {
        if (Date.now() - startedAt > deployTimeoutMs) {
          throw new ProviderApiError(
            "Render",
            `deploy ${deployId} did not become live within ${deployTimeoutMs}ms`,
            {
              method: "GET",
              path: `/services/${serviceId}/deploys/${deployId}`,
              resourceStatus: "timeout",
            }
          );
        }

        const deploy = await getDeploy(serviceId, deployId);
        const status = String(deploy?.status || "").trim().toLowerCase();

        if (RENDER_DEPLOY_SUCCESS_STATUSES.has(status)) return deploy;
        if (RENDER_DEPLOY_FAILURE_STATUSES.has(status)) {
          throw new ProviderApiError(
            "Render",
            `deploy ${deployId} ended with status ${status}`,
            {
              method: "GET",
              path: `/services/${serviceId}/deploys/${deployId}`,
              resourceStatus: status,
            }
          );
        }

        await sleep(deployPollMs);
      }
    },
  };
}

function unwrapNeonOperation(payload) {
  return payload?.operation || payload;
}

function createNeonClient({
  apiKey,
  orgId = null,
  fetchImpl,
  baseUrl = "https://console.neon.tech/api/v2/",
  timeoutMs,
  operationTimeoutMs = DEFAULT_NEON_OPERATION_TIMEOUT_MS,
  operationPollMs = DEFAULT_NEON_OPERATION_POLL_MS,
  sleep = delay,
}) {
  if (!apiKey) throw new Error("Neon provisioning requires PROVISIONING_NEON_API_KEY.");

  const request = createJsonRequester({
    provider: "Neon",
    baseUrl,
    token: apiKey,
    fetchImpl,
    timeoutMs,
  });

  return {
    async findProjectsByExactName(name) {
      const matches = [];
      const seenCursors = new Set();
      let cursor = null;

      do {
        const payload = await request("projects", {
          query: {
            search: name,
            limit: 400,
            org_id: orgId,
            cursor,
            timeout: 30000,
          },
        });

        const unavailable = Array.isArray(payload?.unavailable) ? payload.unavailable : [];
        if (unavailable.length) {
          throw new ProviderApiError(
            "Neon",
            "project search returned incomplete results; retry the preflight before provisioning",
            { method: "GET", path: "/projects" }
          );
        }

        const projects = Array.isArray(payload?.projects) ? payload.projects : [];
        matches.push(...projects.filter((project) => project?.name === name));

        const nextCursor = payload?.pagination?.cursor || payload?.pagination?.next || null;
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
        if (cursor) seenCursors.add(cursor);
        cursor = nextCursor;
      } while (cursor);

      return matches;
    },

    async createProject({ name, regionId }) {
      return request("projects", {
        method: "POST",
        query: { org_id: orgId },
        body: {
          project: {
            name,
            region_id: regionId,
          },
        },
      });
    },

    async waitForOperations(projectId, operations = []) {
      const ids = operations.map((operation) => operation?.id).filter(Boolean);
      if (!ids.length) return;

      const startedAt = Date.now();
      const pending = new Set(ids);
      while (pending.size) {
        if (Date.now() - startedAt > operationTimeoutMs) {
          throw new ProviderApiError(
            "Neon",
            `project ${projectId} did not finish provisioning within ${operationTimeoutMs}ms`,
            { method: "GET", path: `/projects/${projectId}/operations` }
          );
        }

        for (const operationId of Array.from(pending)) {
          const payload = await request(
            `projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`
          );
          const operation = unwrapNeonOperation(payload) || {};
          const status = String(operation.status || "").toLowerCase();
          if (["finished", "completed", "succeeded"].includes(status)) {
            pending.delete(operationId);
          } else if (["failed", "cancelled", "canceled"].includes(status)) {
            throw new ProviderApiError(
              "Neon",
              `project operation ${operationId} ended with status ${status}`,
              { method: "GET", path: `/projects/${projectId}/operations/${operationId}` }
            );
          }
        }

        if (pending.size) await sleep(operationPollMs);
      }
    },

    async getPooledConnectionUri({ projectId, databaseName, roleName }) {
      const payload = await request(`projects/${encodeURIComponent(projectId)}/connection_uri`, {
        query: {
          database_name: databaseName,
          role_name: roleName,
          pooled: true,
        },
      });
      const uri = payload?.uri;
      if (!uri || typeof uri !== "string") {
        throw new ProviderApiError("Neon", "pooled connection URI was missing from the API response", {
          method: "GET",
          path: `/projects/${projectId}/connection_uri`,
        });
      }
      return uri;
    },
  };
}

module.exports = {
  DEFAULT_NEON_OPERATION_POLL_MS,
  DEFAULT_NEON_OPERATION_TIMEOUT_MS,
  DEFAULT_RENDER_DEPLOY_POLL_MS,
  DEFAULT_RENDER_DEPLOY_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ProviderApiError,
  RENDER_DEPLOY_FAILURE_STATUSES,
  RENDER_DEPLOY_SUCCESS_STATUSES,
  createJsonRequester,
  createNeonClient,
  createRenderClient,
  redactSensitiveText,
};