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
  const logger = { info() { reports++; if (reports === 2) throw Error("logger"); },
    warn() {} };
  const timer = memory.startMemoryDiagnostics({
    env: { RENDER_SERVICE_ID: "srv-unit-test" },
    logger,
    sample: () => ({ rssMiB: 100 }),
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
});
