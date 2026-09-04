const systemHealthRepo = require("../db/systemHealthRepo");
const aiRoutingTelemetryRepo = require("../db/aiRoutingTelemetryRepo");
const aiService = require("./aiService");
const {
  loadMigrations,
  validateAppliedMigrations,
} = require("../db/migrationRunner");

const INBOUND_WARN_SECONDS = 60;
const INBOUND_ERROR_SECONDS = 180;

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function newestTime(...values) {
  const timestamps = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}

function ageSeconds(value, nowMs = Date.now()) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((nowMs - timestamp) / 1000));
}

function statusRank(status) {
  return { healthy: 0, warning: 1, error: 2 }[status] ?? 1;
}

function overallStatus(sections) {
  const highest = sections.reduce((current, item) => {
    return statusRank(item?.status) > statusRank(current) ? item.status : current;
  }, "healthy");
  return {
    status: highest,
    label: highest === "healthy"
      ? "Healthy"
      : highest === "error"
        ? "Needs attention"
        : "Check needed",
  };
}

async function databaseHealth() {
  const plan = loadMigrations();
  const expectedVersion = plan.at(-1)?.version || 0;
  try {
    const applied = await systemHealthRepo.listAppliedMigrations();
    const currentVersion = applied.length ? Number(applied.at(-1).version) || 0 : 0;
    try {
      validateAppliedMigrations(applied, plan);
    } catch (err) {
      return {
        status: "error",
        label: "Needs attention",
        currentVersion,
        expectedVersion,
        migrationState: "incompatible",
        summary: "Database migration history does not match this app version.",
      };
    }

    if (currentVersion < expectedVersion) {
      return {
        status: "warning",
        label: "Check needed",
        currentVersion,
        expectedVersion,
        migrationState: "behind",
        summary: "Database migrations are behind the running app version.",
      };
    }

    return {
      status: "healthy",
      label: "Healthy",
      currentVersion,
      expectedVersion,
      migrationState: "up_to_date",
      summary: "PostgreSQL is responding and migrations are up to date.",
    };
  } catch (err) {
    return {
      status: "error",
      label: "Needs attention",
      currentVersion: null,
      expectedVersion,
      migrationState: "unavailable",
      summary: "Database health information could not be read.",
    };
  }
}

async function inboundHealth(nowMs = Date.now()) {
  try {
    const metrics = await systemHealthRepo.getInboundProcessingMetrics({ hours: 24 });
    const oldestPendingAgeSeconds = ageSeconds(metrics.oldestOpenAt, nowMs);
    let status = "healthy";
    let summary = "Inbound processing is keeping up.";

    if (metrics.terminalFailures > 0 || oldestPendingAgeSeconds >= INBOUND_ERROR_SECONDS) {
      status = "error";
      summary = metrics.terminalFailures > 0
        ? "One or more inbound jobs exhausted retries and need staff attention."
        : "An inbound job has been waiting much longer than expected.";
    } else if (
      oldestPendingAgeSeconds >= INBOUND_WARN_SECONDS
      || metrics.retryableFailedCount > 0
    ) {
      status = "warning";
      summary = "Inbound processing has delayed or retrying work.";
    }

    return {
      status,
      label: status === "healthy" ? "Healthy" : status === "error" ? "Needs attention" : "Check needed",
      pending: metrics.pendingCount,
      processing: metrics.processingCount,
      retrying: metrics.retryableFailedCount,
      oldestPendingAt: iso(metrics.oldestOpenAt),
      oldestPendingAgeSeconds,
      failedLast24h: metrics.failedJobs,
      terminalFailures: metrics.terminalFailures,
      restartRecoveriesLast24h: metrics.restartRecoveries,
      summary,
      thresholds: {
        warningSeconds: INBOUND_WARN_SECONDS,
        errorSeconds: INBOUND_ERROR_SECONDS,
      },
    };
  } catch (err) {
    return {
      status: "warning",
      label: "Check needed",
      pending: null,
      processing: null,
      retrying: null,
      oldestPendingAt: null,
      oldestPendingAgeSeconds: null,
      failedLast24h: null,
      terminalFailures: null,
      restartRecoveriesLast24h: null,
      summary: "Inbound processing health could not be loaded.",
    };
  }
}

function aiModelHealth({ checks = [], aiUsage = null } = {}) {
  const geminiKeys = aiService.getGeminiApiKeys();
  const models = aiService.getGeminiReplyModels();
  const runtimeModels = new Map(
    aiService.getRuntimeGeminiModelHealth().map((item) => [item.model, item])
  );
  const runtimeCandidates = new Map(
    aiService.getRuntimeCandidateHealth().map((item) => [item.candidate_key, item])
  );
  const descriptors = aiService.getCandidateHealthDescriptors();
  const aiCheck = checks.find((item) => item.key === "ai");
  const persistedByLabel = new Map(
    (aiCheck?.candidateHealth || []).map((item) => [`${item.provider}:${item.label}`, item])
  );

  const modelUsage = new Map(
    (aiUsage?.byModel || [])
      .filter((item) => item.provider === "gemini")
      .map((item) => [item.model, item])
  );

  const geminiModels = models.map((model, index) => {
    const runtime = runtimeModels.get(model);
    const usage = modelUsage.get(model);
    const cooling = runtime?.status === "cooling_down";
    return {
      model,
      role: index === 0 ? "primary" : "fallback",
      configured: geminiKeys.length > 0,
      status: geminiKeys.length === 0 ? "not_configured" : cooling ? "warning" : "healthy",
      label: geminiKeys.length === 0 ? "Not configured" : cooling ? "Cooling down" : "Ready",
      cooldownUntil: iso(runtime?.cooldownUntil),
      lastUnavailableAt: iso(runtime?.lastUnavailableAt),
      requestsLast24h: Number(usage?.requests) || 0,
      failedRequestsLast24h: Number(usage?.failedRequests) || 0,
    };
  });

  const keyHealth = descriptors
    .filter((item) => item.provider === "gemini")
    .map((descriptor) => {
      const runtime = runtimeCandidates.get(descriptor.healthKey);
      const persisted = persistedByLabel.get(`gemini:${descriptor.label}`);
      const source = runtime || persisted || {};
      return {
        label: descriptor.label,
        status: source.last_status || source.status || "not_checked",
        failureKind: source.last_failure_kind || source.failureKind || null,
        lastAttemptAt: iso(source.last_attempt_at || source.lastAttemptAt),
        lastSuccessAt: iso(source.last_success_at || source.lastSuccessAt),
        cooldownUntil: iso(source.cooldown_until),
      };
    });

  const claudeDescriptor = descriptors.find((item) => item.provider === "claude");
  const claudeRuntime = claudeDescriptor ? runtimeCandidates.get(claudeDescriptor.healthKey) : null;
  const claudePersisted = persistedByLabel.get("claude:Claude fallback");
  const claudeSource = claudeRuntime || claudePersisted || {};
  const claudeConfigured = Boolean(claudeDescriptor);
  const claudeLastStatus = claudeSource.last_status || claudeSource.status || "not_checked";
  const claudeBad = ["invalid", "failed"].includes(claudeLastStatus);
  const claudeWarning = ["unavailable", "rate_limited"].includes(claudeLastStatus);
  const claude = {
    configured: claudeConfigured,
    status: !claudeConfigured ? "not_configured" : claudeBad ? "error" : claudeWarning ? "warning" : "healthy",
    label: !claudeConfigured ? "Not configured" : claudeBad ? "Needs attention" : claudeWarning ? "Temporarily unavailable" : "Ready",
    lastAttemptAt: iso(claudeSource.last_attempt_at || claudeSource.lastAttemptAt),
    lastSuccessAt: iso(claudeSource.last_success_at || claudeSource.lastSuccessAt),
  };

  return { geminiModels, keyHealth, claude };
}

async function aiHealth({ checks = [], aiUsage = null } = {}) {
  const models = aiModelHealth({ checks, aiUsage });
  let routing;
  try {
    routing = await aiRoutingTelemetryRepo.getRoutingSummary({ hours: 24 });
  } catch {
    routing = {
      windowHours: 24,
      geminiModelFallbacks: null,
      claudeFallbacks: null,
      aiFailures: null,
      lastAiFailureAt: null,
    };
  }

  const configuredProviders = [
    ...models.geminiModels.filter((item) => item.configured),
    ...(models.claude.configured ? [models.claude] : []),
  ];
  const allUnavailable = configuredProviders.length === 0
    || configuredProviders.every((item) => ["error", "not_configured"].includes(item.status));
  const hasWarning = configuredProviders.some((item) => item.status === "warning")
    || (Number(routing.aiFailures) || 0) > 0;
  const status = allUnavailable ? "error" : hasWarning ? "warning" : "healthy";

  return {
    status,
    label: status === "healthy" ? "Healthy" : status === "error" ? "Needs attention" : "Check needed",
    ...models,
    fallbacksLast24h: {
      geminiModel: routing.geminiModelFallbacks,
      claude: routing.claudeFallbacks,
    },
    failuresLast24h: routing.aiFailures,
    lastFailureAt: iso(routing.lastAiFailureAt),
    summary: allUnavailable
      ? "No configured AI provider is currently available."
      : hasWarning
        ? "AI is available, with recent fallback or failure activity to review."
        : "AI providers are ready with no final AI failures recorded in the last 24 hours.",
  };
}

function channelHealth(check, metrics) {
  if (!check?.configured) {
    return {
      ...metrics,
      configured: false,
      status: "not_configured",
      label: "Not configured",
      evidence: "This channel is not configured on this client.",
    };
  }

  const observedAt = newestTime(metrics.lastInboundAt, metrics.lastSuccessfulOutboundAt);
  const checkedAt = check.checkedAt ? new Date(check.checkedAt) : null;
  const checkErrorIsNewer = check.status === "error"
    && (!observedAt || (checkedAt && checkedAt.getTime() > observedAt.getTime()));
  const failureAt = metrics.lastDeliveryFailureAt ? new Date(metrics.lastDeliveryFailureAt) : null;
  const successAfterFailure = Boolean(
    failureAt
    && metrics.lastSuccessfulOutboundAt
    && new Date(metrics.lastSuccessfulOutboundAt).getTime() > failureAt.getTime()
  );

  let status = "healthy";
  let label = "Connected";
  let evidence = observedAt
    ? "Real customer messaging activity has been observed."
    : check.status === "ready"
      ? "Configuration check passed. No recent messaging activity is required for this channel to be healthy."
      : "Configured. Waiting for real messaging activity to provide stronger evidence.";

  if (checkErrorIsNewer) {
    status = "error";
    label = "Needs attention";
    evidence = "The latest connection check failed and no newer real messaging activity has confirmed recovery.";
  } else if ((metrics.recentDeliveryFailures || 0) > 0 && !successAfterFailure) {
    status = "warning";
    label = "Check delivery";
    evidence = "A recent outbound delivery failed and no newer successful outbound has confirmed recovery yet.";
  }

  return {
    ...metrics,
    configured: true,
    status,
    label,
    evidence,
  };
}

async function messagingHealth(checks = []) {
  let metrics;
  try {
    metrics = await systemHealthRepo.getMessagingMetrics({ hours: 24 });
  } catch {
    metrics = ["whatsapp", "instagram", "facebook"].map((channel) => ({
      channel,
      lastInboundAt: null,
      lastSuccessfulOutboundAt: null,
      recentDeliveryFailures: null,
      lastDeliveryFailureAt: null,
    }));
  }
  const checksByKey = new Map(checks.map((item) => [item.key, item]));
  return metrics.map((item) => channelHealth(checksByKey.get(item.channel), item));
}

async function getSystemHealth({ checks = [], aiUsage = null, nowMs = Date.now() } = {}) {
  const [database, inbound, ai, messaging] = await Promise.all([
    databaseHealth(),
    inboundHealth(nowMs),
    aiHealth({ checks, aiUsage }),
    messagingHealth(checks),
  ]);

  const messagingForOverall = messaging.filter((item) => item.configured);
  return {
    checkedAt: new Date(nowMs).toISOString(),
    overall: overallStatus([database, inbound, ai, ...messagingForOverall]),
    database,
    inbound,
    ai,
    messaging,
  };
}

module.exports = {
  INBOUND_ERROR_SECONDS,
  INBOUND_WARN_SECONDS,
  ageSeconds,
  channelHealth,
  getSystemHealth,
  overallStatus,
};
