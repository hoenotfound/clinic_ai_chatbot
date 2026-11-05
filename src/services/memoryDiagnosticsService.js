"use strict";

// Low-overhead, aggregate-only memory diagnostics for Render. We need both
// Node heap and container usage to distinguish JS retention from large buffers
// or native allocations. No request body, contact, phone or message is logged.
const { readFileSync } = require("node:fs");
const { takeOutboundPayloadSnapshot } = require("../utils/outboundPayloadDiagnostics");
const { takeWorkerActivity } = require("../utils/workerActivityMetrics");
const { snapshot: getWakeDiagnostics } = require("../utils/refreshWakeDiagnostics");

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
  wakeSnapshot = getWakeDiagnostics,
} = {}) {
  if (timer || env.DA_MEMORY_DIAGNOSTICS_ENABLED === "false") return timer;
  if (!env.RENDER_SERVICE_ID && env.DA_MEMORY_DIAGNOSTICS_ENABLED !== "true") return null;
  let samples = 0;
  const log = () => {
    try {
      // Piggyback on the existing timer every fifth minute. No extra jobs,
      // network, SQL or customer data. Keep Render log output compact.
      samples++;
      logger.info?.("[Memory diagnostics]", {
        ...sample(), workers: takeWorkerActivity(),
      });
      if (samples % 5 === 0) {
        const wake = wakeSnapshot();
        // Emit one compact JSON string instead of a nested object: Node's
        // util.inspect collapses nested arrays into [Object] in Render logs.
        // This uses fixed-category counters only. No IDs, event payloads,
        // customer content, network activity or database access.
        const summary = {
          last5Minutes: wake.last5Minutes,
          last15Minutes: wake.last15Minutes,
          top: wake.counters
            .filter(item => item.last5Minutes > 0)
            .sort((a, b) => b.last5Minutes - a.last5Minutes || a.key.localeCompare(b.key))
            .slice(0, 8)
            .map(item => ({ key: item.key, count: item.last5Minutes })),
        };
        logger.info?.(`[Refresh/wake diagnostics] ${JSON.stringify(summary)}`);
        if (env.DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED === "true") {
          logger.info?.(`[Outbound payload diagnostics] ${JSON.stringify(takeOutboundPayloadSnapshot())}`);
        }
      }
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
