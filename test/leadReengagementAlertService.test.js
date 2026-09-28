const test = require("node:test");
const assert = require("node:assert/strict");

const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  LEAD_REENGAGED_MIN_HOURS,
  buildLeadReengagedMessage,
  createLeadReengagementAlertService,
  formatReturnGap,
  getLeadReengagementContext,
  leadReengagedEventKey,
} = require("../src/services/leadReengagementAlertService");

const enabledEnv = {
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHAT_ID: "-100123",
  PUBLIC_BASE_URL: "https://clinic.example.com",
};

const context = {
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Jason",
  channel: "whatsapp",
  channel_user_id: null,
  current_message_id: 90,
  current_customer_message: "Hi, the HIFU promo still have?",
  previous_customer_message_id: 44,
  previous_customer_message_at: "2026-09-24T04:00:00.000Z",
  current_message_at: "2026-09-28T04:00:00.000Z",
  gap_hours: 96,
  lead_id: 7,
  temperature: "hot",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  stage_name: "No Reply",
  previous_ai_summary: "Customer previously asked about HIFU pricing and stopped replying.",
};

test("re-engagement uses a stable message-scoped event key", () => {
  assert.equal(leadReengagedEventKey(12, 90), "lead-reengaged:12:90");
  assert.equal(leadReengagedEventKey(0, 90), null);
  assert.equal(leadReengagedEventKey(12, null), null);
});

test("return gap renders compactly", () => {
  assert.equal(formatReturnGap(24), "24 hours");
  assert.equal(formatReturnGap(48), "2 days");
  assert.equal(formatReturnGap(96.8), "4 days");
});

test("formats a clinic lead re-engagement alert with prior AI context", () => {
  const text = buildLeadReengagedMessage({
    context,
    env: enabledEnv,
    config: getIndustryProfile("aesthetic_clinic"),
  });

  assert.match(text, /^🔄 Lead Re-engaged/);
  assert.match(text, /Jason \(\+60123456789\)/);
  assert.match(text, /Returned after: 4 days/);
  assert.match(text, /Temperature: 🔥 Hot/);
  assert.match(text, /Stage: No Reply/);
  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Previous AI Summary:/);
  assert.match(text, /previously asked about HIFU pricing/);
  assert.match(text, /New Patient Message:/);
  assert.match(text, /HIFU promo still have/);
  assert.match(text, /inbox\?contact=12/);
});

test("formats social and non-clinic re-engagement alerts with channel/business terminology", () => {
  const text = buildLeadReengagedMessage({
    context: {
      ...context,
      whatsapp_number: "facebook:psid-123",
      channel: "facebook",
      channel_user_id: "psid-123",
      name: "Returning Lead",
      treatment_interest: "Kitchen Cabinets",
      branch_name: "Cheras Showroom",
      previous_ai_summary: null,
      current_customer_message: "Can quote my kitchen now?",
    },
    config: getIndustryProfile("home_renovation"),
  });

  assert.match(text, /Returning Lead \(Facebook Messenger: psid-123\)/);
  assert.match(text, /Service: Kitchen Cabinets/);
  assert.match(text, /Business location: Cheras Showroom/);
  assert.match(text, /New Customer Message:/);
  assert.doesNotMatch(text, /Previous AI Summary:/);
});

test("disabled re-engagement alert avoids all database work", async () => {
  let contextCalls = 0;
  let queueCalls = 0;
  const service = createLeadReengagementAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    getContext: async () => {
      contextCalls += 1;
      return context;
    },
    queueAlert: async () => {
      queueCalls += 1;
    },
  });

  assert.deepEqual(
    await service.notifyIfReengaged({
      contactId: 12,
      currentMessageId: 90,
      leadId: 7,
    }),
    { status: "disabled" }
  );
  assert.equal(contextCalls, 0);
  assert.equal(queueCalls, 0);
});

test("first-ever customer message does not create a re-engagement alert", async () => {
  let queueCalls = 0;
  const service = createLeadReengagementAlertService({
    env: enabledEnv,
    getContext: async () => ({
      ...context,
      previous_customer_message_id: null,
      gap_hours: null,
    }),
    queueAlert: async () => {
      queueCalls += 1;
    },
  });

  assert.deepEqual(
    await service.notifyIfReengaged({
      contactId: 12,
      currentMessageId: 90,
      leadId: 7,
    }),
    { status: "skipped", reason: "no-previous-customer-message" }
  );
  assert.equal(queueCalls, 0);
});

test("ordinary conversation continuation under 24 hours is not considered re-engagement", async () => {
  let queueCalls = 0;
  const service = createLeadReengagementAlertService({
    env: enabledEnv,
    getContext: async () => ({
      ...context,
      gap_hours: LEAD_REENGAGED_MIN_HOURS - 0.1,
    }),
    queueAlert: async () => {
      queueCalls += 1;
    },
  });

  assert.deepEqual(
    await service.notifyIfReengaged({
      contactId: 12,
      currentMessageId: 90,
      leadId: 7,
    }),
    { status: "skipped", reason: "recent-conversation" }
  );
  assert.equal(queueCalls, 0);
});

test("a return after 24 hours queues exactly one durable lead-reengaged alert", async () => {
  const queued = [];
  const service = createLeadReengagementAlertService({
    env: enabledEnv,
    getContext: async (input) => {
      assert.deepEqual(input, {
        contactId: 12,
        currentMessageId: 90,
        leadId: 7,
      });
      return { ...context, gap_hours: 24 };
    },
    queueAlert: async (input) => {
      queued.push(input);
      return { status: "queued", alertId: 501 };
    },
  });

  const result = await service.notifyIfReengaged({
    contactId: 12,
    currentMessageId: 90,
    leadId: 7,
  });

  assert.deepEqual(result, { status: "queued", alertId: 501 });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].eventKey, "lead-reengaged:12:90");
  assert.equal(queued[0].type, "lead_reengaged");
  assert.equal(queued[0].contactId, 12);
  assert.equal(queued[0].leadId, 7);
  assert.match(queued[0].messageText, /Previous AI Summary:/);
});

test("re-engagement context reads the previous customer turn and latest stored AI summary", async () => {
  let captured = null;
  const row = { ...context };
  const result = await getLeadReengagementContext(
    { contactId: 12, currentMessageId: 90, leadId: 7 },
    async (sql, params) => {
      captured = { sql, params };
      return { rows: [row] };
    }
  );

  assert.deepEqual(result, row);
  assert.deepEqual(captured.params, [12, 90, 7]);
  assert.match(captured.sql, /previous_message\.created_at/);
  assert.match(captured.sql, /lead_temperature_scores score/);
  assert.match(captured.sql, /score\.summary_data->>'chatSummary'/);
  assert.match(captured.sql, /score\.through_message_id < current_message\.id/);
});
