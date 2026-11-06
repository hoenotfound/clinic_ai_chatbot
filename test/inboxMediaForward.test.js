const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/routes/conversations"), "utf8");
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(overrides = {}) {
  const events = [], attention = [], published = [];
  let saved = { id: 90, contact_id: 2, content: "Caption", media_mime_type: "image/jpeg", media_key: null, is_forwarded: true };
  const sandbox = { console: { info() {}, warn() {}, error() {} }, performance, randomUUID: () => "test-request",
    verboseInboxMediaLogs: () => false, logInboxMediaSummary: () => {},
    withInboxDatabaseTimeouts: work => work(), AI_HANDOFF_OWNER: "AI_HANDOFF", claimAiHandoffOwnership: async () => null,
    aiReplyCancellation: { cancelForContact: c => events.push(`cancel:${c.id}`) },
    prepareStoredInboxImage: async () => null,
    contactsRepo: { getContactById: async () => ({ id: 2, channel: "whatsapp", mode: "ai" }),
      setDeliveryAttention: async (id, reason) => attention.push({ id, reason }) },
    whatsappPolicy: { manualStaffPurpose: () => "staff", checkFreeformAllowed: async () => ({ allowed: true }) },
    telegramImmediateAlertRepo: { withContactAlertLock: async (_, work) => { events.push("lock"); return work(); } },
    conversationStore: { appendMessageForContact: async (...args) => { events.push("saved"); assert.equal(args[7].publish, false); return saved; },
      attachStoredMediaForContact: async (_, __, key) => { events.push("attached"); saved = { ...saved, media_key: key, has_media_attachment: true }; return saved; } },
    mediaStorage: { copyStoredMediaToTemporary: async () => { events.push("temporary"); return { key: "temp", url: "https://example.invalid/temp" }; },
      scheduleTemporaryMediaDelete: () => {}, copyStoredMediaToMessage: async () => { events.push("permanent"); return "target-key"; },
      isR2RequestTimeoutError: error => error.code === "R2_REQUEST_TIMEOUT",
      downloadMedia: async () => { events.push("download"); return Buffer.from("fallback"); },
      uploadMedia: async () => { events.push("upload"); return "target-key"; } },
    channelMessaging: { sendImageByUrl: async () => { events.push("provider"); return { success: true, wamid: "wamid-test" }; },
      sendImageBuffer: async () => { events.push("provider-buffer"); return { success: true, wamid: "wamid-test" }; },
      rejectedError: () => "Provider rejected." },
    messagesRepo: { setWhatsappMessageId: async () => ({ ...saved, whatsapp_message_id: "wamid-test", delivery_status: "pending" }),
      setDeliveryStatusById: async (_, status) => ({ ...saved, delivery_status: status }), socialProviderAliasRecorder: () => null },
    pipelineRepo: { markContactedForContact: async () => events.push("contacted") },
    realtimeEvents: { publish: (...args) => published.push(args) },
    publishDeliveryStatus: row => published.push(row), deliveryErrorForSend: (r, error) => r.success ? null : error,
    publicDeliveryError: error => error, rejectedErrorFor: () => "Provider rejected",
  };
  for (const [key, value] of Object.entries(overrides)) {
    sandbox[key] = value && typeof value === "object" ? { ...sandbox[key], ...value } : value;
  }
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function inboxMediaTimings("), source.indexOf("async function resolveWithin(")) +
    source.slice(source.indexOf("async function prepareStaffSend("), source.indexOf("async function sendStoredMessage(")) +
    source.slice(source.indexOf("async function forwardStoredMessage("), source.indexOf("async function forwardOtherStoredMessage(")), sandbox);
  return { send: () => sandbox.forwardStoredMessage({ id: 1, media_key: "source-baseline.jpg", media_mime_type: "image/jpeg", content: "📷 Caption" }, { id: 2, channel: "whatsapp" }, "staff"), events, attention, published };
}

test("photo forwarding saves first and starts provider delivery before the permanent copy completes", async () => {
  const copy = deferred(), providerStarted = deferred();
  const h = harness({ mediaStorage: { copyStoredMediaToMessage: () => copy.promise },
    channelMessaging: { sendImageByUrl: async () => { providerStarted.resolve(); return { success: true, wamid: "accepted" }; } } });
  const resultPromise = h.send();
  await providerStarted.promise;
  assert.ok(h.events.includes("saved"));
  assert.equal(h.events.includes("attached"), false);
  copy.resolve("target-key");
  const result = await resultPromise;
  assert.equal(result.delivered, true);
  assert.equal(result.message.media_key, "target-key");
  assert.deepEqual(h.events.filter(e => e.startsWith("cancel")), ["cancel:2", "cancel:2"]);
});

test("a failed permanent copy does not misreport an accepted provider send", async () => {
  const error = Object.assign(new Error("timeout"), { code: "R2_REQUEST_TIMEOUT" });
  const h = harness({ mediaStorage: { copyStoredMediaToMessage: async () => { throw error; } } });
  const result = await h.send();
  assert.equal(result.delivered, true);
  assert.equal(h.events.includes("download"), false);
  assert.match(h.attention[0].reason, /history\/retry/);
});

test("copy fallback shares one download between provider and persistence", async () => {
  const error = new Error("copy unsupported");
  const h = harness({ mediaStorage: { copyStoredMediaToMessage: async () => { throw error; }, copyStoredMediaToTemporary: async () => { throw error; } } });
  assert.equal((await h.send()).delivered, true);
  assert.equal(h.events.filter(e => e === "download").length, 1);
  assert.equal(h.events.filter(e => e === "provider-buffer").length, 1);
});

test("an unknown provider result remains unknown when outcome persistence fails", async () => {
  const h = harness({ channelMessaging: { sendImageByUrl: async () => ({ success: false, unknown: true, ambiguous: true, error: "Request timed out" }) },
    messagesRepo: { setDeliveryStatusById: async () => { throw new Error("DB unavailable"); } } });
  const result = await h.send();
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.message.delivery_status, "unknown");
  assert.equal(h.events.includes("contacted"), false);
});

test("closed messaging policy blocks forwarding before preparation or staff state changes", async () => {
  const h = harness({ whatsappPolicy: { checkFreeformAllowed: async () => ({ allowed: false, code: "closed", message: "Window closed" }) } });
  const result = await h.send();
  assert.equal(result.policyBlocked, true);
  assert.deepEqual(h.events, []);
});

test("failed fallback preparation is a definite failure when no provider call occurred", async () => {
  const h = harness({ mediaStorage: {
    copyStoredMediaToTemporary: async () => { throw new Error("copy unavailable"); },
    downloadMedia: async () => { throw new Error("download unavailable"); },
  } });
  const result = await h.send();
  assert.equal(result.delivered, false);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.message.delivery_status, "failed");
  assert.match(result.error, /No message was submitted/);
  assert.equal(h.events.some(event => event.startsWith("provider")), false);
});

test("an interrupted provider helper remains unknown to avoid duplicate delivery", async () => {
  const h = harness({ channelMessaging: { sendImageByUrl: async () => { throw new Error("provider interrupted"); } } });
  const result = await h.send();
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.message.delivery_status, "unknown");
});

test("URL and normalized-buffer forwards pass Inbox deadlines to the fresh provider policy check", async () => {
  for (const normalized of [false, true]) {
    let options;
    const h = harness({
      prepareStoredInboxImage: async () => normalized ? { buffer: Buffer.from("prepared"), mimeType: "image/jpeg" } : null,
      channelMessaging: {
        sendImageByUrl: async (_contact, _url, _caption, supplied) => { options = supplied; return { success: true, wamid: "accepted" }; },
        sendImageBuffer: async (_contact, _buffer, _mime, _caption, _filename, supplied) => { options = supplied; return { success: true, wamid: "accepted" }; },
      },
    });
    assert.equal((await h.send()).delivered, true);
    assert.equal(options.inboxMediaTimings.requestId, "test-request");
    assert.equal(options.inboxMediaTimings.target, 2);
    assert.equal(options.currentMessageId, 90);
    assert.equal(options.staffMedia, true);
  }
});

test("legacy URL-only image forward persists inferred MIME and saved target id", async () => {
  const start = source.indexOf("async function forwardOtherStoredMessage(");
  const end = source.indexOf('\nrouter.post("/:contactId/messages/:messageId/forward"', start);
  let savedMetadata = null;
  let providerMessage = null;
  const saved = {
    id: 191,
    contact_id: 2,
    content: "",
    media_mime_type: "image/jpeg",
    is_forwarded: true,
  };
  const sandbox = {
    console: { info() {}, warn() {}, error() {} },
    Date,
    verboseInboxMediaLogs: () => false,
    whatsappPolicy: {
      manualStaffPurpose: () => "staff",
      checkFreeformAllowed: async () => ({ allowed: true }),
    },
    telegramImmediateAlertRepo: {
      withContactAlertLock: async (_id, work) => work(),
    },
    prepareStaffSend: async contact => contact,
    finalizeStaffSendState: async () => null,
    conversationStore: {
      appendMessageForContact: async (...args) => {
        savedMetadata = args[6];
        return saved;
      },
    },
    mediaStorage: {
      copyStoredMediaToMessage: async () => { throw new Error("unexpected copy"); },
      downloadMedia: async () => { throw new Error("unexpected download"); },
      uploadMedia: async () => { throw new Error("unexpected upload"); },
      deleteMedia: async () => {},
    },
    sendStoredMessage: async (_contact, message) => {
      providerMessage = message;
      return { success: true, wamid: "wamid.legacy" };
    },
    deliveryErrorForSend: () => null,
    rejectedErrorFor: () => "rejected",
    persistSendOutcome: async message => ({ ...message, delivery_status: "pending" }),
    markLeadContacted: async () => {},
    reconcileAcceptedStaffReplyAttention: async () => {},
    contactsRepo: { setDeliveryAttention: async () => {} },
    publicDeliveryError: error => error,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);

  const result = await sandbox.forwardOtherStoredMessage(
    {
      id: 7,
      media_key: null,
      media_url: "https://legacy.example/photo.jpg",
      media_mime_type: null,
      content: "📷 [Customer sent a photo]",
      media_filename: null,
    },
    { id: 2, channel: "whatsapp" },
    "staff"
  );

  assert.equal(result.delivered, true);
  assert.equal(savedMetadata?.mimeType, "image/jpeg");
  assert.equal(providerMessage.id, saved.id);
  assert.equal(providerMessage.contact_id, saved.contact_id);
  assert.equal(providerMessage.media_mime_type, "image/jpeg");
  assert.equal(providerMessage.media_url, "https://legacy.example/photo.jpg");
});


// Exercise the real URL-only forwarding path used by Settings-managed
// Before/After images; the media bytes never enter a public preview URL.
function privateClinicForwardHarness({ loadImage = async () => ({
  buffer: Buffer.from("verified-private-jpeg"),
  mimeType: "image/jpeg",
  filename: "clinic-promo.jpg",
}) } = {}) {
  const storedStart = source.indexOf("async function sendStoredMessage(");
  const storedEnd = source.indexOf("// Aggregate diagnostics only:", storedStart);
  const forwardStart = source.indexOf("async function forwardOtherStoredMessage(");
  const forwardEnd = source.indexOf('\nrouter.post("/:contactId/messages/:messageId/forward"', forwardStart);
  assert.ok(storedStart >= 0 && storedEnd > storedStart && forwardStart >= 0 && forwardEnd > forwardStart);
  const calls = { loaded: [], buffered: [], urls: [], attention: [], warnings: [], saved: [] };
  let nextId = 300;
  const sandbox = {
    Buffer, Date,
    console: { warn: message => calls.warnings.push(message), info() {}, error() {} },
    clinicImage: {
      storedClinicImageRef: require("../src/services/whatsappSecondaryClinicImage").storedClinicImageRef,
      loadOwnedClinicImage: async url => { calls.loaded.push(url); return loadImage(url); },
    },
    hasPartialCaptionMarker: () => false,
    whatsappPolicy: { manualStaffPurpose: () => "staff", checkFreeformAllowed: async () => ({ allowed: true }) },
    telegramImmediateAlertRepo: { withContactAlertLock: async (_id, fn) => fn() },
    prepareStaffSend: async contact => contact,
    finalizeStaffSendState: async () => null,
    conversationStore: { appendMessageForContact: async (...args) => {
      assert.equal(args[7].isForwarded, true);
      const saved = { id: nextId++, contact_id: args[0], content: args[2], is_forwarded: true };
      calls.saved.push({ saved, mediaUrl: args[5], mimeType: args[6]?.mimeType });
      return saved;
    } },
    mediaStorage: {},
    socialProviderSendOptions: (message, _contact, options) => ({
      ...options, staffMedia: true, currentMessageId: message.id,
    }),
    channelMessaging: {
      sendImageBuffer: async (contact, bytes, mime, caption, filename, options) => {
        calls.buffered.push({ contact, bytes, mime, caption, filename, options });
        return { success: true, wamid: "wamid.private-forward" };
      },
      sendImageByUrl: async (contact, url) => {
        calls.urls.push({ contact, url });
        return { success: true, wamid: "wamid.legacy-url" };
      },
    },
    sendSecondaryStaffText: async () => { throw new Error("private image must not become text"); },
    deliveryErrorForSend: (result, error) => result.success ? null : error,
    rejectedErrorFor: () => "provider rejected",
    persistSendOutcome: async (message, result, error) => ({
      ...message,
      delivery_status: result.success ? "sent" : "failed",
      delivery_error: error,
    }),
    reconcileAcceptedStaffReplyAttention: async () => {},
    markLeadContacted: async () => {},
    contactsRepo: { setDeliveryAttention: async (...args) => calls.attention.push(args) },
    publicDeliveryError: error => error,
    verboseInboxMediaLogs: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(storedStart, storedEnd) + source.slice(forwardStart, forwardEnd), sandbox);
  return {
    calls,
    async send(url, target = {
      id: 8946, channel: "whatsapp", whatsapp_sender_id: 2,
      whatsapp_sender_key: "neutro_secondary",
    }) {
      return sandbox.forwardOtherStoredMessage({
        id: 20, media_key: null, media_url: url, media_mime_type: "image/jpeg",
        content: "📷 Example result image",
      }, target, "admin");
    },
  };
}

test("forwarding private Before/After images #11 and #12 to the secondary number uploads trusted bytes", async () => {
  const h = privateClinicForwardHarness();
  for (const id of [11, 12]) {
    const url = '/api/config/result-media/image/' + id;
    const result = await h.send(url);
    assert.equal(result.delivered, true);
    assert.equal(result.message.is_forwarded, true);
  }
  assert.deepEqual(h.calls.loaded, [
    "/api/config/result-media/image/11",
    "/api/config/result-media/image/12",
  ]);
  assert.equal(h.calls.urls.length, 0, "Never submit a private preview path to Meta");
  assert.equal(h.calls.buffered.length, 2);
  for (let i = 0; i < 2; i++) {
    const send = h.calls.buffered[i];
    assert.ok(Buffer.isBuffer(send.bytes));
    assert.equal(send.mime, "image/jpeg");
    assert.equal(send.filename, "clinic-promo.jpg");
    assert.equal(send.contact.whatsapp_sender_key, "neutro_secondary");
    assert.equal(send.options.staffMedia, true);
    assert.equal(send.options.staffForward, true);
    assert.equal(send.options.currentMessageId, 300 + i);
    assert.equal(h.calls.saved[i].mimeType, "image/jpeg");
  }
});

test("secondary forward-only handling also supports configured promo images but never expands to other senders", async () => {
  const h = privateClinicForwardHarness();
  assert.equal((await h.send("/promo-images/30")).delivered, true);
  assert.deepEqual(h.calls.loaded, ["/promo-images/30"]);
  await h.send("/api/config/result-media/image/11", {
    id: 11, channel: "whatsapp", whatsapp_sender_id: 1,
    whatsapp_sender_key: "neutro",
  });
  assert.equal(h.calls.loaded.length, 1);
  assert.equal(h.calls.urls.length, 1, "Primary sender keeps its existing URL handling");
});

test("missing or unreadable private clinic images fail closed without a provider send", async () => {
  for (const loadImage of [
    async () => null,
    async () => { throw new Error("private storage failure detail"); },
  ]) {
    const h = privateClinicForwardHarness({ loadImage });
    const result = await h.send("/api/config/result-media/image/11");
    assert.equal(result.delivered, false);
    assert.equal(result.deliveryUnknown, false);
    assert.equal(result.message.delivery_status, "failed");
    assert.match(result.error, /No message was sent/);
    assert.doesNotMatch(result.error, /private storage failure detail/);
    assert.equal(h.calls.buffered.length, 0);
    assert.equal(h.calls.urls.length, 0);
    assert.equal(h.calls.attention.length, 1);
  }
});
