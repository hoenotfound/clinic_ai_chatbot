const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationSummaryMessage,
  buildWhatsappChatUrl,
  createTelegramAlertService,
  formatWhatsappNumber,
  isTelegramEnabled,
} = require("../src/services/telegramAlertService");

const lead = {
  alert_id: 31,
  lead_id: 7,
  id: 7,
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  stage_name: "Contacted",
  current_temperature: "warm",
  treatment_interest: null,
  branch_name: null,
  appointment_at: null,
  appointment_status: "none",
  channel: "whatsapp",
};

const score = {
  temperature: "hot",
  confidence: "medium",
  reason: "Customer asked about booking but intent is not fully confirmed.",
  summary: {
    treatmentInterest: "HIFU",
    preferredBranch: "Puchong",
    preferredAppointment: "tomorrow afternoon",
    mainConcern: "Jawline sagging",
    chatSummary: "Customer asked about HIFU pricing and then asked about a possible booking tomorrow.",
    nextAction: "Confirm whether the customer wants an available appointment time.",
  },
};

test("Telegram alerts require the toggle, token, and chat id", () => {
  assert.equal(isTelegramEnabled({}), false);
  assert.equal(isTelegramEnabled({ TELEGRAM_ALERTS_ENABLED: "true" }), false);
  assert.equal(isTelegramEnabled({
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "-1001",
  }), true);
});

test("formats Malaysian WhatsApp number for Telegram display", () => {
  assert.equal(formatWhatsappNumber("+60 12-345 6789"), "+60123456789");
});

test("builds a direct WhatsApp chat link only for WhatsApp contacts", () => {
  assert.equal(
    buildWhatsappChatUrl({ channel: "whatsapp", whatsapp_number: "+60 12-345 6789" }),
    "https://wa.me/60123456789"
  );
  assert.equal(
    buildWhatsappChatUrl({ channel: "instagram", whatsapp_number: "+60 12-345 6789" }),
    null
  );
  assert.equal(
    buildWhatsappChatUrl({ channel: "whatsapp", whatsapp_number: null }),
    null
  );
});

test("shows the saved pipeline temperature and a different AI suggestion without replacing it", () => {
  const text = buildConversationSummaryMessage({
    lead,
    score,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com/" },
  });

  assert.match(text, /🟠 Warm Conversation Summary/);
  assert.match(text, /Kit Leong \(\+60123456789\)/);
  assert.doesNotMatch(text, /Current Temperature:/);
  assert.doesNotMatch(text, /AI Review:/);
  assert.match(text, /AI suggests: 🔥 Hot \(medium confidence\)/);
  assert.doesNotMatch(text, /Temperature reason:/);
  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Appointment: tomorrow afternoon/);
  assert.match(text, /Chat Summary:/);
  assert.match(text, /Inbox: https:\/\/clinic\.example\.com\/inbox\?contact=12/);
  assert.match(text, /WhatsApp follow-up: https:\/\/wa\.me\/60123456789/);
});

test("hides the AI suggestion when the AI agrees with the saved pipeline temperature", () => {
  const text = buildConversationSummaryMessage({
    lead,
    score: {
      ...score,
      temperature: "warm",
      confidence: "high",
    },
  });

  assert.match(text, /🟠 Warm Conversation Summary/);
  assert.doesNotMatch(text, /AI suggests:/);
});

test("hides Branch for single-branch clients and Assigned to when lead distribution is disabled", () => {
  const text = buildConversationSummaryMessage({
    lead: {
      ...lead,
      branch_name: "Petaling Jaya",
      owner_username: "sales-a",
      owner_display_name: "Sales A",
    },
    score,
    config: {
      branches: [{ name: "Petaling Jaya" }],
      leadDistribution: { enabled: false },
    },
  });

  assert.doesNotMatch(text, /Branch:/);
  assert.doesNotMatch(text, /Assigned to:/);
});

test("shows Branch and Assigned to when they are operationally relevant", () => {
  const text = buildConversationSummaryMessage({
    lead: {
      ...lead,
      branch_name: "Puchong",
      owner_username: "sales-a",
      owner_display_name: "Sales A",
    },
    score,
    config: {
      businessType: "aesthetic_clinic",
      branches: [{ name: "Puchong" }, { name: "Petaling Jaya" }],
      leadDistribution: { enabled: true },
    },
  });

  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Assigned to: Sales A/);
});

test("does not add a WhatsApp follow-up link for non-WhatsApp leads", () => {
  const text = buildConversationSummaryMessage({
    lead: {
      ...lead,
      channel: "instagram",
      channel_user_id: "ig-123",
    },
    score,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com/" },
  });

  assert.match(text, /Instagram: ig-123/);
  assert.doesNotMatch(text, /WhatsApp follow-up:/);
});

test("current appointment workflow state overrides stale AI appointment preference", () => {
  const cancelled = buildConversationSummaryMessage({
    lead: {
      ...lead,
      appointment_status: "cancelled",
      appointment_at: "2026-09-03T06:00:00.000Z",
    },
    score,
  });
  assert.match(cancelled, /Appointment: Cancelled/);
  assert.doesNotMatch(cancelled, /Appointment: tomorrow afternoon/);

  const rescheduling = buildConversationSummaryMessage({
    lead: {
      ...lead,
      appointment_status: "reschedule",
      appointment_at: "2026-09-03T06:00:00.000Z",
    },
    score,
  });
  assert.match(rescheduling, /Appointment: Rescheduling/);
});

test("AI scoring failure sends customer details and a manual-review alert without an AI summary", () => {
  const text = buildConversationSummaryMessage({
    lead: {
      ...lead,
      treatment_interest: "HIFU",
      branch_name: "Puchong",
    },
    score: {
      alertType: "ai_scoring_failed",
      summaryUnavailable: true,
      attempts: 3,
      summary: {},
    },
    env: { PUBLIC_BASE_URL: "https://clinic.example.com/" },
  });

  assert.match(text, /⚠️ Conversation Needs Manual Review/);
  assert.match(text, /Kit Leong \(\+60123456789\)/);
  assert.match(text, /Temperature: 🟠 Warm/);
  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /AI Summary: Unavailable/);
  assert.match(text, /Open the Inbox, review the conversation manually/);
  assert.match(text, /Inbox: https:\/\/clinic\.example\.com\/inbox\?contact=12/);
  assert.doesNotMatch(text, /AI lead scoring failed/);
  assert.doesNotMatch(text, /conversation was not dropped from Telegram/i);
  assert.doesNotMatch(text, /AI Review:/);
  assert.doesNotMatch(text, /Chat Summary:/);
  assert.doesNotMatch(text, /Temperature reason:/);
});

test("manual-review fallback respects cancelled and rescheduling appointment states", () => {
  const fallbackScore = {
    alertType: "ai_scoring_failed",
    summaryUnavailable: true,
    summary: {},
  };

  const cancelled = buildConversationSummaryMessage({
    lead: {
      ...lead,
      appointment_status: "cancelled",
      appointment_at: "2026-09-03T06:00:00.000Z",
    },
    score: fallbackScore,
  });
  assert.match(cancelled, /Appointment: Cancelled/);
  assert.doesNotMatch(cancelled, /3 Sep 2026/);

  const rescheduling = buildConversationSummaryMessage({
    lead: {
      ...lead,
      appointment_status: "reschedule",
      appointment_at: "2026-09-03T06:00:00.000Z",
    },
    score: fallbackScore,
  });
  assert.match(rescheduling, /Appointment: Rescheduling/);
});

test("disabled service neither queues nor flushes Telegram summaries", async () => {
  let repositoryCalls = 0;
  let sends = 0;
  const repository = new Proxy({}, {
    get() {
      return async () => {
        repositoryCalls += 1;
      };
    },
  });
  const service = createTelegramAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    repository,
    sendMessage: async () => {
      sends += 1;
    },
  });

  assert.deepEqual(
    await service.queueConversationSummary({ leadId: 7, throughMessageId: 44, score }),
    { status: "disabled" }
  );
  assert.deepEqual(
    await service.flushConversationSummaries({ inactivityMinutes: 10 }),
    { status: "disabled", sent: 0 }
  );
  assert.equal(repositoryCalls, 0);
  assert.equal(sends, 0);
});

test("enabled service stores the completed score snapshot in the durable queue", async () => {
  let queued = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      queueSummary: async (input) => {
        queued = input;
        return { id: 31 };
      },
    },
  });

  const result = await service.queueConversationSummary({
    leadId: 7,
    throughMessageId: 44,
    score,
  });
  assert.deepEqual(queued, { leadId: 7, throughMessageId: 44, score });
  assert.deepEqual(result, { status: "queued", alertId: 31 });
});

test("flush rechecks inactivity at claim time and formats from the claimed snapshot", async () => {
  let findArgs = null;
  let claimArgs = null;
  let markedSentId = null;
  let sent = null;
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    PUBLIC_BASE_URL: "https://clinic.example.com",
  };
  const service = createTelegramAlertService({
    env,
    repository: {
      findReadySummaries: async (input) => {
        findArgs = input;
        return [{ alert_id: 31, lead_id: 7 }];
      },
      claimSummary: async (...args) => {
        claimArgs = args;
        return { ...lead, score_data: score };
      },
      markSent: async (id) => {
        markedSentId = id;
      },
      markFailed: async () => assert.fail("successful send should not be marked failed"),
    },
    sendMessage: async (input) => {
      sent = input;
      return { message_id: 99 };
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.deepEqual(findArgs, { inactivityMinutes: 10, limit: 5, suppressionMinutes: 60 });
  assert.deepEqual(claimArgs, [31, 10, 60]);
  assert.equal(markedSentId, 31);
  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /🟠 Warm Conversation Summary/);
  assert.doesNotMatch(sent.text, /Current Temperature:/);
  assert.match(sent.text, /WhatsApp follow-up: https:\/\/wa\.me\/60123456789/);
  assert.deepEqual(result, { status: "completed", sent: 1 });
});

test("normal summary send is fenced by the shared contact lock through final coverage check", async () => {
  const steps = [];
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => ({ ...lead, score_data: score }),
      findActionableCoverage: async () => {
        steps.push("coverage");
        return null;
      },
      markSent: async () => {
        steps.push("markSent");
      },
      markFailed: async () => assert.fail("successful send should not fail"),
    },
    async withContactAlertLock(contactId, work) {
      assert.equal(contactId, 12);
      steps.push("lock:start");
      const result = await work();
      steps.push("lock:end");
      return result;
    },
    sendMessage: async () => {
      steps.push("send");
      return { message_id: 99 };
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });

  assert.deepEqual(result, { status: "completed", sent: 1 });
  assert.deepEqual(steps, [
    "lock:start",
    "coverage",
    "send",
    "markSent",
    "lock:end",
  ]);
});

test("pending actionable alert holds the normal conversation summary without burning an attempt", async () => {
  let sends = 0;
  let released = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      supersedeCoveredSummaries: async () => [],
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => ({ ...lead, score_data: score }),
      findActionableCoverage: async () => "pending",
      releaseClaim: async (id) => {
        released = id;
        return { id, status: "pending" };
      },
      markSuperseded: async () => assert.fail("pending primary alert should not permanently suppress yet"),
      markSent: async () => assert.fail("held summary should not be sent"),
      markFailed: async () => assert.fail("held summary should not be failed"),
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(sends, 0);
  assert.equal(released, 31);
  assert.deepEqual(result, { status: "completed", sent: 0 });
});

test("sent actionable alert permanently supersedes the redundant normal summary", async () => {
  let sends = 0;
  let superseded = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      supersedeCoveredSummaries: async () => [],
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => ({ ...lead, score_data: score }),
      findActionableCoverage: async () => "sent",
      markSuperseded: async (id) => {
        superseded = id;
        return { id, status: "superseded" };
      },
      releaseClaim: async () => assert.fail("sent primary alert should supersede, not hold"),
      markSent: async () => assert.fail("redundant summary should not be sent"),
      markFailed: async () => assert.fail("redundant summary should not fail"),
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(sends, 0);
  assert.equal(superseded, 31);
  assert.deepEqual(result, { status: "completed", sent: 0 });
});

test("a candidate invalidated before claim is not sent", async () => {
  let sends = 0;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => null,
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(sends, 0);
  assert.deepEqual(result, { status: "completed", sent: 0 });
});

test("Telegram send failure is recorded for retry without aborting the flush", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  let failure = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => ({ ...lead, score_data: score }),
      markSent: async () => assert.fail("failed send should not be marked sent"),
      markFailed: async (id, error) => {
        failure = { id, error };
        return { id, status: "pending", attempts: 1 };
      },
      findNextRetryAt: async () => "2026-10-07T00:01:00.000Z",
    },
    sendMessage: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(failure.id, 31);
  assert.match(failure.error.message, /Telegram unavailable/);
  assert.deepEqual(result, {
    status: "completed",
    sent: 0,
    nextRetryAt: "2026-10-07T00:01:00.000Z",
  });
});
