const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STAFF_WAITING_BATCH_SIZE,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
} = require("../src/services/staffWaitingAlertService");

const context = {
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  temperature: "hot",
  stage_name: "Contacted",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  latest_customer_message_id: 46,
  latest_customer_message: "Tomorrow 12pm can?",
};

test("waiting candidate query finds unanswered staff-attention episodes after 10 minutes", async () => {
  let captured = null;
  const rows = [{
    contact_id: 12,
    waiting_since_message_id: 45,
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
  assert.match(captured.sql, /c\.needs_attention = true/);
  assert.doesNotMatch(captured.sql, /c\.mode = 'human'/);
  assert.match(captured.sql, /first_waiting\.created_at <=/);
  assert.match(captured.sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
  assert.match(captured.sql, /staff_waiting:/);
});

test("revalidation keeps an unanswered message eligible after Return to AI until staff actually resolves it", async () => {
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
  assert.match(captured.sql, /c\.needs_attention = true/);
  assert.doesNotMatch(captured.sql, /c\.mode = 'human'/);
  assert.match(captured.sql, /outbound\.role = 'assistant'/);
  assert.match(captured.sql, /outbound\.delivery_status NOT IN \('failed', 'unknown'\)/);
});

test("formats a separate customer-waiting reminder without implying Return to AI answers the pending message", () => {
  const text = buildStaffWaitingAlertMessage({
    context,
    waitingMinutes: 11,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com" },
  });

  assert.match(text, /⏰ Customer Waiting for Staff/);
  assert.match(text, /unanswered message that needs staff attention/);
  assert.match(text, /Waiting: 11 minutes/);
  assert.match(text, /🔥 Hot/);
  assert.match(text, /Tomorrow 12pm can\?/);
  assert.match(text, /Reply to the customer/);
  assert.match(text, /Return to AI after replying/);
  assert.match(text, /inbox\?contact=12/);
});

test("staff-waiting alert uses one durable event key per unanswered episode", async () => {
  let claimed = null;
  let sent = null;
  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    claimAlert: async (input) => {
      claimed = input;
      return true;
    },
    stillWaiting: async () => true,
    getContext: async () => context,
    sendMessage: async (input) => {
      sent = input;
      return { message_id: 90 };
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });

  assert.deepEqual(claimed, {
    eventKey: "staff_waiting:12:45",
    type: "staff_waiting",
    contactId: 12,
  });
  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /Waiting: 11 minutes/);
  assert.deepEqual(result, { status: "sent", result: { message_id: 90 } });
});

test("resolved conversation is rechecked immediately before send and does not send a stale reminder", async () => {
  let released = null;
  let sends = 0;
  let contextLoaded = false;
  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    claimAlert: async () => true,
    getContext: async () => {
      contextLoaded = true;
      return context;
    },
    stillWaiting: async () => {
      assert.equal(contextLoaded, true);
      return false;
    },
    releaseAlert: async (eventKey) => {
      released = eventKey;
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });

  assert.deepEqual(result, { status: "resolved" });
  assert.equal(released, "staff_waiting:12:45");
  assert.equal(sends, 0);
});

test("Telegram failure releases the staff-waiting claim for a later retry", async () => {
  let released = null;
  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    claimAlert: async () => true,
    stillWaiting: async () => true,
    getContext: async () => context,
    releaseAlert: async (eventKey) => {
      released = eventKey;
    },
    sendMessage: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  await assert.rejects(
    () => service({
      contactId: 12,
      waitingSinceMessageId: 45,
      waitingMinutes: 11,
    }),
    /Telegram unavailable/
  );
  assert.equal(released, "staff_waiting:12:45");
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

test("waiting sweep sends each discovered candidate independently", async () => {
  const sent = [];
  const run = createStaffWaitingAlertRunner({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    findWaiting: async () => [{
      contact_id: 12,
      waiting_since_message_id: 45,
      waiting_minutes: 11,
    }],
    sendAlert: async (input) => {
      sent.push(input);
    },
  });

  await run();
  assert.deepEqual(sent, [{
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  }]);
});
