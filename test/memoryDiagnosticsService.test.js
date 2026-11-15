"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const memory = require("../src/services/memoryDiagnosticsService");

test("memory sampling reports heap and container usage without any customer data", () => {
  const mockMemoryUsage = () => ({
    rss: 200 * 1024 * 1024,
    heapUsed: 61 * 1024 * 1024,
    heapTotal: 100 * 1024 * 1024,
    external: 32 * 1024 * 1024,
    arrayBuffers: 20 * 1024 * 1024,
  });
  const files = {
    "/sys/fs/cgroup/memory.current": String(210 * 1024 * 1024),
    "/sys/fs/cgroup/memory.max": String(512 * 1024 * 1024),
    "/sys/fs/cgroup/memory.stat": "anon 104857600\nfile 73400320\nshmem 10485760\nslab 5242880\n",
  };
  const result = memory.sampleMemory({
    memoryUsage: mockMemoryUsage,
    uptime: () => 101.9,
    readFile: (file) => files[file],
  });
  assert.deepEqual(result, {
    rssMiB: 200,
    heapUsedMiB: 61,
    heapTotalMiB: 100,
    externalMiB: 32,
    arrayBuffersMiB: 20,
    containerUsedMiB: 210,
    containerLimitMiB: 512,
    containerAnonMiB: 100,
    containerFileMiB: 70,
    containerShmemMiB: 10,
    containerSlabMiB: 5,
    uptimeSeconds: 101,
  });
  assert.ok(Object.keys(result).every(key => key.endsWith("MiB") || key === "uptimeSeconds"));
});

test("memory sampling tolerates unavailable or unlimited cgroup files", () => {
  assert.equal(memory.readCgroupBytes("/sys/fs/cgroup/memory.max", () => "max"), null);
  assert.equal(memory.readCgroupBytes("/unknown", () => { throw Error("unavailable"); }), null);
});

test("Render memory sampling uses an unref'd interval and never throws on logging failure", () => {
  let reports = 0;
  let intervalMs = 0;
  let unrefCount = 0;
  let callback = null;
  const entries = [];
  const logger = {
    info(...args) {
      reports++;
      entries.push(args);
      if (reports === 2) throw Error("logger");
    },
    warn() {},
  };
  const timer = memory.startMemoryDiagnostics({
    env: { RENDER_SERVICE_ID: "srv-unit-test" },
    logger,
    sample: () => ({ rssMiB: 100 }),
    poolSnapshot: () => ({
      acquiredTotal: 62, connectedTotal: 4, removedTotal: 3,
      last5Minutes: 6, last15Minutes: 18,
      openConnections: 1, idleConnections: 1, waitingForConnection: 0,
      lastAcquireAt: "2026-11-15T09:55:00Z",
      bySource: [
        { source: "Secondary WhatsApp marketing followup scheduler",
          acquiredTotal: 36, last5Minutes: 4, last15Minutes: 12 },
        { source: "Inbox full conversation list",
          acquiredTotal: 10, last5Minutes: 1, last15Minutes: 4 },
        { source: "customer 60123456789 token",
          acquiredTotal: 16, last5Minutes: 1, last15Minutes: 2 },
      ],
    }),
    wakeSnapshot: () => ({
      last5Minutes: 50,
      last15Minutes: 82,
      counters: [
        { key: "inbox|reconnect", last5Minutes: 2 },
        { key: "wake|secondary_service|conversation_changed|other|unknown|queued", last5Minutes: 48 },
        { key: "inbox|startup", last5Minutes: 0 },
      ],
    }),
    setIntervalFn(fn, ms) {
      callback = fn;
      intervalMs = ms;
      return { unref() { unrefCount++; } };
    },
  });
  assert.ok(timer);
  assert.equal(reports, 1);
  assert.equal(intervalMs, memory.INTERVAL_MS);
  assert.equal(unrefCount, 1);
  assert.doesNotThrow(callback);
  assert.equal(reports, 2);
  // The existing once-per-minute timer emits a separate, single-line
  // diagnostic string every fifth sample, without a second timer.
  for (let i = 0; i < 3; i++) assert.doesNotThrow(callback);
  assert.equal(reports, 7);
  const diagnosticLogs = entries.filter(([message]) =>
    String(message).startsWith("[Refresh/wake diagnostics] "));
  assert.equal(diagnosticLogs.length, 1);
  assert.equal(diagnosticLogs[0].length, 1, "summary stays one log entry");
  assert.doesNotMatch(diagnosticLogs[0][0], /\[Object\]/);
  const parsed = JSON.parse(
    diagnosticLogs[0][0].slice("[Refresh/wake diagnostics] ".length)
  );
  assert.deepEqual(parsed, {
    last5Minutes: 50,
    last15Minutes: 82,
    top: [
      { key: "wake|secondary_service|conversation_changed|other|unknown|queued", count: 48 },
      { key: "inbox|reconnect", count: 2 },
    ],
  });
  assert.ok(entries.filter(([message]) => message === "[Memory diagnostics]").length === 5);
  const poolLogs = entries.filter(([message]) =>
    String(message).startsWith("[Neon pool activity] "));
  assert.equal(poolLogs.length, 1, "exactly one pool summary per five existing ticks");
  assert.equal(poolLogs[0].length, 1, "no extra log objects");
  const pooled = JSON.parse(poolLogs[0][0].slice("[Neon pool activity] ".length));
  assert.equal(pooled.acquiredTotal, 62);
  assert.equal(pooled.last15Minutes, 18);
  assert.equal(pooled.openConnections, 1);
  assert.equal(pooled.bySource[0].source, "Secondary WhatsApp marketing followup scheduler");
  assert.equal(pooled.bySource.find(x => x.source === "other").last15Minutes, 2);
  assert.doesNotMatch(poolLogs[0][0], /60123456789|customer|token|password/);
});

test("pool telemetry allows only literal known source names and bounds untrusted counters", () => {
  const data = memory.summarizePoolActivity({
    acquiredTotal: 7, last5Minutes: 3, last15Minutes: 5,
    openConnections: 1, idleConnections: 0, waitingForConnection: 0,
    bySource: [
      { source: "unattributed", acquiredTotal: 2, last5Minutes: 1, last15Minutes: 1 },
      { source: "WhatsApp delivery-status recovery", acquiredTotal: 2,
        last5Minutes: 1, last15Minutes: 2 },
      { source: "private customer 60123456789", acquiredTotal: 2,
        last5Minutes: 1, last15Minutes: 1 },
      { source: "private-token=secret", acquiredTotal: 1,
        last5Minutes: 0, last15Minutes: 1 },
    ],
  });
  assert.deepEqual(data.bySource.find(x => x.source === "other"), {
    source: "other", acquiredTotal: 3, last5Minutes: 1, last15Minutes: 2,
  });
  assert.equal(data.bySource.find(x => x.source === "unattributed").last5Minutes, 1);
  assert.equal(data.bySource.find(x => x.source === "WhatsApp delivery-status recovery").last15Minutes, 2);
  assert.doesNotMatch(JSON.stringify(data), /60123456789|private|token|secret/);
  assert.equal(memory.summarizePoolActivity({ acquiredTotal: -1 }).acquiredTotal, null);
});
