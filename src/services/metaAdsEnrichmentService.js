const attributionRepo = require("../db/leadAttributionRepo");
const metaAdsEnrichmentScheduleRepo = require("../db/metaAdsEnrichmentScheduleRepo");
const metaAdsInsightsRepo = require("../db/metaAdsInsightsRepo");
const metaAdsApi = require("./metaAdsApiService");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");

// Kept for configuration/backward compatibility. Normal operation no longer
// runs a periodic DB sweep: it sleeps until the next pending retry is due.
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MIN_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10;
const CONFIGURATION_ERROR_DELAY_MS = 60 * 60 * 1000;
const NON_RETRYABLE_ERROR_DELAY_MS = 24 * 60 * 60 * 1000;

function sweepIntervalMs() {
  const parsed = Number(process.env.META_AD_ENRICHMENT_SWEEP_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SWEEP_INTERVAL_MS;
  return Math.min(Math.max(Math.round(parsed), MIN_SWEEP_INTERVAL_MS), MAX_SWEEP_INTERVAL_MS);
}

function batchSize() {
  const parsed = Number(process.env.META_AD_ENRICHMENT_BATCH_SIZE);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, 25);
}

function retryDelayMs(attempts, err) {
  if (err?.configurationError) return CONFIGURATION_ERROR_DELAY_MS;
  if (err?.retryable === false) return NON_RETRYABLE_ERROR_DELAY_MS;
  const attempt = Math.max(1, Number(attempts) || 1);
  if (attempt <= 1) return 60 * 1000;
  if (attempt === 2) return 5 * 60 * 1000;
  if (attempt === 3) return 15 * 60 * 1000;
  if (attempt === 4) return 60 * 60 * 1000;
  if (attempt === 5) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function safeErrorText(err) {
  const message = String(err?.message || err || "Meta Ads enrichment failed.").trim();
  const code = err?.code != null ? ` [${err.code}]` : "";
  return `${message}${code}`.slice(0, 1000);
}

function delayUntilNextEnrichment(result) {
  if (!result?.nextDueAt) return null;
  const timestamp = Date.parse(result.nextDueAt);
  if (Number.isNaN(timestamp)) return MIN_SWEEP_INTERVAL_MS;
  return Math.max(1000, timestamp - Date.now());
}

function hierarchyToAdDetails(hierarchy, expectedAdId) {
  if (!hierarchy) return null;
  const expected = String(expectedAdId || "").trim();
  const details = {
    adId: String(hierarchy.ad_id || "").trim(),
    adName: String(hierarchy.ad_name || "").trim(),
    accountId: String(hierarchy.account_id || "").trim(),
    adsetId: String(hierarchy.adset_id || "").trim(),
    adsetName: String(hierarchy.adset_name || "").trim(),
    campaignId: String(hierarchy.campaign_id || "").trim(),
    campaignName: String(hierarchy.campaign_name || "").trim(),
  };

  if (
    !expected
    || details.adId !== expected
    || !details.adName
    || !details.accountId
    || !details.adsetId
    || !details.adsetName
    || !details.campaignId
    || !details.campaignName
  ) {
    return null;
  }
  return details;
}

function createMetaAdsEnrichmentService({
  repo = attributionRepo,
  api = metaAdsApi,
  hierarchyRepo,
  events = realtimeEvents,
  setImmediateImpl = setImmediate,
  logger = console,
  nextDueGetter,
} = {}) {
  let worker = null;
  let sweepRunning = false;
  let immediateSweepQueued = false;

  const getNextDue = typeof nextDueGetter === "function"
    ? nextDueGetter
    : repo === attributionRepo
      ? metaAdsEnrichmentScheduleRepo.getNextMetaEnrichmentDueAt
      : null;
  const hierarchySource = hierarchyRepo !== undefined
    ? hierarchyRepo
    : repo === attributionRepo
      ? metaAdsInsightsRepo
      : null;

  async function preloadAdDetails(rows) {
    if (typeof hierarchySource?.getLatestHierarchyForAdIds !== "function") {
      return new Map();
    }

    const adIds = [...new Set(
      (rows || [])
        .map((row) => String(row?.meta_ad_id || "").trim())
        .filter(Boolean)
    )];
    if (!adIds.length) return new Map();

    try {
      const hierarchyByAd = await hierarchySource.getLatestHierarchyForAdIds(adIds);
      const detailsByAd = new Map();
      for (const adId of adIds) {
        const details = hierarchyToAdDetails(hierarchyByAd?.get?.(adId), adId);
        if (details) detailsByAd.set(adId, details);
      }
      return detailsByAd;
    } catch (err) {
      logger.warn?.(
        `Meta Ads enrichment cache lookup failed; falling back to Meta API: ${safeErrorText(err)}`
      );
      return new Map();
    }
  }

  async function processClaimed(row, { detailsCache = null } = {}) {
    if (!row?.id || !row?.meta_ad_id) return { status: "skipped" };
    const adId = String(row.meta_ad_id);
    try {
      let cache = detailsCache;
      if (!cache) {
        cache = await preloadAdDetails([row]);
      }

      let details = cache.get(adId);
      if (!details) {
        details = await api.fetchAdDetails(adId);
        cache.set(adId, details);
      }
      const updated = await repo.markMetaEnrichmentSuccess(row.id, details);
      if (updated) {
        events.publish("pipeline_changed", {
          leadId: updated.lead_id,
          reason: "meta_ad_enriched",
        });
      }
      return { status: updated ? "enriched" : "stale", updated, details };
    } catch (err) {
      const delayMs = retryDelayMs(row.enrichment_attempts, err);
      await repo.markMetaEnrichmentDeferred(row.id, safeErrorText(err), delayMs);
      logger.warn?.(
        `Meta Ads enrichment deferred for ad ${row.meta_ad_id}: ${safeErrorText(err)}`
      );
      return {
        status: "deferred",
        configurationError: Boolean(err?.configurationError),
        delayMs,
        error: err,
      };
    }
  }

  async function enrichAttributionNow(attributionId) {
    if (!api.configured()) return { status: "not_configured" };
    const claimed = await repo.claimMetaEnrichmentById(attributionId);
    if (!claimed) return { status: "not_pending" };
    const result = await processClaimed(claimed);
    if (result.status === "deferred" && worker) {
      worker.wake(result.delayMs);
    }
    return result;
  }

  async function runSweep() {
    if (!api.configured()) return { status: "not_configured", processed: 0 };
    if (sweepRunning) return { status: "already_running", processed: 0 };
    sweepRunning = true;
    try {
      const claimed = await repo.claimMetaEnrichmentBatch(batchSize());
      const detailsCache = await preloadAdDetails(claimed);
      let processed = 0;
      let configurationError = false;

      for (let index = 0; index < claimed.length; index += 1) {
        const row = claimed[index];
        const result = await processClaimed(row, { detailsCache });
        processed += 1;

        // Token/permission failures are configuration-wide, not ad-specific.
        // Defer the rest of this claimed batch and also pause the worker for an
        // hour so unclaimed rows do not immediately hammer the same bad token.
        if (result.configurationError) {
          configurationError = true;
          for (const remaining of claimed.slice(index + 1)) {
            await repo.markMetaEnrichmentDeferred(
              remaining.id,
              "Meta Marketing API credentials or permissions need attention.",
              CONFIGURATION_ERROR_DELAY_MS
            );
          }
          break;
        }
      }

      let nextDueAt = null;
      if (configurationError) {
        nextDueAt = new Date(Date.now() + CONFIGURATION_ERROR_DELAY_MS).toISOString();
      } else if (typeof getNextDue === "function") {
        nextDueAt = await getNextDue();
      }

      return { status: "completed", processed, nextDueAt };
    } finally {
      sweepRunning = false;
    }
  }

  function queueAttributionEnrichment(attributionId) {
    if (!api.configured() || !attributionId) return false;
    if (immediateSweepQueued) return true;

    // Coalesce bursts of first-touch attributions into one wake. If startup has
    // not created the adaptive worker yet, retain the old direct-sweep fallback.
    immediateSweepQueued = true;
    const immediate = setImmediateImpl(async () => {
      immediateSweepQueued = false;
      try {
        if (worker) worker.wake(0);
        else await runSweep();
      } catch (err) {
        logger.error?.("Failed to run immediate Meta Ads enrichment sweep:", err);
      }
    });
    immediate?.unref?.();
    return true;
  }

  function start() {
    if (worker && !worker.state().stopped) return worker;
    if (!api.configured()) {
      logger.log?.(
        "Meta Ads enrichment is idle: META_MARKETING_ACCESS_TOKEN is not configured."
      );
      return null;
    }

    worker = createAdaptiveWorkerTimer({
      run: runSweep,
      delayForResult: delayUntilNextEnrichment,
      errorRetryDelayMs: MIN_SWEEP_INTERVAL_MS,
      label: "Meta Ads enrichment worker",
      logger,
    });
    worker.start();
    logger.log?.("Meta Ads enrichment worker started.");
    return worker;
  }

  return {
    enrichAttributionNow,
    processClaimed,
    queueAttributionEnrichment,
    runSweep,
    start,
  };
}

const service = createMetaAdsEnrichmentService();

module.exports = {
  CONFIGURATION_ERROR_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SWEEP_INTERVAL_MS,
  NON_RETRYABLE_ERROR_DELAY_MS,
  batchSize,
  createMetaAdsEnrichmentService,
  delayUntilNextEnrichment,
  hierarchyToAdDetails,
  retryDelayMs,
  safeErrorText,
  sweepIntervalMs,
  ...service,
};
