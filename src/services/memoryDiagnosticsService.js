"use strict";

// Low-overhead, aggregate-only memory diagnostics for Render. We need both
// Node heap and container usage to distinguish JS retention from large buffers
// or native allocations. No request body, contact, phone or message is logged.
const { readFileSync } = require("node:fs");

const INTERVAL_MS = 5 * 60 * 1000;
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
  return {
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    heapTotalMiB: mib(usage.heapTotal),
    externalMiB: mib(usage.external),
    arrayBuffersMiB: mib(usage.arrayBuffers),
    containerUsedMiB: mib(readCgroupBytes("/sys/fs/cgroup/memory.current", readFile)),
    containerLimitMiB: mib(readCgroupBytes("/sys/fs/cgroup/memory.max", readFile)),
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
      logger.info?.("[Memory diagnostics]", sample());
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

module.exports = { INTERVAL_MS, mib, readCgroupBytes, sampleMemory, startMemoryDiagnostics };
