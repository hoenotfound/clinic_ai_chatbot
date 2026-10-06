const test = require("node:test");
const assert = require("node:assert/strict");
const { createScopedPool, withInboxDatabaseTimeouts } = require("../src/db/inboxDatabaseScope");
const policy = require("../src/services/whatsappPolicyService");
const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const messaging = require("../src/services/channelMessagingService");

function policyDatabase({ fail = false } = {}) {
  const checks = [];
  const clients = [];
  return {
    checks, clients,
    pool: createScopedPool({
      async query() { checks.push({ ordinary: true }); return {}; },
      async connect() {
        const client = {
          settings: ["0", "0"], released: false,
          async query(sql, params) {
            if (sql.includes("current_setting")) return { rows: [{ statement: "0", lock: "0" }] };
            if (sql.includes("set_config")) { client.settings = params; return {}; }
            checks.push({ settings: [...client.settings] });
            if (fail) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
            return {};
          },
          release() { client.released = true; },
        };
        clients.push(client);
        return client;
      },
    }),
  };
}

function stubProviders(t, database) {
  t.mock.method(policy, "checkFreeformAllowed", async () => {
    await database.pool.query("POLICY_LOOKUP");
    return { allowed: true };
  });
  const calls = [];
  function accept(kind, result) {
    return async () => {
      // SQL settings are restored and connections returned before network work.
      assert.ok(database.clients.every(client => client.released));
      calls.push(kind);
      return result;
    };
  }
  t.mock.method(whatsapp, "uploadMedia", accept("upload", "media-id"));
  t.mock.method(whatsapp, "sendImageById", accept("message-id", { success: true, wamid: "accepted" }));
  t.mock.method(whatsapp, "sendImage", accept("message-link", { success: true, wamid: "accepted" }));
  return calls;
}

const contact = { id: 2, channel: "whatsapp", whatsapp_number: "60120000000" };
const sendBuffer = options => messaging.sendImageBuffer(contact, Buffer.from("image"), "image/jpeg", "caption", "image.jpg", options);
const sendUrl = options => messaging.sendImageByUrl(contact, "https://example.invalid/photo.jpg", "caption", options);

for (const [name, send] of [["manual/normalized image", sendBuffer], ["R2 URL forward", sendUrl]]) {
  test(`${name} scopes the repeated policy check and releases SQL before provider delivery`, async (t) => {
    const database = policyDatabase();
    const calls = stubProviders(t, database);
    // The earlier route preflight has already completed its own scope.
    await withInboxDatabaseTimeouts(() => policy.checkFreeformAllowed(contact));
    const timings = { requestId: "policy-regression" };
    const result = await send({ inboxMediaTimings: timings });
    assert.equal(result.success, true);
    assert.deepEqual(database.checks, [
      { settings: ["10000ms", "5000ms"] },
      { settings: ["10000ms", "5000ms"] },
    ]);
    assert.equal(database.clients.length, 2);
    assert.ok(database.clients.every(client => client.released && client.settings.every(value => value === "0")));
    assert.ok(calls.length > 0);
    assert.equal(typeof timings.providerPolicyMs, "number");
    await database.pool.query("BACKGROUND_AI_QUERY");
    assert.deepEqual(database.checks.at(-1), { ordinary: true });
  });

  test(`${name} fails closed after a policy SQL timeout without uploading or submitting a message`, async (t) => {
    const database = policyDatabase({ fail: true });
    const calls = stubProviders(t, database);
    const result = await send({ inboxMediaTimings: { requestId: "policy-timeout" } });
    assert.equal(result.success, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyCode, "policy_state_unavailable");
    assert.deepEqual(calls, []);
    assert.ok(database.clients.every(client => client.released));
  });
}

test("background AI image sends retain their ordinary policy-query settings", async (t) => {
  const database = policyDatabase();
  const calls = stubProviders(t, database);
  assert.equal((await sendBuffer({})).success, true);
  assert.deepEqual(database.checks, [{ ordinary: true }]);
  assert.equal(database.clients.length, 0);
  assert.deepEqual(calls, ["upload", "message-id"]);
});

test("Messenger image policy and caption/image alias writes get separate short Inbox scopes", async (t) => {
  const database = policyDatabase();
  stubProviders(t, database);
  const accepted = [];
  const aliases = [];
  function send(kind) {
    return async () => {
      assert.ok(database.clients.every(client => client.released));
      accepted.push(kind);
      return { success: true, externalMessageId: kind };
    };
  }
  t.mock.method(meta, "sendText", send("caption"));
  t.mock.method(metaAttachments, "sendBuffer", send("image"));
  const result = await messaging.sendImageBuffer(
    { id: 3, channel: "facebook", channel_user_id: "test-recipient" },
    Buffer.from("image"), "image/jpeg", "caption", "image.jpg",
    {
      inboxMediaTimings: { requestId: "social-policy-regression" },
      onProviderMessageId: async id => { aliases.push(id); await database.pool.query("ALIAS_WRITE"); },
    }
  );
  assert.equal(result.success, true);
  assert.deepEqual(accepted, ["caption", "image"]);
  assert.deepEqual(aliases, ["caption", "image"]);
  assert.equal(database.clients.length, 3);
  assert.ok(database.checks.every(check => check.settings[0] === "10000ms" && check.settings[1] === "5000ms"));
  assert.ok(database.clients.every(client => client.released));
});
