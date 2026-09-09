const {
  normalizeBusinessType,
} = require("../config/industryProfiles");

const DEFAULT_READINESS_TIMEOUT_MS = 60000;
const SUPPORTED_CHANNELS = Object.freeze(["whatsapp", "facebook", "instagram"]);
const CHANNEL_ALIASES = Object.freeze({
  wa: "whatsapp",
  whatsapp: "whatsapp",
  fb: "facebook",
  facebook: "facebook",
  messenger: "facebook",
  facebook_messenger: "facebook",
  ig: "instagram",
  instagram: "instagram",
});
const CHANNEL_CHECK_KEYS = Object.freeze({
  whatsapp: ["whatsapp", "whatsapp_webhook"],
  facebook: ["facebook", "meta_webhook"],
  instagram: ["instagram", "meta_webhook"],
});
const CHANNEL_RUNTIME_ENV_KEYS = Object.freeze({
  whatsapp: [
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
  ],
  facebook: [
    "FACEBOOK_PAGE_ID",
    "FACEBOOK_PAGE_ACCESS_TOKEN",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
  ],
  instagram: [
    "INSTAGRAM_PAGE_ID",
    "INSTAGRAM_PAGE_ACCESS_TOKEN",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
  ],
});
const REQUIRED_CORE_CHECK_KEYS = Object.freeze([
  "database",
  "security",
  "public_url",
  "admin_account",
  "ai",
  "r2",
]);
const ALL_CHANNEL_CHECK_KEYS = new Set(Object.values(CHANNEL_CHECK_KEYS).flat());

class ClientReadinessError extends Error {
  constructor(message, {
    code = "CLIENT_READINESS_ERROR",
    stage = null,
    status = null,
  } = {}) {
    super(message);
    this.name = "ClientReadinessError";
    this.code = code;
    this.stage = stage;
    this.status = status;
  }
}

function text(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  const raw = text(value);
  if (!raw) {
    throw new ClientReadinessError("A client portal URL is required for readiness verification.", {
      code: "READINESS_URL_REQUIRED",
      stage: "validation",
    });
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new ClientReadinessError(`Invalid client portal URL "${raw}".`, {
      code: "READINESS_URL_INVALID",
      stage: "validation",
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ClientReadinessError("Client portal URL must use http or https.", {
      code: "READINESS_URL_INVALID",
      stage: "validation",
    });
  }
  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHost) {
    throw new ClientReadinessError(
      "Readiness verification refuses to send administrator credentials over non-HTTPS remote URLs.",
      { code: "READINESS_HTTPS_REQUIRED", stage: "validation" }
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeRequiredChannels(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const channels = [];
  for (const item of raw) {
    const key = text(item).toLowerCase().replace(/[\s-]+/g, "_");
    if (!key) continue;
    const normalized = CHANNEL_ALIASES[key];
    if (!normalized) {
      throw new ClientReadinessError(
        `Unsupported messaging channel "${item}". Use one or more of: ${SUPPORTED_CHANNELS.join(", ")}.`,
        { code: "READINESS_CHANNEL_UNSUPPORTED", stage: "validation" }
      );
    }
    if (!channels.includes(normalized)) channels.push(normalized);
  }
  if (!channels.length) {
    throw new ClientReadinessError(
      `At least one required messaging channel is needed. Use one or more of: ${SUPPORTED_CHANNELS.join(", ")}.`,
      { code: "READINESS_CHANNELS_REQUIRED", stage: "validation" }
    );
  }
  return channels;
}

function normalizeExpectedIndustry(value) {
  const normalized = normalizeBusinessType(value);
  if (!normalized) {
    throw new ClientReadinessError(`Unsupported expected business profile "${value || ""}".`, {
      code: "READINESS_INDUSTRY_UNSUPPORTED",
      stage: "validation",
    });
  }
  return normalized;
}

function requireCredentials(username, password) {
  const normalizedUsername = text(username);
  if (!normalizedUsername || typeof password !== "string" || !password) {
    throw new ClientReadinessError(
      "Administrator username and password are required for readiness verification.",
      { code: "READINESS_ADMIN_CREDENTIALS_REQUIRED", stage: "validation" }
    );
  }
  return { username: normalizedUsername, password };
}

function hasGeminiCredential(env) {
  return Object.entries(env || {}).some(([key, value]) => {
    if (!text(value)) return false;
    return key === "GEMINI_API_KEYS" || key === "GEMINI_API_KEY" || /^GEMINI_API_KEY_\d+$/.test(key);
  });
}

function validateRuntimeReadinessContract(runtimeEnv = {}, requiredChannels = []) {
  const channels = normalizeRequiredChannels(requiredChannels);
  const missing = [];
  const requireKey = (key) => {
    if (!text(runtimeEnv[key]) && !missing.includes(key)) missing.push(key);
  };

  requireKey("ADMIN_USERNAME");
  requireKey("ADMIN_PASSWORD");

  if (!hasGeminiCredential(runtimeEnv) && !text(runtimeEnv.ANTHROPIC_API_KEY)) {
    missing.push("GEMINI_API_KEYS/GEMINI_API_KEY_* or ANTHROPIC_API_KEY");
  }

  for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
    requireKey(key);
  }

  for (const channel of channels) {
    for (const key of CHANNEL_RUNTIME_ENV_KEYS[channel]) requireKey(key);
  }

  if (missing.length) {
    throw new ClientReadinessError(
      `Client runtime configuration is missing required readiness values: ${missing.join(", ")}.`,
      { code: "READINESS_RUNTIME_CONFIG_MISSING", stage: "validation" }
    );
  }

  return { channels, missing: [] };
}

function extractSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie().filter(Boolean);
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    if (Array.isArray(raw?.["set-cookie"])) return raw["set-cookie"];
  }
  const combined = typeof headers.get === "function" ? headers.get("set-cookie") : null;
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,\s]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function cookieHeaderFromResponse(response) {
  return extractSetCookieHeaders(response?.headers)
    .map((header) => String(header).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

async function requestJson(url, {
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  method = "GET",
  body,
  cookie,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ClientReadinessError("fetch is not available in this Node runtime.", {
      code: "READINESS_FETCH_UNAVAILABLE",
      stage: "validation",
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new ClientReadinessError(`Readiness request timed out after ${timeoutMs}ms.`, {
        code: "READINESS_REQUEST_TIMEOUT",
        stage: "request",
      });
    }
    throw new ClientReadinessError("Could not reach the client portal for readiness verification.", {
      code: "READINESS_REQUEST_FAILED",
      stage: "request",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function authenticateClient({
  baseUrl,
  username,
  password,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  const url = normalizeBaseUrl(baseUrl);
  const credentials = requireCredentials(username, password);
  const loginResponse = await requestJson(`${url}/api/auth/login`, {
    fetchImpl,
    timeoutMs,
    method: "POST",
    body: credentials,
  });
  await readJson(loginResponse);
  if (!loginResponse.ok) {
    throw new ClientReadinessError(
      loginResponse.status === 401
        ? "Administrator login failed during readiness verification."
        : `Administrator login could not be completed (HTTP ${loginResponse.status}).`,
      {
        code: loginResponse.status === 401 ? "READINESS_LOGIN_REJECTED" : "READINESS_LOGIN_FAILED",
        stage: "login",
        status: loginResponse.status,
      }
    );
  }
  const cookie = cookieHeaderFromResponse(loginResponse);
  if (!cookie) {
    throw new ClientReadinessError("Login succeeded but no authenticated session cookie was returned.", {
      code: "READINESS_SESSION_MISSING",
      stage: "login",
    });
  }
  return { url, cookie };
}

async function logoutClient({ url, cookie, fetchImpl, timeoutMs }) {
  try {
    await requestJson(`${url}/api/auth/logout`, {
      fetchImpl,
      timeoutMs,
      method: "POST",
      cookie,
    });
  } catch (_) {
    // Best effort only. The cookie is local to this process and discarded anyway.
  }
}

async function verifyAdminLogin(options = {}) {
  const session = await authenticateClient(options);
  await logoutClient({
    ...session,
    fetchImpl: options.fetchImpl || global.fetch,
    timeoutMs: options.timeoutMs || DEFAULT_READINESS_TIMEOUT_MS,
  });
  return { authenticated: true };
}

function readinessItem(check, { required = true } = {}) {
  return {
    key: check?.key || null,
    label: check?.label || check?.key || "Unknown check",
    required,
    configured: check?.configured === true,
    status: check?.status || "missing",
    summary: check?.summary || "Check result was not returned.",
    checkedAt: check?.checkedAt || null,
    lastSuccessAt: check?.lastSuccessAt || null,
    lastWebhookAt: check?.lastWebhookAt || null,
    lastActivityAt: check?.lastActivityAt || null,
  };
}

function evaluateBusinessProfile(profile, expectedIndustry) {
  const expected = normalizeExpectedIndustry(expectedIndustry);
  const actual = normalizeBusinessType(profile?.businessType) || null;
  const alignment = profile?.alignment || {};
  const reasons = [];
  if (actual !== expected) reasons.push(`Expected ${expected}, but deployment reports ${actual || "unknown"}.`);
  if (profile?.selection?.locked !== true) reasons.push("Business profile is not locked yet.");
  if (alignment.pipeline?.businessType !== expected) reasons.push("Pipeline profile is not aligned.");
  if (alignment.conversion?.businessType !== expected) reasons.push("Conversion profile is not aligned.");
  if (alignment.leadTemperature?.businessType !== expected) reasons.push("Lead-temperature rules are not aligned.");
  if (alignment.analytics?.businessType !== expected || alignment.analytics?.fallback === true) {
    reasons.push("Analytics profile is not aligned.");
  }
  return {
    key: "business_profile",
    label: "Business profile",
    status: reasons.length ? "error" : "ready",
    expectedIndustry: expected,
    actualIndustry: actual,
    locked: profile?.selection?.locked === true,
    summary: reasons.length ? reasons.join(" ") : `Business profile is locked and aligned as ${expected}.`,
  };
}

function missingRequiredCheck(key) {
  return {
    key,
    label: key,
    status: "missing",
    configured: false,
    summary: `Required Setup Status check "${key}" was not returned.`,
  };
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluateSystemHealth(systemHealth, requiredChannels) {
  const blocking = [];
  const warnings = [];
  const details = {
    database: systemHealth?.database || null,
    inbound: systemHealth?.inbound || null,
    ai: systemHealth?.ai || null,
    messaging: [],
  };

  if (!systemHealth || typeof systemHealth !== "object") {
    blocking.push({
      key: "system_health",
      status: "missing",
      summary: "Operational system health was not returned by Setup Status.",
    });
    return { blocking, warnings, details };
  }

  if (systemHealth.database?.status !== "healthy" || systemHealth.database?.migrationState !== "up_to_date") {
    blocking.push({
      key: "system_health_database",
      status: systemHealth.database?.status || "missing",
      summary: systemHealth.database?.summary || "Database migration/runtime health is not ready.",
    });
  }

  if (systemHealth.inbound?.status !== "healthy") {
    blocking.push({
      key: "system_health_inbound",
      status: systemHealth.inbound?.status || "missing",
      summary: systemHealth.inbound?.summary || "Inbound processing is not healthy.",
    });
  }

  if (systemHealth.ai?.status === "error" || !systemHealth.ai) {
    blocking.push({
      key: "system_health_ai",
      status: systemHealth.ai?.status || "missing",
      summary: systemHealth.ai?.summary || "AI runtime health is unavailable.",
    });
  } else if (systemHealth.ai.status === "warning") {
    warnings.push({
      key: "system_health_ai",
      status: "warning",
      summary: systemHealth.ai.summary || "AI is available with a degraded runtime signal.",
    });
  }

  const messagingByChannel = new Map(
    (Array.isArray(systemHealth.messaging) ? systemHealth.messaging : [])
      .map((item) => [item.channel, item])
  );

  for (const channel of requiredChannels) {
    const runtime = messagingByChannel.get(channel) || null;
    details.messaging.push(runtime || { channel, status: "missing" });
    if (!runtime) {
      blocking.push({
        key: `${channel}_runtime`,
        status: "missing",
        summary: `Runtime messaging health for ${channel} was not returned.`,
      });
      continue;
    }
    if (runtime.configured !== true) {
      blocking.push({
        key: `${channel}_runtime`,
        status: "not_configured",
        summary: `${channel} is not configured in runtime health.`,
      });
    }
    const inboundAt = timestampMs(runtime.lastInboundAt);
    const outboundAt = timestampMs(runtime.lastVerifiedAutomatedReplyAt);
    const failureAt = timestampMs(runtime.lastReadinessDeliveryFailureAt);
    if (!inboundAt) {
      blocking.push({
        key: `${channel}_round_trip_inbound`,
        status: "missing",
        summary: `No real inbound ${channel} customer message has been observed yet.`,
      });
    }
    if (!outboundAt) {
      blocking.push({
        key: `${channel}_round_trip_outbound`,
        status: "missing",
        summary: `No provider-accepted AI reply to the latest ${channel} inbound conversation has been verified yet.`,
      });
    } else if (inboundAt && outboundAt < inboundAt) {
      blocking.push({
        key: `${channel}_round_trip_outbound`,
        status: "stale",
        summary: `The latest ${channel} inbound message does not have a newer provider-accepted AI reply yet.`,
      });
    }
    if (failureAt && (!outboundAt || failureAt > outboundAt)) {
      blocking.push({
        key: `${channel}_delivery_failure`,
        status: "error",
        summary: `An AI ${channel} reply attempt failed after the latest verified provider-accepted AI reply.`,
      });
    } else if (runtime.status !== "healthy") {
      blocking.push({
        key: `${channel}_runtime`,
        status: runtime.status || "warning",
        summary: runtime.evidence || `${channel} runtime health is not healthy.`,
      });
    }
  }

  return { blocking, warnings, details };
}

function evaluateReadiness(overview, {
  expectedIndustry,
  requiredChannels,
} = {}) {
  const channels = normalizeRequiredChannels(requiredChannels);
  const businessProfile = evaluateBusinessProfile(overview?.businessProfile, expectedIndustry);
  const checks = Array.isArray(overview?.checks) ? overview.checks : [];
  const byKey = new Map(checks.map((check) => [check.key, check]));

  const applicationChecks = [];
  const seenApplicationKeys = new Set();
  for (const key of REQUIRED_CORE_CHECK_KEYS) {
    applicationChecks.push(readinessItem(byKey.get(key) || missingRequiredCheck(key)));
    seenApplicationKeys.add(key);
  }
  for (const check of checks) {
    if (
      check.optional !== true
      && !ALL_CHANNEL_CHECK_KEYS.has(check.key)
      && !seenApplicationKeys.has(check.key)
    ) {
      applicationChecks.push(readinessItem(check));
      seenApplicationKeys.add(check.key);
    }
  }

  const channelChecks = [];
  const seenKeys = new Set();
  for (const channel of channels) {
    for (const key of CHANNEL_CHECK_KEYS[channel]) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const check = byKey.get(key) || missingRequiredCheck(key);
      channelChecks.push({ ...readinessItem(check), channel });
    }
  }

  const blocking = [];
  if (businessProfile.status !== "ready") {
    blocking.push({ key: businessProfile.key, status: businessProfile.status, summary: businessProfile.summary });
  }
  for (const item of [...applicationChecks, ...channelChecks]) {
    if (item.configured !== true || item.status !== "ready") {
      const missing = item.status === "missing";
      blocking.push({
        key: item.key,
        status: missing ? "missing" : item.configured !== true ? "not_configured" : item.status,
        summary: missing
          ? item.summary
          : item.configured !== true
            ? `${item.label} is required but is not fully configured.`
            : item.summary,
      });
    }
  }

  const operational = evaluateSystemHealth(overview?.systemHealth, channels);
  blocking.push(...operational.blocking);
  const warnings = [...operational.warnings];
  const ready = blocking.length === 0;
  const status = !ready
    ? "needs_attention"
    : warnings.length
      ? "ready_with_warnings"
      : "ready";

  return {
    status,
    ready,
    verificationCompleted: true,
    checkedAt: overview?.checkedAt || new Date().toISOString(),
    expectedIndustry: businessProfile.expectedIndustry,
    actualIndustry: businessProfile.actualIndustry,
    requiredChannels: channels,
    businessProfile,
    applicationChecks,
    channelChecks,
    operationalHealth: operational.details,
    blocking,
    warnings,
    summary: {
      blocking: blocking.length,
      warnings: warnings.length,
      applicationReady: applicationChecks.filter((item) => item.configured && item.status === "ready").length,
      applicationTotal: applicationChecks.length,
      channelReady: channelChecks.filter((item) => item.configured && item.status === "ready").length,
      channelTotal: channelChecks.length,
    },
  };
}

function verificationFailureReport(err, {
  expectedIndustry = null,
  requiredChannels = [],
} = {}) {
  let channels = [];
  try {
    channels = normalizeRequiredChannels(requiredChannels);
  } catch (_) {
    channels = Array.isArray(requiredChannels) ? [...requiredChannels] : [];
  }
  return {
    status: "verification_failed",
    ready: false,
    verificationCompleted: false,
    checkedAt: new Date().toISOString(),
    expectedIndustry,
    actualIndustry: null,
    requiredChannels: channels,
    businessProfile: null,
    applicationChecks: [],
    channelChecks: [],
    operationalHealth: null,
    blocking: [{
      key: err?.code || "readiness_verification",
      status: "error",
      summary: err?.message || "Readiness verification could not be completed.",
    }],
    warnings: [],
    summary: {
      blocking: 1,
      warnings: 0,
      applicationReady: 0,
      applicationTotal: 0,
      channelReady: 0,
      channelTotal: 0,
    },
  };
}

async function verifyClientReadiness({
  baseUrl,
  username,
  password,
  expectedIndustry,
  requiredChannels,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  const industry = normalizeExpectedIndustry(expectedIndustry);
  const channels = normalizeRequiredChannels(requiredChannels);
  const session = await authenticateClient({
    baseUrl,
    username,
    password,
    fetchImpl,
    timeoutMs,
  });

  try {
    const setupResponse = await requestJson(`${session.url}/api/setup-status/run`, {
      fetchImpl,
      timeoutMs,
      method: "POST",
      cookie: session.cookie,
    });
    const overview = await readJson(setupResponse);
    if (!setupResponse.ok) {
      throw new ClientReadinessError(
        `Setup Status checks could not be completed (HTTP ${setupResponse.status}).`,
        {
          code: "READINESS_SETUP_STATUS_FAILED",
          stage: "setup_status",
          status: setupResponse.status,
        }
      );
    }
    return evaluateReadiness(overview, {
      expectedIndustry: industry,
      requiredChannels: channels,
    });
  } finally {
    await logoutClient({
      url: session.url,
      cookie: session.cookie,
      fetchImpl,
      timeoutMs,
    });
  }
}

module.exports = {
  ALL_CHANNEL_CHECK_KEYS,
  CHANNEL_CHECK_KEYS,
  CHANNEL_RUNTIME_ENV_KEYS,
  ClientReadinessError,
  DEFAULT_READINESS_TIMEOUT_MS,
  REQUIRED_CORE_CHECK_KEYS,
  SUPPORTED_CHANNELS,
  authenticateClient,
  cookieHeaderFromResponse,
  evaluateBusinessProfile,
  evaluateReadiness,
  evaluateSystemHealth,
  extractSetCookieHeaders,
  normalizeBaseUrl,
  normalizeExpectedIndustry,
  normalizeRequiredChannels,
  validateRuntimeReadinessContract,
  verificationFailureReport,
  verifyAdminLogin,
  verifyClientReadiness,
};