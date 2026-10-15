"use strict";

// Passive instrumentation only: node-postgres emits events when real work is
// acquiring a connection. No timers, queries, migrations or user data.
const { pool } = require("../db/db");
const {
  UNATTRIBUTED_SOURCE,
  currentDatabaseActivitySource,
} = require("../utils/databaseActivityContext");

const MAX_SOURCES = 32;
const WINDOW_MINUTES = 60;

function createPoolActivityTracker(database, { now = Date.now } = {}) {
  let acquiredTotal = 0;
  let connectedTotal = 0;
  let removedTotal = 0;
  let lastAcquireAt = null;
  // Each bucket is one minute. Pruning is triggered by normal acquisitions
  // and snapshots, never by an independent timer or database query.
  const perMinute = new Map();
  const totalsBySource = new Map();

  function prune(minute) {
    for (const key of perMinute.keys()) {
      if (key <= minute - WINDOW_MINUTES) perMinute.delete(key);
    }
  }

  database.on("acquire", () => {
    const time = now();
    const minute = Math.floor(time / 60_000);
    let source = currentDatabaseActivitySource();
    if (!totalsBySource.has(source) && totalsBySource.size >= MAX_SOURCES - 1) {
      source = UNATTRIBUTED_SOURCE;
    }
    acquiredTotal += 1;
    lastAcquireAt = time;
    totalsBySource.set(source, (totalsBySource.get(source) || 0) + 1);
    const bucket = perMinute.get(minute) || { total: 0, sources: new Map() };
    bucket.total += 1;
    bucket.sources.set(source, (bucket.sources.get(source) || 0) + 1);
    perMinute.set(minute, bucket);
    prune(minute);
  });
  database.on("connect", () => { connectedTotal += 1; });
  database.on("remove", () => { removedTotal += 1; });

  function snapshot() {
    const timestamp = now();
    const minute = Math.floor(timestamp / 60_000);
    prune(minute);
    let last5Minutes = 0;
    let last15Minutes = 0;
    const recentBySource = new Map();
    for (const [key, bucket] of perMinute) {
      const in5 = key > minute - 5 && key <= minute;
      const in15 = key > minute - 15 && key <= minute;
      if (in5) last5Minutes += bucket.total;
      if (in15) last15Minutes += bucket.total;
      if (!in15) continue;
      for (const [source, count] of bucket.sources) {
        const row = recentBySource.get(source) || { last5Minutes: 0, last15Minutes: 0 };
        row.last15Minutes += count;
        if (in5) row.last5Minutes += count;
        recentBySource.set(source, row);
      }
    }
    const bySource = [...totalsBySource.entries()]
      .map(([source, total]) => ({
        source,
        acquiredTotal: total,
        last5Minutes: recentBySource.get(source)?.last5Minutes || 0,
        last15Minutes: recentBySource.get(source)?.last15Minutes || 0,
      }))
      .sort((a, b) => b.last15Minutes - a.last15Minutes || b.acquiredTotal - a.acquiredTotal)
      .slice(0, MAX_SOURCES);

    return {
      observedSinceProcessStart: true,
      acquiredTotal,
      connectedTotal,
      removedTotal,
      last5Minutes,
      last15Minutes,
      lastAcquireAt: lastAcquireAt === null ? null : new Date(lastAcquireAt).toISOString(),
      openConnections: database.totalCount,
      idleConnections: database.idleCount,
      waitingForConnection: database.waitingCount,
      bySource,
    };
  }

  return { snapshot };
}

const activity = createPoolActivityTracker(pool);
function getPoolActivitySnapshot() {
  return activity.snapshot();
}

module.exports = { createPoolActivityTracker, getPoolActivitySnapshot };
