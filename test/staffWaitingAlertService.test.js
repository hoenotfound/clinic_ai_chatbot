const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STAFF_WAITING_BATCH_SIZE,
  STAFF_WAITING_LOCK_NAMESPACE,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
  staffWaitingEventKey,
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

function createFakeDatabase(queryHandler = async () => ({ rows: [] })) {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return queryHandler(sql, params, calls);
    },
    release() {
      released += 1;
      calls.push({ sql: "RELEASE", params: [] });
    },
  };
  return {
    database: { connect: async () => client },
    calls,
    get released() {
      return released;
    },
  };
}

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

test("successful reminder is serialized and only marked sent after Telegram succeeds", async () => {
  const steps = [];
  const fake = createFakeDatabase(async (sql, params) => {
    if (/SELECT id FROM telegram_immediate_alerts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });

  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    database: fake.database,
    getContext: async (contactId, query) => {
      assert.equal(contactId, 12);
      assert.equal(typeof query, "function");
      steps.push("context");
      return context;
    },
    stillWaiting: async (contactId, waitingSinceMessageId, query) => {
      assert.deepEqual([contactId, waitingSinceMessageId], [12, 45]);
      assert.equal(typeof query, "function");
      steps.push("revalidate");
      return true;
    },
    sendMessage: async (input) => {
      steps.push("telegram");
      assert.equal(input.token, "bot-token");
      assert.equal(input.chatId, "-100123");
      assert.match(input.text, /Waiting: 11 minutes/);
      const markerExists = fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql));
      assert.equal(markerExists, false);
      return { message_id: 90 };
    },
  });

  const result = await service({
    contactId: 12,
    waitingSinceMessageId: 45,
    waitingMinutes: 11,
  });

  assert.deepEqual(result, { status: "sent", result: { message_id: 90 } });
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.match(fake.calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(fake.calls[1].params, [STAFF_WAITING_LOCK_NAMESPACE, 45]);
  assert.match(fake.calls[2].sql, /SELECT id FROM telegram_immediate_alerts/);
  const insert = fake.calls.find((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql));
  assert.deepEqual(insert.params, ["staff_waiting:12:45", 12]);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
  assert.deepEqual(steps, ["context", "revalidate", "telegram"]);
  assert.equal(fake.released, 1);
});

test("an already-sent episode is suppressed before loading context or calling Telegram", async () => {
  const fake = createFakeDatabase(async (sql) => {
    if (/SELECT id FROM telegram_immediate_alerts/.test(sql)) {
      return { rows: [{ id: 77 }] };
    }
    return { rows: [] };
  });
  let contextCalls = 0;
  let sends = 0;

  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    database: fake.database,
    getContext: async () => {
      contextCalls += 1;
      return context;
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 });
  assert.deepEqual(result, { status: "suppressed" });
  assert.equal(contextCalls, 0);
  assert.equal(sends, 0);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
});

test("resolved conversation is rechecked before Telegram and leaves no sent marker", async () => {
  const fake = createFakeDatabase(async (sql) => {
    if (/SELECT id FROM telegram_immediate_alerts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  let sends = 0;

  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    database: fake.database,
    getContext: async () => context,
    stillWaiting: async () => false,
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 });
  assert.deepEqual(result, { status: "resolved" });
  assert.equal(sends, 0);
  assert.equal(fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql)), false);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
});

test("missing contact is skipped without leaving a sent marker", async () => {
  const fake = createFakeDatabase(async (sql) => {
    if (/SELECT id FROM telegram_immediate_alerts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  let sends = 0;

  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    database: fake.database,
    getContext: async () => null,
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 });
  assert.deepEqual(result, { status: "skipped", reason: "contact-not-found" });
  assert.equal(sends, 0);
  assert.equal(fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql)), false);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
});

test("Telegram failure rolls back so the unanswered episode can retry later", async () => {
  const fake = createFakeDatabase(async (sql) => {
    if (/SELECT id FROM telegram_immediate_alerts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });

  const service = createStaffWaitingAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    database: fake.database,
    getContext: async () => context,
    stillWaiting: async () => true,
    sendMessage: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  await assert.rejects(
    () => service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 }),
    /Telegram unavailable/
  );
  assert.equal(fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql)), false);
  assert.equal(fake.calls.at(-2).sql, "ROLLBACK");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
  assert.equal(fake.released, 1);
});

test("disabled waiting alerts do not open a database connection", async () => {
  let connects = 0;
  const service = createStaffWaitingAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    database: {
      connect: async () => {
        connects += 1;
        throw new Error("should not connect");
      },
    },
  });

  assert.deepEqual(
    await service({ contactId: 12, waitingSinceMessageId: 45, waitingMinutes: 11 }),
    { status: "disabled" }
  );
  assert.equal(connects, 0);
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

test("waiting sweep continues to later candidates if one reminder fails", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  const sent = [];
  const run = createStaffWaitingAlertRunner({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    findWaiting: async () => [
      { contact_id: 12, waiting_since_message_id: 45, waiting_minutes: 11 },
      { contact_id: 13, waiting_since_message_id: 50, waiting_minutes: 12 },
    ],
    sendAlert: async (input) => {
      sent.push(input.contactId);
      if (input.contactId === 12) throw new Error("first failed");
    },
  });

  await run();
  assert.deepEqual(sent, [12, 13]);
});
