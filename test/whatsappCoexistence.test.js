const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const { getAiOwnedContact } = require("../src/services/automaticReplyGuard");
const {
  parseIncomingMessages,
  parseSmbMessageEchoes,
  parseSmbAppStateSync,
  parseCoexistenceHistory,
} = require("../src/services/whatsappService");
const {
  WHATSAPP_BUSINESS_APP_ACTOR,
  createWhatsAppCoexistenceService,
} = require("../src/services/whatsappCoexistenceService");

function smbEchoPayload(message) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "smb_message_echoes",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "60122972817",
            phone_number_id: "110552088553929",
          },
          message_echoes: [message],
        },
      }],
    }],
  };
}

test("parses a Business App staff message without treating it as customer inbound", () => {
  const payload = smbEchoPayload({
    from: "60122972817",
    to: "60135550000",
    id: "wamid.staff-1",
    timestamp: "1789990000",
    type: "text",
    text: { body: "I can help you with that." },
  });

  const echoes = parseSmbMessageEchoes(payload);
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].id, "wamid.staff-1");
  assert.equal(echoes[0].to, "60135550000");
  assert.equal(echoes[0].text, "I can help you with that.");
  assert.deepEqual(parseIncomingMessages(payload), []);
});

test("Cloud API message_echoes never enter the customer or SMB staff paths", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "message_echoes",
        value: {
          message_echoes: [{
            from: "60122972817",
            to: "60135550000",
            id: "wamid.cloud-outbound-1",
            timestamp: "1789990000",
            type: "text",
            text: { body: "API outbound" },
          }],
        },
      }],
    }],
  };

  assert.deepEqual(parseIncomingMessages(payload), []);
  assert.deepEqual(parseSmbMessageEchoes(payload), []);
});

test("parses Business App contact state sync without creating inbound messages", () => {
  const payload = {
    entry: [{
      changes: [{
        field: "smb_app_state_sync",
        value: {
          state_sync: [{
            type: "contact",
            action: "add",
            contact: {
              full_name: "Patient One",
              first_name: "Patient",
              phone_number: "60136660000",
            },
            metadata: { timestamp: "1789990000" },
          }],
        },
      }],
    }],
  };

  const records = parseSmbAppStateSync(payload);
  assert.equal(records.length, 1);
  assert.equal(records[0].phoneNumber, "60136660000");
  assert.equal(records[0].action, "add");
  assert.deepEqual(parseIncomingMessages(payload), []);
});

test("parses coexistence history with customer and business directions", () => {
  const payload = {
    entry: [{
      changes: [{
        field: "history",
        value: {
          history: [{
            metadata: { phase: 1, chunk_order: 2, progress: 80 },
            threads: [{
              id: "60137770000",
              messages: [
                {
                  from: "60137770000",
                  id: "wamid.history-customer",
                  timestamp: "1789980000",
                  type: "text",
                  text: { body: "Old customer question" },
                  history_context: { status: "delivered" },
                },
                {
                  from: "60122972817",
                  to: "60137770000",
                  id: "wamid.history-staff",
                  timestamp: "1789980060",
                  type: "text",
                  text: { body: "Old staff reply" },
                  history_context: { status: "read" },
                },
              ],
            }],
          }],
        },
      }],
    }],
  };

  const records = parseCoexistenceHistory(payload);
  assert.equal(records.length, 2);
  assert.equal(records[0].direction, "customer");
  assert.equal(records[0].peer, "60137770000");
  assert.equal(records[1].direction, "business");
  assert.equal(records[1].peer, "60137770000");
  assert.deepEqual(parseIncomingMessages(payload), []);
});

test("live Business App staff echo takes over before it is saved and advances New lead only", async () => {
  const order = [];
  const saved = {
    id: 91,
    contact_id: 42,
    role: "assistant",
    content: "Staff answer",
    whatsapp_message_id: "wamid.staff-2",
    sent_by_username: WHATSAPP_BUSINESS_APP_ACTOR,
  };
  const service = createWhatsAppCoexistenceService({
    contacts: {
      async getOrCreateContact(number) {
        order.push("contact");
        assert.equal(number, "60138880000");
        return { id: 42, mode: "ai" };
      },
      async takeOver(id, actor) {
        order.push("takeover");
        assert.equal(id, 42);
        assert.equal(actor, WHATSAPP_BUSINESS_APP_ACTOR);
        return { id, mode: "human", takeover_by: actor };
      },
    },
    messages: {
      async findByWhatsappMessageId() {
        order.push("dedupe");
        return null;
      },
      async saveExternalMessageIfNew(input) {
        order.push("save");
        assert.equal(input.role, "assistant");
        assert.equal(input.sentByUsername, WHATSAPP_BUSINESS_APP_ACTOR);
        assert.equal(input.isHistoryImport, false);
        return saved;
      },
      async updateExternalMessageMedia() {
        throw new Error("not expected");
      },
    },
    pipeline: {
      async markContactedForContact(id, actor) {
        order.push("pipeline");
        assert.equal(id, 42);
        assert.equal(actor, WHATSAPP_BUSINESS_APP_ACTOR);
      },
    },
    events: { publish() { order.push("publish"); } },
    whatsappTransport: { async downloadMedia() { return null; } },
  });

  const result = await service.storeStaffEcho({
    id: "wamid.staff-2",
    to: "60138880000",
    timestamp: "2026-09-25T06:00:00.000Z",
    text: "Staff answer",
  });

  assert.equal(result.duplicate, false);
  assert.ok(order.indexOf("takeover") < order.indexOf("save"));
  assert.deepEqual(order, ["dedupe", "contact", "takeover", "save", "publish", "pipeline"]);
});

test("retried or already-known echo is deduped before takeover", async () => {
  let takeoverCalls = 0;
  const service = createWhatsAppCoexistenceService({
    contacts: {
      async getOrCreateContact() {
        throw new Error("duplicate should not resolve a new contact");
      },
      async takeOver() {
        takeoverCalls += 1;
      },
    },
    messages: {
      async findByWhatsappMessageId() {
        return { id: 12, contact_id: 7, whatsapp_message_id: "wamid.same" };
      },
    },
    pipeline: {},
    events: { publish() {} },
    whatsappTransport: {},
  });

  const result = await service.storeStaffEcho({
    id: "wamid.same",
    to: "60139990000",
    text: "retry",
  });

  assert.equal(result.duplicate, true);
  assert.equal(takeoverCalls, 0);
});

test("staff echo arriving while AI is generating causes the final ownership guard to suppress AI", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  const originalPause = process.env.AUTOMATED_REPLIES_ENABLED;
  let latestContact = { id: 55, mode: "ai", channel: "whatsapp" };

  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
    if (originalPause === undefined) delete process.env.AUTOMATED_REPLIES_ENABLED;
    else process.env.AUTOMATED_REPLIES_ENABLED = originalPause;
  });
  process.env.AUTOMATED_REPLIES_ENABLED = "true";
  contactsRepo.getContactById = async () => latestContact;

  const service = createWhatsAppCoexistenceService({
    contacts: {
      async getOrCreateContact() {
        return latestContact;
      },
      async takeOver(id, actor) {
        latestContact = { ...latestContact, id, mode: "human", takeover_by: actor };
        return latestContact;
      },
    },
    messages: {
      async findByWhatsappMessageId() { return null; },
      async saveExternalMessageIfNew() {
        return { id: 100, contact_id: 55 };
      },
    },
    pipeline: { async markContactedForContact() {} },
    events: { publish() {} },
    whatsappTransport: {},
  });

  // Represents the interval while ai.getReply() is still running.
  await service.storeStaffEcho({
    id: "wamid.staff-race",
    to: "60130000055",
    text: "Human got this",
  });

  const finalOwner = await getAiOwnedContact(
    { id: 55, mode: "ai", channel: "whatsapp" },
    { channel: "whatsapp", from: "60130000055", reason: "final AI send" }
  );

  assert.equal(finalOwner, null);
  assert.equal(latestContact.mode, "human");
});

test("history import is visible data only and never takes over or touches pipeline", async () => {
  let takeovers = 0;
  let pipelineCalls = 0;
  const writes = [];
  const service = createWhatsAppCoexistenceService({
    contacts: {
      async getOrCreateContact() {
        return { id: 70, mode: "ai" };
      },
      async takeOver() {
        takeovers += 1;
      },
    },
    messages: {
      async saveExternalMessageIfNew(input) {
        writes.push(input);
        return { id: writes.length, contact_id: 70 };
      },
    },
    pipeline: {
      async markContactedForContact() {
        pipelineCalls += 1;
      },
    },
    events: { publish() {} },
    whatsappTransport: {},
  });

  const result = await service.storeHistory([
    {
      id: "wamid.hist-user",
      peer: "60131110000",
      direction: "customer",
      text: "Old inbound",
      timestamp: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "wamid.hist-staff",
      peer: "60131110000",
      direction: "business",
      text: "Old staff reply",
      timestamp: "2026-08-01T10:01:00.000Z",
    },
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(takeovers, 0);
  assert.equal(pipelineCalls, 0);
  assert.ok(writes.every((write) => write.isHistoryImport === true));
  assert.equal(writes[0].role, "user");
  assert.equal(writes[1].role, "assistant");
  assert.equal(writes[1].sentByUsername, WHATSAPP_BUSINESS_APP_ACTOR);
});
