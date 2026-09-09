const DEFAULT_TIMEOUT_MS = 8000;
const ALLOWED_READINESS = new Set([
  "ready",
  "ready_with_warnings",
  "needs_testing",
  "blocked",
]);

function normalizedBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Client base URL must use HTTP or HTTPS.");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocal) {
    throw new Error("Client readiness polling requires HTTPS outside localhost.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function tokenFromEnv(client, env = process.env) {
  const key = String(client?.tokenEnvKey || "").trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid token environment key for ${client?.clientSlug || "client"}.`);
  }
  const token = String(env[key] || "").trim();
  if (token.length < 32) {
    throw new Error(`Operations token ${key} is missing or too short.`);
  }
  return token;
}

function normalizeRemoteSnapshot(payload, expectedSlug = null) {
  if (!payload || Number(payload.schemaVersion) !== 1 || payload.source !== "da-chatbot") {
    throw new Error("Client returned an unsupported operations-readiness schema.");
  }
  if (!ALLOWED_READINESS.has(payload?.readiness?.status)) {
    throw new Error("Client returned an invalid readiness status.");
  }
  const remoteSlug = payload?.client?.slug || null;
  if (expectedSlug && remoteSlug && remoteSlug !== expectedSlug) {
    throw new Error(`Client identity mismatch: expected ${expectedSlug}, received ${remoteSlug}.`);
  }

  return {
    schemaVersion: 1,
    source: "da-chatbot",
    client: {
      slug: remoteSlug,
      businessName: payload?.client?.businessName || null,
      businessType: payload?.client?.businessType || null,
    },
    deployment: {
      commitSha: payload?.deployment?.commitSha || null,
    },
    readiness: {
      status: payload.readiness.status,
      ready: payload.readiness.ready === true,
      checkedAt: payload.readiness.checkedAt || null,
      lastTechnicalRunAt: payload.readiness.lastTechnicalRunAt || null,
      profileAlignment: payload.readiness.profileAlignment || null,
      businessSetup: payload.readiness.businessSetup || null,
      channelContract: payload.readiness.channelContract || null,
      channels: Array.isArray(payload.readiness.channels) ? payload.readiness.channels : [],
      blockers: Array.isArray(payload.readiness.blockers) ? payload.readiness.blockers : [],
      testingRequired: Array.isArray(payload.readiness.testingRequired)
        ? payload.readiness.testingRequired
        : [],
      warnings: Array.isArray(payload.readiness.warnings) ? payload.readiness.warnings : [],
      summary: payload.readiness.summary || null,
    },
  };
}

function createClientPoller({
  fetchImpl = global.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Client poller requires fetch().");

  async function pollClient(client) {
    const baseUrl = normalizedBaseUrl(client.baseUrl);
    const token = tokenFromEnv(client, env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/api/ops/readiness`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(
          new Error(`Client readiness endpoint returned HTTP ${response.status}.`),
          { httpStatus: response.status }
        );
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new Error("Client readiness endpoint returned invalid JSON.");
      }
      return {
        httpStatus: response.status,
        snapshot: normalizeRemoteSnapshot(payload, client.clientSlug),
      };
    } catch (err) {
      if (err?.name === "AbortError") {
        throw Object.assign(new Error(`Client readiness request timed out after ${timeoutMs}ms.`), {
          code: "OPS_POLL_TIMEOUT",
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { pollClient };
}

module.exports = {
  ALLOWED_READINESS,
  DEFAULT_TIMEOUT_MS,
  createClientPoller,
  normalizeRemoteSnapshot,
  normalizedBaseUrl,
  tokenFromEnv,
};
