const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Execute the real route with the lightweight row shape returned by Postgres.
// Stored object keys are intentionally absent from portal message responses.
function harness({ attachment = "saved", providerAccepted = true } = {}) {
  const source = fs.readFileSync(require.resolve("../src/routes/conversations"), "utf8");
  const start = source.indexOf('router.post("/:contactId/media",');
  const end = source.indexOf('\nrouter.post(', start + 1);
  let handler;
  const attention = [];
  let attachCalls = 0;
  const contact = { id: 85, channel: "whatsapp", mode: "ai" };
  const saved = { id: 90, contact_id: 85, has_media_attachment: false };
  const sandbox = {
    console: { info() {}, warn() {}, error() {} }, Date,
    router: { post: (_, __, route) => { handler = route; } },
    handleImageUpload() {}, inboxMediaTimings: () => ({ requestId: "test" }),
    timedMediaStage: async (_, __, work) => work(),
    verboseInboxMediaLogs: () => false,
    contactsRepo: { getContactById: async () => contact },
    WHATSAPP_IMAGE_MIME_TYPES: new Set(["image/jpeg", "image/png"]),
    WHATSAPP_IMAGE_MAX_BYTES: 5 * 1024 * 1024,
    resolveReplyTarget: async () => ({ ok: true, target: null }),
    requireFreeformPolicy: async () => true,
    whatsappPolicy: { manualStaffPurpose: () => "staff" },
    telegramImmediateAlertRepo: { withContactAlertLock: async (_, work) => work() },
    prepareStaffSend: async () => contact, finalizeStaffSendState: async () => contact,
    conversationStore: {
      appendMessageForContact: async () => saved,
      attachStoredMediaForContact: async () => {
        attachCalls += 1;
        if (attachment === "error") throw new Error("Database write failed");
        if (attachment === "missing") return null;
        return { ...saved, has_media_attachment: true, media_mime_type: "image/jpeg" };
      },
    },
    socialProviderSendOptions: (_, __, options) => options,
    mediaStorage: { uploadMedia: async () => "contacts/85/photo-baseline.jpg", isR2RequestTimeoutError: () => false },
    channelMessaging: { sendImageBuffer: async () => ({ success: providerAccepted, wamid: providerAccepted ? "wamid.accepted" : null }) },
    realtimeEvents: { publish() {} },
    flagInboxMediaAttention: async (_, reason) => attention.push(reason),
    finishInboxMediaSend: async (message, result) => ({ ...message, delivery_status: result.success ? "pending" : "failed" }),
    publicDeliveryError: error => error,
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  return {
    attention, attachCalls: () => attachCalls,
    async send() {
      let response;
      let status;
      const res = { status(code) { status = code; return this; }, json(value) { response = value; return this; } };
      await handler({ params: { contactId: 85 }, body: { caption: "test" },
        session: { username: "staff" }, file: { buffer: Buffer.from("photo"), size: 5, mimetype: "image/jpeg" } }, res);
      return { status, response };
    },
  };
}

test("accepted manual photo with a saved lightweight attachment does not flag delivery failure", async () => {
  const h = harness();
  const { status, response } = await h.send();
  assert.equal(status, 201);
  assert.equal(response.delivered, true);
  assert.equal(response.has_media_attachment, true);
  assert.equal(Object.hasOwn(response, "media_key"), false);
  assert.equal(h.attachCalls(), 1);
  assert.deepEqual(h.attention, []);
});

for (const attachment of ["missing", "error"]) {
  test(`accepted manual photo still flags a genuinely ${attachment} attachment save`, async () => {
    const h = harness({ attachment });
    const { status, response } = await h.send();
    assert.equal(status, 201);
    assert.equal(response.delivered, true);
    assert.equal(response.has_media_attachment, false);
    assert.equal(h.attachCalls(), 2);
    assert.equal(h.attention.length, 1);
    assert.match(h.attention[0], /stored attachment could not be linked/);
  });
}

test("saved attachment does not change a rejected provider result into success", async () => {
  const h = harness({ providerAccepted: false });
  const { status, response } = await h.send();
  assert.equal(status, 201);
  assert.equal(response.delivered, false);
  assert.equal(response.has_media_attachment, true);
  assert.equal(response.delivery_status, "failed");
  assert.equal(h.attachCalls(), 1);
  assert.deepEqual(h.attention, []);
});
