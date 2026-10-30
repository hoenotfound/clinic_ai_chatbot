"use strict";

// Low-overhead, aggregate-only memory diagnostics for Render. We need both
// Node heap and container usage to distinguish JS retention from large buffers
// or native allocations. No request body, contact, phone or message is logged.
const { readFileSync } = require("node:fs");
const { takeWorkerActivity } = require("../utils/workerActivityMetrics");

const INTERVAL_MS = 60 * 1000;
const MIB = 1024 * 1024;
let timer = null;

function readCgroupBytes(file, readFile = readFileSync) {
  try {
    const raw = String(readFile(file, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readCgroupMemoryStat(readFile = readFileSync) {
  try {
    const values = new Map();
    for (const line of String(readFile("/sys/fs/cgroup/memory.stat", "utf8")).split("\n")) {
      const match = /^([a-z_]+) (\d+)$/.exec(line);
      if (match) values.set(match[1], Number(match[2]));
    }
    return values;
  } catch (_) {
    return new Map();
  }
}

function mib(bytes) {
  return Number.isFinite(bytes) && bytes >= 0
    ? Math.round((bytes / MIB) * 10) / 10
    : null;
}

function sampleMemory({
  memoryUsage = process.memoryUsage,
  uptime = process.uptime,
  readFile = readFileSync,
} = {}) {
  const usage = memoryUsage();
  const stat = readCgroupMemoryStat(readFile);
  return {
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    heapTotalMiB: mib(usage.heapTotal),
    externalMiB: mib(usage.external),
    arrayBuffersMiB: mib(usage.arrayBuffers),
    containerUsedMiB: mib(readCgroupBytes("/sys/fs/cgroup/memory.current", readFile)),
    containerLimitMiB: mib(readCgroupBytes("/sys/fs/cgroup/memory.max", readFile)),
    containerAnonMiB: mib(stat.get("anon")),
    containerFileMiB: mib(stat.get("file")),
    containerShmemMiB: mib(stat.get("shmem")),
    containerSlabMiB: mib(stat.get("slab")),
    uptimeSeconds: Math.floor(uptime()),
  };
}

function startMemoryDiagnostics({
  env = process.env,
  logger = console,
  setIntervalFn = setInterval,
  sample = sampleMemory,
} = {}) {
  if (timer || env.DA_MEMORY_DIAGNOSTICS_ENABLED === "false") return timer;
  if (!env.RENDER_SERVICE_ID && env.DA_MEMORY_DIAGNOSTICS_ENABLED !== "true") return null;
  const log = () => {
    try {
      logger.info?.("[Memory diagnostics]", { ...sample(), workers: takeWorkerActivity() });
    } catch (error) {
      // Diagnostics never interrupt primary WhatsApp or other service workers.
      logger.warn?.("[Memory diagnostics] sample unavailable");
    }
  };
  log();
  timer = setIntervalFn(log, INTERVAL_MS);
  timer?.unref?.();
  return timer;
}

module.exports = { INTERVAL_MS, mib, readCgroupBytes, readCgroupMemoryStat, sampleMemory, startMemoryDiagnostics };
