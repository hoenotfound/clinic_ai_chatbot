const { randomUUID } = require("node:crypto");
const repo = require("../db/metaAdsInsightsRepo");
const api = require("./metaAdsInsightsApiService");
const { marketingAccessToken } = require("./metaAdsApiService");

const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_LEASE_MS = 30 * 60 * 1000;
const MIN_SYNC_LEASE_MS = 5 * 60 * 1000;
const MAX_SYNC_LEASE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RECENT_DAYS = 3;
const DEFAULT_BACKFILL_DAYS = 90;
const MAX_BACKFILL_DAYS = 366;
const DEFAULT_BACKFILL_CHUNK_DAYS = 30;
const MAX_BACKFILL_CHUNK_DAYS = 90;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function syncIntervalMs(env = process.env) {
  return boundedInteger(
    env.META_AD_INSIGHTS_SYNC_MS,
    DEFAULT_SYNC_INTERVAL_MS,
    MIN_SYNC_INTERVAL_MS,
    MAX_SYNC_INTERVAL_MS
  );
}

function syncLeaseMs(env = process.env) {
  return boundedInteger(
    env.META_AD_INSIGHTS_LEASE_MS,
    DEFAULT_SYNC_LEASE_MS,
    MIN_SYNC_LEASE_MS,
    MAX_SYNC_LEASE_MS
  );
}

function recentDays(env = process.env) {
  return boundedInteger(env.META_AD_INSIGHTS_RECENT_DAYS, DEFAULT_RECENT_DAYS, 1, 14);
}

function backfillDays(env = process.env) {
  return boundedInteger(
    env.META_AD_INSIGHTS_BACKFILL_DAYS,
    DEFAULT_BACKFILL_DAYS,
    1,
    MAX_BACKFILL_DAYS
  );
}

function backfillChunkDays(env = process.env) {
  return boundedInteger(
    env.META_AD_INSIGHTS_BACKFILL_CHUNK_DAYS,
    DEFAULT_BACKFILL_CHUNK_DAYS,
    1,
    MAX_BACKFILL_CHUNK_DAYS
  );
}

function configuredAccountIds(env = process.env) {
  const raw = [
    env.META_AD_ACCOUNT_IDS,
    env.META_AD_ACCOUNT_ID,
  ].filter(Boolean).join(",");
  return [...new Set(
    raw
      .split(/[\n,]/)
      .map((value) => String(value || "").trim().replace(/^act_/i, ""))
      .filter((value) => /^\d+$/.test(value))
  )];
}

function dateInTimeZone(
  date = new Date(),
  timeZone = process.env.CLINIC_TIMEZONE || "Asia/Kuala_Lumpur"
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRangeForDays(today, days) {
  return {
    since: shiftDate(today, -(Math.max(1, days) - 1)),
    until: today,
  };
}

function chunkEnd(start, overallUntil, days) {
  const candidate = shiftDate(start, Math.max(1, days) - 1);
  return candidate > overallUntil ? overallUntil : candidate;
}

function safeErrorText(err) {
  const code = err?.code != null ? ` [${err.code}]` : "";
  return `${String(err?.message || err || "Meta Ads Insights sync failed.").trim()}${code}`.slice(0, 1000);
}

function createMetaAdsInsightsSyncService({
  insightsRepo = repo,
  insightsApi = api,
  tokenGetter = marketingAccessToken,
  accountIdsGetter = configuredAccountIds,
  leaseTokenFactory = randomUUID,
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  let timer = null;
  let running = false;
  let stopped = true;

  function configured() {
    return Boolean(String(tokenGetter() || "").trim()) && accountIdsGetter().length > 0;
  }

  async function syncAccount(accountId) {
    const leaseToken = leaseTokenFactory();
    const leaseMs = syncLeaseMs();
    const acquired = await insightsRepo.tryAcquireSyncLease(
      accountId,
      leaseToken,
      leaseMs
    );
    if (!acquired) {
      return {
        status: "locked",
        accountId,
        rows: 0,
      };
    }

    let activeSince = null;
    let activeUntil = null;

    try {
      const state = await insightsRepo.getSyncState(accountId);
      const today = dateInTimeZone(now());
      const fullRange = dateRangeForDays(today, backfillDays());
      const recentRange = dateRangeForDays(today, recentDays());
      const coverageStart = dateOnly(state?.coverage_start_date);
      const coverageEnd = dateOnly(state?.coverage_end_date);
      const latestContiguousDayBeforeRecent = shiftDate(recentRange.since, -1);
      const needsBackfill = (
        !state?.last_backfill_completed_at
        || !coverageStart
        || !coverageEnd
        || coverageStart > fullRange.since
        || coverageEnd < latestContiguousDayBeforeRecent
      );

      if (needsBackfill) {
        const savedNext = dateOnly(state?.backfill_next_date);
        const canResume = (
          !state?.last_backfill_completed_at
          && savedNext
          && savedNext >= fullRange.since
          && savedNext <= fullRange.until
          && coverageStart === fullRange.since
        );
        let nextDate = canResume ? savedNext : fullRange.since;
        if (!canResume) {
          await insightsRepo.resetBackfillCoverage(
            accountId,
            fullRange.since,
            leaseToken
          );
        }
        let totalRows = 0;

        while (nextDate <= fullRange.until) {
          activeSince = nextDate;
          activeUntil = chunkEnd(
            nextDate,
            fullRange.until,
            backfillChunkDays()
          );

          const leaseRenewed = await insightsRepo.renewSyncLease(
            accountId,
            leaseToken,
            leaseMs
          );
          if (!leaseRenewed) {
            const err = new Error("Meta Ads Insights sync lease expired during backfill.");
            err.code = "SYNC_LEASE_LOST";
            throw err;
          }

          await insightsRepo.markSyncStarted(
            accountId,
            activeSince,
            activeUntil,
            leaseToken
          );

          const rows = await insightsApi.fetchAdInsights(accountId, {
            since: activeSince,
            until: activeUntil,
          });
          await insightsRepo.replaceInsightsRange(
            accountId,
            activeSince,
            activeUntil,
            rows
          );
          totalRows += rows.length;

          const followingDate = shiftDate(activeUntil, 1);
          if (followingDate <= fullRange.until) {
            await insightsRepo.markBackfillProgress(
              accountId,
              activeSince,
              activeUntil,
              followingDate,
              leaseToken
            );
            nextDate = followingDate;
            continue;
          }

          await insightsRepo.markSyncSuccess(
            accountId,
            fullRange.since,
            fullRange.until,
            leaseToken,
            { backfillCompleted: true }
          );
          logger.log?.(
            `Meta Ads Insights backfilled ${totalRows} daily ad row(s) for account ${accountId} (${fullRange.since} to ${fullRange.until}).`
          );
          return {
            status: "synced",
            accountId,
            rows: totalRows,
            since: fullRange.since,
            until: fullRange.until,
            backfill: true,
          };
        }
      }

      const { since, until } = recentRange;
      activeSince = since;
      activeUntil = until;

      await insightsRepo.markSyncStarted(accountId, since, until, leaseToken);
      const rows = await insightsApi.fetchAdInsights(accountId, { since, until });
      await insightsRepo.replaceInsightsRange(accountId, since, until, rows);
      await insightsRepo.markSyncSuccess(
        accountId,
        since,
        until,
        leaseToken,
        { backfillCompleted: false }
      );
      logger.log?.(
        `Meta Ads Insights synced ${rows.length} daily ad row(s) for account ${accountId} (${since} to ${until}).`
      );
      return {
        status: "synced",
        accountId,
        rows: rows.length,
        since,
        until,
        backfill: false,
      };
    } catch (err) {
      if (activeSince && activeUntil) {
        await insightsRepo.markSyncFailure(
          accountId,
          activeSince,
          activeUntil,
          safeErrorText(err),
          leaseToken
        ).catch(() => false);
      } else {
        await insightsRepo.releaseSyncLease(accountId, leaseToken).catch(() => false);
      }

      logger.warn?.(
        `Meta Ads Insights sync failed for account ${accountId}: ${safeErrorText(err)}`
      );
      return {
        status: "failed",
        accountId,
        error: err,
        configurationError: Boolean(err?.configurationError),
        since: activeSince,
        until: activeUntil,
        backfill: null,
      };
    }
  }

  async function runOnce() {
    if (!configured()) return { status: "not_configured", accounts: [], rows: 0 };
    if (running) return { status: "already_running", accounts: [], rows: 0 };

    running = true;
    try {
      const results = [];
      let rows = 0;
      for (const accountId of accountIdsGetter()) {
        const result = await syncAccount(accountId);
        results.push(result);
        rows += result.rows || 0;
        if (result.configurationError) break;
      }
      return { status: "completed", accounts: results, rows };
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeoutFn(async () => {
      timer = null;
      try {
        await runOnce();
      } catch (err) {
        logger.error?.("Meta Ads Insights worker failed:", err);
      } finally {
        schedule(syncIntervalMs());
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start() {
    if (!configured()) {
      logger.log?.(
        "Meta Ads Insights sync is idle: configure META_MARKETING_ACCESS_TOKEN and META_AD_ACCOUNT_ID(S)."
      );
      return null;
    }
    if (!stopped) return { stop };
    stopped = false;
    schedule(0);
    logger.log?.("Meta Ads Insights sync worker started.");
    return { stop };
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return {
    configured,
    runOnce,
    start,
    stop,
    syncAccount,
  };
}

const service = createMetaAdsInsightsSyncService();

module.exports = {
  DEFAULT_BACKFILL_CHUNK_DAYS,
  DEFAULT_BACKFILL_DAYS,
  DEFAULT_RECENT_DAYS,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_SYNC_LEASE_MS,
  MAX_BACKFILL_DAYS,
  backfillChunkDays,
  backfillDays,
  chunkEnd,
  configuredAccountIds,
  createMetaAdsInsightsSyncService,
  dateInTimeZone,
  dateOnly,
  dateRangeForDays,
  recentDays,
  safeErrorText,
  shiftDate,
  syncIntervalMs,
  syncLeaseMs,
  ...service,
};
