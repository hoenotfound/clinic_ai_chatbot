const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  verboseInboxMediaLogs,
  logInboxMediaSummary,
  trackInboxMediaResponse,
} = require("../src/utils/inboxMediaLogging");

function captureLogs(callback) {
  const lines = [];
  const oldInfo = console.info;
  const oldWarn = console.warn;
  console.info = (...args) => lines.push({ level: "info", args });
  console.warn = (...args) => lines.push({ level: "warn", args });
  try {
    callback();
  } finally {
    console.info = oldInfo;
    console.warn = oldWarn;
  }
  return lines.map(({ level, args }) => ({ level, tag: args[0], body: JSON.parse(args[1]) }));
}

function response(statusCode = 201) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.writableFinished = false;
  return res;
}

test("successful media request logs exactly one summary with stage timing, no payloads", () => {
  const res = response();
  const timings = {
    requestId: "inbox-123",
    startedAtMs: Date.now() - 50,
    channel: "whatsapp",
    bytes: 15360,
    providerMs: 12,
    r2Ms: 9,
    outcomeSaveMs: 4,
    outcome: "accepted",
  };
  const lines = captureLogs(() => {
    trackInboxMediaResponse({ params: { contactId: "269" }, body: { caption: "private" } }, res, "video", timings);
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].tag, "[Inbox media summary]");
  assert.equal(lines[0].body.requestId, "inbox-123");
  assert.equal(lines[0].body.contactId, "269");
  assert.equal(lines[0].body.bytes, 15360);
  assert.equal(lines[0].body.stageMs.providerMs, 12);
  assert.equal(lines[0].body.stageMs.r2Ms, 9);
  assert.equal(lines[0].body.stageMs.startedAtMs, undefined);
  assert.ok(lines[0].body.totalMs >= 0);
  assert.doesNotMatch(JSON.stringify(lines), /private/);
});

test("provider failure after HTTP 201 is a warning, not success", () => {
  const res = response(201);
  const lines = captureLogs(() => {
    trackInboxMediaResponse({ params: { contactId: "269" } }, res, "document",
      { requestId: "failed", startedAtMs: Date.now(), outcome: "unknown", failedStage: "providerMs" });
    res.writableFinished = true;
    res.emit("finish");
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].body.outcome, "unknown");
  assert.equal(lines[0].body.httpStatus, 201);
  assert.equal(lines[0].body.failedStage, "providerMs");
});

test("early HTTP rejection and aborted connection both emit one warning", () => {
  const rejected = response(400);
  const aborted = response(200);
  const lines = captureLogs(() => {
    trackInboxMediaResponse({ params: {} }, rejected, "image", { requestId: "bad", startedAtMs: Date.now() });
    rejected.writableFinished = true;
    rejected.emit("finish");
    trackInboxMediaResponse({ params: {} }, aborted, "video", { requestId: "aborted", startedAtMs: Date.now() });
    aborted.emit("close");
  });
  assert.deepEqual(lines.map(l => l.level), ["warn", "warn"]);
  assert.deepEqual(lines.map(l => l.body.outcome), ["rejected", "aborted"]);
});

test("accepted provider send with media persistence issue is a warning", () => {
  const lines = captureLogs(() => logInboxMediaSummary({
    requestId: "missing-attachment", startedAtMs: Date.now(), outcome: "accepted", persistenceIssue: true,
  }, { type: "image", httpStatus: 201 }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].body.persistenceIssue, true);
});

test("a recovered stage exception remains visible as a warning", () => {
  const lines = captureLogs(() => logInboxMediaSummary({
    requestId: "recovered", startedAtMs: Date.now(), outcome: "accepted", failedStage: "r2Ms",
  }, { type: "image", httpStatus: 201 }));
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].body.failedStage, "r2Ms");
});

test("successful WhatsApp media API timing is quiet; HTTP failures still warn", async (t) => {
  const { fetchWithTimeout } = require("../src/services/whatsappService");
  const oldFetch = global.fetch;
  const oldInfo = console.info;
  const oldWarn = console.warn;
  const oldVerbose = process.env.INBOX_MEDIA_VERBOSE_LOGS;
  const logs = [];
  t.after(() => {
    global.fetch = oldFetch;
    console.info = oldInfo;
    console.warn = oldWarn;
    if (oldVerbose === undefined) delete process.env.INBOX_MEDIA_VERBOSE_LOGS;
    else process.env.INBOX_MEDIA_VERBOSE_LOGS = oldVerbose;
  });
  delete process.env.INBOX_MEDIA_VERBOSE_LOGS;
  console.info = (...args) => logs.push({ level: "info", args });
  console.warn = (...args) => logs.push({ level: "warn", args });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  await fetchWithTimeout("https://example.invalid/media", {}, 2000, { requestId: "a", operation: "upload" });
  assert.equal(logs.length, 0);
  global.fetch = async () => ({ ok: false, status: 429, text: async () => "{}" });
  await fetchWithTimeout("https://example.invalid/media", {}, 2000, { requestId: "b", operation: "upload" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].args[0], "[WhatsApp media timing]");
  assert.equal(JSON.parse(logs[0].args[1]).httpStatus, 429);
});

test("verbose timing logs require explicit opt-in", () => {
  const old = process.env.INBOX_MEDIA_VERBOSE_LOGS;
  try {
    delete process.env.INBOX_MEDIA_VERBOSE_LOGS;
    assert.equal(verboseInboxMediaLogs(), false);
    process.env.INBOX_MEDIA_VERBOSE_LOGS = "true";
    assert.equal(verboseInboxMediaLogs(), true);
    process.env.INBOX_MEDIA_VERBOSE_LOGS = "false";
    assert.equal(verboseInboxMediaLogs(), false);
  } finally {
    if (old === undefined) delete process.env.INBOX_MEDIA_VERBOSE_LOGS;
    else process.env.INBOX_MEDIA_VERBOSE_LOGS = old;
  }
});
