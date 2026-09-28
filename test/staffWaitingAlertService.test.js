const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  STAFF_WAITING_BATCH_SIZE,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
  staffWaitingEventKey,
} = require("../src/services/staffWaitingAlertService");

const clinic = getIndustryProfile("aesthetic_clinic");
const renovation = getIndustryProfile("home_renovation");

const context = {
  contact_id: 12,
  lead_id: 7,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  channel: "whatsapp",
  channel_user_id: null,
  temperature: "hot",
  stage_name: "Contacted",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  latest_customer_message_id: 46,
  latest_customer_message: "Tomorrow 12pm can?",
};

const enabledEnv = {
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHAT_ID: "-100123",
};

test("waiting candidate query uses the latest unanswered customer message after 10 minutes", async () => {
  let captured = null;
  const rows = [{
    contact_id: 12,
    waiting_since_message_id: 46,
    latest_customer_message_id: 46,
    waiting_minutes: 11,
  }];

  const result = await findWaitingStaffOwnedConversations(
    {},
    async (sql, params) => {
      captured = { sql, params };
      return { rows };
    }
  );

  assert.deepEqual(result, rows);
  assert.deepEqual(captured.params, [STAFF_WAITING_MINUTES, STAFF_WAITING_BATCH_SIZE]);
  assert.match(captured.sql, /c\.mode = 'human' OR c\.needs_attention = true/);
  assert.match(captured.sql, /latest_waiting\.created_at <=/);
  assert.match(captured.sql, /latest_waiting\.id AS waiting_since_message_id/);
  assert.match(captured.sql, /ORDER BY m\.created_at DESC, m\.id DESC/);
  assert.match(captured.sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
  assert.match(captured.sql, /staff_waiting:/);
});

test("revalidation keeps Staff mode or outstanding attention eligible until a valid reply exists", async () => {
  let captured = null;
  const waiting = await isStillWaitingForStaff(
    12,
    45,
    async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ waiting: true }] };
    }
  );

  assert.equal(waiting, true);
  assert.deepEqual(captured.params, [12, 45]);
  assert.match(captured.sql, /c\.mode = 'human' OR c\.needs_attention = true/);
  assert.match(captured.sql, /outbound\.role = 'assistant'/);
  assert.match(captured.sql, /outbound\.sent_by_username IS NOT NULL/);
  assert.match(captured.sql, /outbound\.is_automated_follow_up = false/);
  assert.match(captured.sql, /outbound\.delivery_status NOT IN \('failed', 'unknown'\)/);
});

test("staff waiting event key is stable for one unanswered episode", () => {
  assert.equal(staffWaitingEventKey(12, 45), "staff_waiting:12:45");
});

test("clinic waiting reminder uses channel-aware identity and clinic terminology", () => {
  const text = buildStaffWaitingAlertMessage({
    context,
    waitingMinutes: 11,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com" },
    config: clinic,
  });

  assert.match(text, /⏰ Patient Waiting for Staff/);
  assert.match(text, /Kit Leong \(\+60123456789\)/);
  assert.match(text, /Patient still has an unanswered message/);
  assert.match(text, /Waiting: 11 minutes/);
  assert.match(text, /🔥 Hot/);
  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Latest Patient Message:/);
  assert.match(text, /Tomorrow 12pm can\?/);
  assert.match(text, /Reply to the patient/);
  assert.match(text, /Return to AI after replying/);
  assert.match(text, /inbox\?contact=12/);
});

test("Facebook waiting reminder uses Messenger identifier instead of a WhatsApp placeholder", () => {
  const text = buildStaffWaitingAlertMessage({
    context: {
      ...context,
      whatsapp_number: "facebook:psid-123",
      channel: "facebook",
      channel_user_id: "psid-123",
      name: "Facebook Lead",
    },
    waitingMinutes: 12,
    config: clinic,
  });

  assert.match(text, /Facebook Lead \(Facebook Messenger: psid-123\)/);
  assert.doesNotMatch(text, /Not captured/);
  assert.doesNotMatch(text, /\+123/);
});

test("non-clinic waiting reminder uses service and business-location wording", () => {
  const text = buildStaffWaitingAlertMessage({
    context: {
      ...context,
      treatment_interest: "Kitchen Cabinets",
      branch_name: "Cheras Showroom",
      latest_customer_message: "Can quote my kitchen cabinets?",
    },
    waitingMinutes: 13,
    config: renovation,
  });

  assert.match(text, /⏰ Customer Waiting for Staff/);
  assert.match(text, /Service: Kitchen Cabinets/);
  assert.match(text, /Business location: Cheras Showroom/);
  assert.match(text, /Latest Customer Message:/);
  assert.match(text, /Reply to the customer/);
  assert.doesNotMatch(text, /Treatment:|Branch:|Latest Patient Message:/);
});

test("waiting service revalidates then queues without sending Telegram inline", async () => {
  const steps = [];
  let queued = null;
  const service = createStaffWaitingAlertService({
    env: enabledEnv,
    config: clinic,
    getContext: async (contactId) => {
      assert.equal(contactId, 12);
      steps.push("context");
      return context;
    },
    stillWaiting: async (contactId, waitingSinceMessageId) => {
      assert.deepEqual([contactId, waitingSinceMessageId], [12, 45]);
      steps.push("revalidate");
      return true;
    },
    queueAlert: async (input) => {
      steps.push("queue");
      queued = input;
      return { status: "queued", alertId: 90 };
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });

  assert.deepEqual(result, { status: "queued", alertId: 90 });
  assert.deepEqual(steps, ["context", "revalidate", "queue"]);
  assert.deepEqual(
    {
      eventKey: queued.eventKey,
      type: queued.type,
      contactId: queued.contactId,
      leadId: queued.leadId,
    },
    {
      eventKey: "staff_waiting:12:45",
      type: "staff_waiting",
      contactId: 12,
      leadId: 7,
    }
  );
  assert.match(queued.messageText, /Waiting: 11 minutes/);
});

test("resolved conversation is rechecked before anything is queued", async () => {
  let queued = 0;
  const service = createStaffWaitingAlertService({
    env: enabledEnv,
    getContext: async () => context,
    stillWaiting: async () => false,
    queueAlert: async () => {
      queued += 1;
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });
  assert.deepEqual(result, { status: "resolved" });
  assert.equal(queued, 0);
});

test("missing contact is skipped without queueing", async () => {
  let queued = 0;
  const service = createStaffWaitingAlertService({
    env: enabledEnv,
    getContext: async () => null,
    queueAlert: async () => {
      queued += 1;
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });
  assert.deepEqual(result, { status: "skipped", reason: "contact-not-found" });
  assert.equal(queued, 0);
});

test("disabled waiting alerts do not load context or queue", async () => {
  let contextCalls = 0;
  let queueCalls = 0;
  const service = createStaffWaitingAlertService({
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
    await service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 }),
    { status: "disabled" }
  );
  assert.equal(contextCalls, 0);
  assert.equal(queueCalls, 0);
});

test("waiting sweep is a no-op when Telegram alerts are disabled", async () => {
  let finds = 0;
  let sends = 0;
  const run = createStaffWaitingAlertRunner({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    findWaiting: async () => {
      finds += 1;
      return [];
    },
    sendAlert: async () => {
      sends += 1;
    },
  });

  await run();
  assert.equal(finds, 0);
  assert.equal(sends, 0);
});

test("waiting sweep continues to later candidates if one queue attempt fails", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  const queued = [];
  const run = createStaffWaitingAlertRunner({
    env: enabledEnv,
    findWaiting: async () => [
      { contact_id: 12, waiting_since_message_id: 45, waiting_minutes: 11 },
      { contact_id: 13, waiting_since_message_id: 50, waiting_minutes: 12 },
    ],
    sendAlert: async (input) => {
      queued.push(input.contactId);
      if (input.contactId === 12) throw new Error("first queue failed");
    },
  });

  const result = await run();
  assert.deepEqual(queued, [12, 13]);
  assert.equal(result.failedCount, 1);
});

test("staff-waiting service only queues alerts and never performs Telegram I/O inside a transaction", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/staffWaitingAlertService.js"),
    "utf8"
  );
  const start = source.indexOf("function createStaffWaitingAlertService");
  const end = source.indexOf("const sendStaffWaitingAlert =", start);
  const block = source.slice(start, end);

  assert.doesNotMatch(block, /postTelegramMessage/);
  assert.doesNotMatch(block, /BEGIN|COMMIT|ROLLBACK/);
  assert.doesNotMatch(block, /pg_advisory_xact_lock/);
  assert.match(block, /queueAlert\(\{/);
});
