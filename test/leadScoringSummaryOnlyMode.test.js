const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const { pool } = require("../src/db/db");
const configRepo = require("../src/db/configRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const leadScoringRepo = require("../src/db/leadScoringRepo");
const {
  createLeadScoringRunner,
  ensureConversationAnalysisActivation,
  getActiveSettings,
} = require("../src/services/leadScoringService");

const baseSettings = {
  inactivityMinutes: 10,
  maxConversationMinutes: 60,
  maxMessages: 40,
  activatedAt: "2026-08-30T00:00:00.000Z",
};

function withTelegramEnv(t, enabled = true) {
  const previous = {
    TELEGRAM_ALERTS_ENABLED: process.env.TELEGRAM_ALERTS_ENABLED,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  if (enabled) {
    process.env.TELEGRAM_ALERTS_ENABLED = "true";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "-100123";
  } else {
    process.env.TELEGRAM_ALERTS_ENABLED = "false";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
}

function preserveClinicConfig(t) {
  const previousLeadScoring = clinicConfig.leadScoring;
  const hadSummaryConfig = Object.prototype.hasOwnProperty.call(
    clinicConfig,
    "telegramConversationSummary"
  );
  const previousSummaryConfig = clinicConfig.telegramConversationSummary;

  t.after(() => {
    clinicConfig.leadScoring = previousLeadScoring;
    if (hadSummaryConfig) {
      clinicConfig.telegramConversationSummary = previousSummaryConfig;
    } else {
      delete clinicConfig.telegramConversationSummary;
    }
  });
}

test("Telegram keeps conversation AI analysis active while automatic temperature is off", (t) => {
  withTelegramEnv(t, true);
  preserveClinicConfig(t);

  clinicConfig.leadScoring = {
    ...baseSettings,
    enabled: false,
    activatedAt: null,
  };
  clinicConfig.telegramConversationSummary = {
    activatedAt: "2026-08-30T01:00:00.000Z",
  };

  const settings = getActiveSettings();
  assert.ok(settings);
  assert.equal(settings.activatedAt, "2026-08-30T01:00:00.000Z");
  assert.equal(settings.autoTemperatureEnabled, false);
  assert.equal(settings.temperatureActivatedAt, null);
});

test("no background conversation AI runs when both auto temperature and Telegram are off", (t) => {
  withTelegramEnv(t, false);
  preserveClinicConfig(t);

  clinicConfig.leadScoring = {
    ...baseSettings,
    enabled: false,
    activatedAt: null,
  };
  clinicConfig.telegramConversationSummary = {
    activatedAt: "2026-08-30T01:00:00.000Z",
  };

  assert.equal(getActiveSettings(), null);
});

test("summary-only activation is persisted separately from the staff-editable tool toggle", async (t) => {
  withTelegramEnv(t, true);
  preserveClinicConfig(t);

  clinicConfig.leadScoring = {
    ...baseSettings,
    enabled: false,
    activatedAt: null,
  };
  delete clinicConfig.telegramConversationSummary;

  const originalUpdateConfig = configRepo.updateConfig;
  let saved = null;
  configRepo.updateConfig = async (updates) => {
    saved = updates;
    Object.assign(clinicConfig, updates);
    return clinicConfig;
  };
  t.after(() => {
    configRepo.updateConfig = originalUpdateConfig;
  });

  const activatedAt = await ensureConversationAnalysisActivation();

  assert.ok(!Number.isNaN(Date.parse(activatedAt)));
  assert.deepEqual(saved, {
    telegramConversationSummary: { activatedAt },
  });
});

test("config repository persists the internal summary activation without exposing it as a public config key", async (t) => {
  preserveClinicConfig(t);
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let savedConfig = null;
  pool.query = async (sql, params) => {
    assert.match(sql, /UPDATE clinic_config SET data/);
    savedConfig = params[0];
    return { rows: [] };
  };

  const activatedAt = "2026-08-30T02:00:00.000Z";
  await configRepo.updateConfig({
    telegramConversationSummary: { activatedAt },
  });

  assert.equal(configRepo.CONFIG_KEYS.includes("telegramConversationSummary"), false);
  assert.equal(savedConfig.telegramConversationSummary.activatedAt, activatedAt);
  assert.equal(clinicConfig.telegramConversationSummary.activatedAt, activatedAt);
});

test("summary-only runner still calls AI, queues Telegram, and explicitly disables temperature application", async () => {
  const score = {
    temperature: "hot",
    confidence: "high",
    reason: "Customer asked to book tomorrow.",
    evidenceMessageIds: [44],
    summary: {
      treatmentInterest: "HIFU",
      preferredBranch: "Puchong",
      preferredAppointment: "tomorrow",
      mainConcern: "Jawline lifting",
      chatSummary: "Customer asked about HIFU and requested a booking tomorrow.",
      nextAction: "Confirm an available appointment time.",
    },
    provider: "gemini",
    model: "test-model",
    promptVersion: "test-v2",
  };
  const settings = {
    ...baseSettings,
    autoTemperatureEnabled: false,
    temperatureActivatedAt: null,
  };
  let completionInput = null;
  let queued = null;
  let flushed = null;

  const repository = {
    findCandidates: async () => [{
      lead_id: 7,
      contact_id: 12,
      started_message_id: 33,
      journey_started_at: "2026-08-30T00:05:00.000Z",
      through_message_id: 44,
      latest_customer_at: "2026-08-30T00:20:00.000Z",
      trigger_type: "inactivity",
      temperature: "warm",
    }],
    claimCandidate: async () => ({ id: 91 }),
    getTranscript: async () => [
      { id: 43, role: "assistant", content: "Would tomorrow suit you?" },
      { id: 44, role: "user", content: "Yes, please book me." },
    ],
    completeScore: async (input) => {
      completionInput = input;
      return { status: "completed", applied: false };
    },
    markScoreCancelled: async () => assert.fail("summary-only score should not be cancelled"),
    markScoreFailed: async () => assert.fail("summary-only score should not fail"),
    findTerminalFailuresNeedingAlert: async () => [],
  };

  const run = createLeadScoringRunner({
    repository,
    settingsGetter: () => settings,
    scoreConversation: async () => score,
    queueConversationSummary: async (input) => {
      queued = input;
      return { status: "queued" };
    },
    flushConversationSummaries: async (input) => {
      flushed = input;
      return { status: "completed", sent: 1 };
    },
  });

  await run();

  assert.equal(completionInput.allowTemperatureUpdate, false);
  assert.equal(queued.leadId, 7);
  assert.equal(queued.throughMessageId, 44);
  assert.deepEqual(queued.score.summary, score.summary);
  assert.deepEqual(flushed, { inactivityMinutes: 10 });
});

test("repository stores a high-confidence AI assessment as suggestion-only when automatic temperature is disabled", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM lead_temperature_scores s/.test(sql)) {
        return { rows: [{ id: 211, status: "processing", contact_id: 14 }] };
      }
      if (/SELECT l\.\*/.test(sql)) {
        return {
          rows: [{
            id: 8,
            latest_message_id: 55,
            is_closed: false,
            temperature: "warm",
            temperature_locked: false,
          }],
        };
      }
      if (/UPDATE leads/.test(sql)) {
        return { rows: [{ id: 8, temperature: "warm", temperature_source: "default" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => {};

  const result = await leadScoringRepo.completeScore({
    scoreId: 211,
    leadId: 8,
    throughMessageId: 55,
    triggerType: "inactivity",
    allowTemperatureUpdate: false,
    score: {
      temperature: "hot",
      confidence: "high",
      reason: "Booking request",
      evidenceMessageIds: [55],
      summary: { chatSummary: "Customer requested a booking." },
      provider: "gemini",
      model: "test",
      promptVersion: "v1",
    },
  });

  assert.equal(result.applied, false);
  const leadUpdate = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.ok(leadUpdate);
  assert.doesNotMatch(leadUpdate.sql, /SET temperature =/);
  assert.doesNotMatch(leadUpdate.sql, /temperature_source = 'ai'/);

  const scoreUpdate = queries.find(({ sql }) => /SET status = 'completed'/.test(sql));
  assert.ok(scoreUpdate);
  assert.equal(scoreUpdate.params[9], false);

  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.ok(activity);
  assert.equal(activity.params[2].applied, false);
});

test("candidate query exposes the latest customer time for safe auto-temperature activation", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let capturedSql = "";
  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };

  await leadScoringRepo.findCandidates({
    inactivityMinutes: 10,
    maxConversationMinutes: 60,
    maxMessages: 40,
    activatedAt: "2026-08-30T00:00:00.000Z",
    limit: 5,
  });

  assert.match(capturedSql, /segment\.latest_customer_at/);
  assert.match(
    capturedSql,
    /MAX\(m\.created_at\) FILTER \(WHERE m\.role = 'user'\) AS latest_customer_at/
  );
});
