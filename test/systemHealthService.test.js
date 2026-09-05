const test = require("node:test");
const assert = require("node:assert/strict");

const systemHealthRepo = require("../src/db/systemHealthRepo");
const aiRoutingTelemetryRepo = require("../src/db/aiRoutingTelemetryRepo");
const aiService = require("../src/services/aiService");
const { loadMigrations } = require("../src/db/migrationRunner");
const {
  INBOUND_ERROR_SECONDS,
  INBOUND_WARN_SECONDS,
  ageSeconds,
  channelHealth,
  getSystemHealth,
  overallStatus,
} = require("../src/services/systemHealthService");

const REPLY_CHECKS = [
  { key: "whatsapp", configured: true, status: "ready", checkedAt: "2026-09-05T00:00:00.000Z" },
  { key: "whatsapp_webhook", configured: true, status: "warning", checkedAt: "2026-09-05T00:00:00.000Z" },
  { key: "instagram", configured: true, status: "warning", checkedAt: "2026-09-05T00:00:00.000Z" },
  { key: "facebook", configured: true, status: "warning", checkedAt: "2026-09-05T00:00:00.000Z" },
  { key: "meta_webhook", configured: true, status: "warning", checkedAt: "2026-09-05T00:00:00.000Z" },
  { key: "ai", configured: true, status: "ready", candidateHealth: [] },
];

function appliedMigrationRows() {
  return loadMigrations().map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    applied_at: new Date("2026-09-05T00:00:00.000Z"),
  }));
}

function patchHealthDependencies({ inbound = {}, messaging = null, routing = {} } = {}) {
  const originals = {
    listAppliedMigrations: systemHealthRepo.listAppliedMigrations,
    getInboundProcessingMetrics: systemHealthRepo.getInboundProcessingMetrics,
    getMessagingMetrics: systemHealthRepo.getMessagingMetrics,
    getRoutingSummary: aiRoutingTelemetryRepo.getRoutingSummary,
    getGeminiApiKeys: aiService.getGeminiApiKeys,
    getGeminiReplyModels: aiService.getGeminiReplyModels,
    getRuntimeGeminiModelHealth: aiService.getRuntimeGeminiModelHealth,
    getRuntimeCandidateHealth: aiService.getRuntimeCandidateHealth,
    getCandidateHealthDescriptors: aiService.getCandidateHealthDescriptors,
  };

  systemHealthRepo.listAppliedMigrations = async () => appliedMigrationRows();
  systemHealthRepo.getInboundProcessingMetrics = async () => ({
    pendingCount: 0,
    processingCount: 0,
    retryableFailedCount: 0,
    failedJobs: 0,
    terminalFailures: 0,
    restartRecoveries: 0,
    oldestOpenAt: null,
    ...inbound,
  });
  systemHealthRepo.getMessagingMetrics = async () => messaging || [
    {
      channel: "whatsapp",
      lastInboundAt: null,
      lastSuccessfulOutboundAt: null,
      recentDeliveryFailures: 0,
      lastDeliveryFailureAt: null,
    },
    {
      channel: "instagram",
      lastInboundAt: null,
      lastSuccessfulOutboundAt: null,
      recentDeliveryFailures: 0,
      lastDeliveryFailureAt: null,
    },
    {
      channel: "facebook",
      lastInboundAt: null,
      lastSuccessfulOutboundAt: null,
      recentDeliveryFailures: 0,
      lastDeliveryFailureAt: null,
    },
  ];
  aiRoutingTelemetryRepo.getRoutingSummary = async () => ({
    geminiModelFallbacks: 0,
    claudeFallbacks: 0,
    aiFailures: 0,
    lastAiFailureAt: null,
    ...routing,
  });
  aiService.getGeminiApiKeys = () => ["never-exposed-test-key"];
  aiService.getGeminiReplyModels = () => ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  aiService.getRuntimeGeminiModelHealth = () => [
    { model: "gemini-2.5-flash", status: "available", cooldownUntil: null },
    { model: "gemini-2.5-flash-lite", status: "available", cooldownUntil: null },
  ];
  aiService.getRuntimeCandidateHealth = () => [];
  aiService.getCandidateHealthDescriptors = () => [
    { provider: "gemini", label: "Gemini key 1", healthKey: "private-fingerprint" },
    { provider: "claude", label: "Claude fallback", healthKey: "private-claude-fingerprint" },
  ];

  return () => {
    Object.assign(systemHealthRepo, {
      listAppliedMigrations: originals.listAppliedMigrations,
      getInboundProcessingMetrics: originals.getInboundProcessingMetrics,
      getMessagingMetrics: originals.getMessagingMetrics,
    });
    aiRoutingTelemetryRepo.getRoutingSummary = originals.getRoutingSummary;
    Object.assign(aiService, {
      getGeminiApiKeys: originals.getGeminiApiKeys,
      getGeminiReplyModels: originals.getGeminiReplyModels,
      getRuntimeGeminiModelHealth: originals.getRuntimeGeminiModelHealth,
      getRuntimeCandidateHealth: originals.getRuntimeCandidateHealth,
      getCandidateHealthDescriptors: originals.getCandidateHealthDescriptors,
    });
  };
}

test("health helpers use the intended inbound delay thresholds", () => {
  assert.equal(INBOUND_WARN_SECONDS, 60);
  assert.equal(INBOUND_ERROR_SECONDS, 180);
  assert.equal(ageSeconds("2026-09-05T00:00:00.000Z", Date.parse("2026-09-05T00:01:01.000Z")), 61);
  assert.deepEqual(overallStatus([{ status: "healthy" }, { status: "warning" }]), {
    status: "warning",
    label: "Check needed",
  });
});

test("a quiet configured client is healthy and migration 012 is current", async () => {
  const restore = patchHealthDependencies();
  try {
    const health = await getSystemHealth({
      checks: REPLY_CHECKS,
      aiUsage: { byModel: [] },
      nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
    });

    assert.equal(health.overall.status, "healthy");
    assert.equal(health.database.currentVersion, 12);
    assert.equal(health.database.expectedVersion, 12);
    assert.equal(health.database.migrationState, "up_to_date");
    assert.equal(health.inbound.pending, 0);
    assert.equal(health.inbound.oldestPendingAgeSeconds, 0);
    assert.equal(health.messaging.find((item) => item.channel === "instagram").status, "healthy");
    assert.equal(health.messaging.find((item) => item.channel === "facebook").status, "healthy");
    assert.equal(health.ai.fallbacksLast24h.geminiModel, 0);
    assert.equal(health.ai.fallbacksLast24h.claude, 0);

    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /never-exposed-test-key/);
    assert.doesNotMatch(serialized, /private-fingerprint/);
    assert.doesNotMatch(serialized, /private-claude-fingerprint/);
    assert.match(serialized, /Gemini key 1/);
  } finally {
    restore();
  }
});

test("all invalid Gemini keys make AI health urgent when no fallback provider is usable", async () => {
  const restore = patchHealthDependencies();
  try {
    aiService.getCandidateHealthDescriptors = () => [
      { provider: "gemini", label: "Gemini key 1", healthKey: "private-fingerprint" },
    ];
    aiService.getRuntimeCandidateHealth = () => [
      {
        candidate_key: "private-fingerprint",
        provider: "gemini",
        last_status: "invalid",
        last_failure_kind: "authentication",
        last_attempt_at: new Date("2026-09-05T00:04:00.000Z"),
        last_success_at: null,
        cooldown_until: new Date("2026-09-06T00:04:00.000Z"),
      },
    ];

    const health = await getSystemHealth({
      checks: REPLY_CHECKS,
      aiUsage: { byModel: [] },
      nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
    });

    assert.equal(health.ai.status, "error");
    assert.equal(health.ai.label, "Needs attention");
    assert.equal(health.overall.status, "error");
  } finally {
    restore();
  }
});

test("all Gemini keys or models cooling down are unavailable when Claude is not configured", async () => {
  const restore = patchHealthDependencies();
  try {
    aiService.getCandidateHealthDescriptors = () => [
      { provider: "gemini", label: "Gemini key 1", healthKey: "private-fingerprint" },
    ];
    aiService.getRuntimeCandidateHealth = () => [
      {
        candidate_key: "private-fingerprint",
        provider: "gemini",
        last_status: "rate_limited",
        last_failure_kind: "quota_exhausted",
        cooldown_until: new Date("2026-09-05T01:00:00.000Z"),
      },
    ];
    let health = await getSystemHealth({
      checks: REPLY_CHECKS,
      aiUsage: { byModel: [] },
      nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
    });
    assert.equal(health.ai.status, "error");

    aiService.getRuntimeCandidateHealth = () => [];
    aiService.getRuntimeGeminiModelHealth = () => [
      { model: "gemini-2.5-flash", status: "cooling_down", cooldownUntil: new Date("2026-09-05T00:06:00.000Z") },
      { model: "gemini-2.5-flash-lite", status: "cooling_down", cooldownUntil: new Date("2026-09-05T00:06:00.000Z") },
    ];
    health = await getSystemHealth({
      checks: REPLY_CHECKS,
      aiUsage: { byModel: [] },
      nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
    });
    assert.equal(health.ai.status, "error");
  } finally {
    restore();
  }
});

test("delayed inbound work warns at 60 seconds and becomes urgent at 180 seconds", async () => {
  const nowMs = Date.parse("2026-09-05T00:10:00.000Z");
  let restore = patchHealthDependencies({
    inbound: {
      pendingCount: 1,
      oldestOpenAt: new Date(nowMs - 61_000),
    },
  });
  try {
    const warning = await getSystemHealth({ checks: REPLY_CHECKS, aiUsage: { byModel: [] }, nowMs });
    assert.equal(warning.inbound.status, "warning");
    assert.equal(warning.overall.status, "warning");
  } finally {
    restore();
  }

  restore = patchHealthDependencies({
    inbound: {
      pendingCount: 1,
      oldestOpenAt: new Date(nowMs - 181_000),
    },
  });
  try {
    const urgent = await getSystemHealth({ checks: REPLY_CHECKS, aiUsage: { byModel: [] }, nowMs });
    assert.equal(urgent.inbound.status, "error");
    assert.equal(urgent.overall.status, "error");
  } finally {
    restore();
  }
});

test("terminal inbound failures need attention but successful restart recovery does not", async () => {
  let restore = patchHealthDependencies({
    inbound: { terminalFailures: 1, failedJobs: 1 },
  });
  try {
    const failed = await getSystemHealth({ checks: REPLY_CHECKS, aiUsage: { byModel: [] } });
    assert.equal(failed.inbound.status, "error");
  } finally {
    restore();
  }

  restore = patchHealthDependencies({
    inbound: { restartRecoveries: 2 },
  });
  try {
    const recovered = await getSystemHealth({ checks: REPLY_CHECKS, aiUsage: { byModel: [] } });
    assert.equal(recovered.inbound.status, "healthy");
    assert.equal(recovered.inbound.restartRecoveriesLast24h, 2);
  } finally {
    restore();
  }
});

test("real messaging activity overrides an older failed checker result", () => {
  const health = channelHealth(
    {
      configured: true,
      status: "error",
      checkedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      channel: "whatsapp",
      lastInboundAt: "2026-09-05T00:05:00.000Z",
      lastSuccessfulOutboundAt: null,
      recentDeliveryFailures: 0,
      lastDeliveryFailureAt: null,
    },
    {
      configured: true,
      status: "error",
      checkedAt: "2026-09-05T00:01:00.000Z",
    }
  );
  assert.equal(health.status, "healthy");
  assert.equal(health.label, "Connected");
});

test("a configured channel with missing webhook configuration needs attention", async () => {
  const restore = patchHealthDependencies();
  try {
    const checks = REPLY_CHECKS.map((item) => (
      item.key === "whatsapp_webhook"
        ? { ...item, configured: false, status: "error" }
        : item
    ));
    const health = await getSystemHealth({
      checks,
      aiUsage: { byModel: [] },
      nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
    });
    const whatsapp = health.messaging.find((item) => item.channel === "whatsapp");
    assert.equal(whatsapp.status, "error");
    assert.match(whatsapp.evidence, /webhook configuration is incomplete/i);
    assert.equal(health.overall.status, "error");
  } finally {
    restore();
  }
});

test("a newer delivery failure warns until a later successful outbound confirms recovery", () => {
  const check = { configured: true, status: "ready", checkedAt: "2026-09-05T00:00:00.000Z" };
  const warning = channelHealth(check, {
    channel: "instagram",
    lastInboundAt: null,
    lastSuccessfulOutboundAt: "2026-09-05T00:05:00.000Z",
    recentDeliveryFailures: 1,
    lastDeliveryFailureAt: "2026-09-05T00:06:00.000Z",
  });
  assert.equal(warning.status, "warning");

  const recovered = channelHealth(check, {
    channel: "instagram",
    lastInboundAt: null,
    lastSuccessfulOutboundAt: "2026-09-05T00:07:00.000Z",
    recentDeliveryFailures: 1,
    lastDeliveryFailureAt: "2026-09-05T00:06:00.000Z",
  });
  assert.equal(recovered.status, "healthy");
});
