const { bootstrapAdminUser } = require("../db/bootstrapAdmin");
const configRepo = require("../db/configRepo");
const followUpMediaReferencesRepo = require("../db/followUpMediaReferencesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const { initSchema } = require("../db/db");
const { startAutomatedFollowUps } = require("./followUpService");
const { start: startWhatsAppFreeEntryFollowUps } = require("./whatsappFreeEntryFollowUpService");
const { start: startSecondaryFollowUps } = require("./whatsappSecondaryFollowUpService");
const { startLeadScoring } = require("./leadScoringService");
const { startStaffWaitingAlerts } = require("./staffWaitingAlertService");
const {
  startTelegramImmediateAlertRecovery,
} = require("./telegramImmediateAlertService");
const {
  startInboundProcessingRecovery,
} = require("./inboundProcessingService");
const {
  startWhatsAppDeliveryStatusRecovery,
} = require("./whatsappDeliveryStatusService");
const {
  startWhatsappOutboundRetryWorker,
} = require("./whatsappOutboundRetryService");
const metaCommentAutomation = require("./metaCommentAutomationService");
const { start: startMetaAdsInsightsSync } = require("./metaAdsInsightsSyncService");
const {
  startScheduledMessageWorker,
} = require("./scheduledMessageBootstrap");
const startupReadiness = require("./startupReadinessService");
const { assertStoredSenderSafety } = require("./whatsappSenderActivationGate");
const mediaStorage = require("./mediaStorageService");
const whatsappResultMediaQueue = require("./whatsappResultMediaQueue");
const secondaryAiMediaQueue = require("./whatsappSecondaryAiMediaQueue");
const coexistenceMediaQueue = require("./whatsappCoexistenceMediaService");
const coexistenceMutations = require("./whatsappCoexistenceMutationService");
const coexistenceHistory = require("./whatsappCoexistenceHistoryService");
const {
  startCustomerDataLifecycle,
} = require("./customerDataLifecycleService");
const {
  closeHttpServer,
  listenHttpServer,
} = require("./httpServerStartup");

const PROMO_IMAGE_PRUNE_INTERVAL_MS = 30 * 60 * 1000;
const TEMP_MEDIA_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function configuredFollowUpVideoKeys() {
  const followUp = configRepo.getConfig()?.automatedFollowUp;
  if (!followUp || typeof followUp !== "object") return [];
  const steps = [
    followUp,
    ...(Array.isArray(followUp.additionalSteps) ? followUp.additionalSteps : []),
  ];
  return [
    ...new Set(
      steps.flatMap((step) => [
        String(step?.videoKey || "").trim(),
        ...Object.values(step?.voiceNotes || {}).flatMap(note => [String(note?.key || ""), String(note?.previewKey || "")]),
        ...(Array.isArray(step?.serviceOverrides)
          ? step.serviceOverrides.flatMap((item) => [
              String(item?.videoKey || "").trim(),
              ...Object.values(item?.voiceNotes || {}).flatMap(note => [String(note?.key || ""), String(note?.previewKey || "")]),
            ])
          : []),
      ]).filter(Boolean)
    ),
  ];
}

async function pruneStaleTemporaryMediaSafely() {
  const [temporaryResult, followUpVideoResult] = await Promise.allSettled([
    mediaStorage.pruneStaleTemporaryMedia(),
    (async () => {
      const referencedKeys = await followUpMediaReferencesRepo.listReferencedFollowUpConfigVideoKeys();
      return mediaStorage.pruneStaleFollowUpConfigVideos({
        referencedKeys: [...new Set([...configuredFollowUpVideoKeys(), ...referencedKeys])],
      });
    })(),
  ]);

  if (temporaryResult.status === "fulfilled") {
    if (temporaryResult.value > 0) {
      console.log(
        `Pruned ${temporaryResult.value} stale temporary Meta media object(s).`
      );
    }
  } else {
    console.error(
      "Failed to prune stale temporary Meta media:",
      temporaryResult.reason
    );
  }

  if (followUpVideoResult.status === "fulfilled") {
    if (followUpVideoResult.value > 0) {
      console.log(
        `Pruned ${followUpVideoResult.value} stale follow-up video object(s).`
      );
    }
  } else {
    console.error(
      "Failed to prune stale follow-up videos:",
      followUpVideoResult.reason
    );
  }
}

async function startApplication({
  app,
  port,
  processIncomingBatch,
  setIntervalFn = setInterval,
} = {}) {
  if (!app) throw new Error("startApplication requires app.");
  if (typeof processIncomingBatch !== "function") {
    throw new Error("startApplication requires processIncomingBatch.");
  }

  console.log(
    `[Startup] Opening HTTP server on 0.0.0.0:${port} before initialization...`
  );
  const server = await listenHttpServer(app, { port });

  try {
    console.log("[Startup] Initializing database schema and migrations...");
    await initSchema();
    console.log("[Startup] Database schema and migrations ready.");

    // Before readiness or recovery workers, reject unverified primary identity
    // and unsafe feature-flag rollback with persisted secondary contacts.
    await assertStoredSenderSafety();

    console.log("[Startup] Loading client configuration...");
    await configRepo.loadConfig();
    console.log("[Startup] Client configuration loaded.");

    console.log("[Startup] Backfilling existing conversations into the lead pipeline...");
    const backfilledLeadCount = await pipelineRepo.backfillLeadsForExistingContacts();
    console.log(
      `[Startup] Lead pipeline backfill complete (${backfilledLeadCount} conversation(s) added).`
    );
    if (backfilledLeadCount > 0) {
      console.log(
        `Added ${backfilledLeadCount} existing conversation(s) to the lead pipeline.`
      );
    }

    console.log("[Startup] Bootstrapping admin user...");
    await bootstrapAdminUser();
    console.log("[Startup] Admin user bootstrap complete.");

    if (process.env.PR395_STAGING_MODE === "true") {
      // This public sandbox can be backed by a production-derived QA snapshot.
      // Never run inherited reminder, AI, retry, media, pruning, outreach or
      // customer-data lifecycle jobs against copied customer records.
      console.log("[PR395 staging] All background workers disabled.");
    } else {
    console.log("[Startup] Starting maintenance and recovery workers...");
    configRepo.pruneOrphanedPromoImages();
    setIntervalFn(
      configRepo.pruneOrphanedPromoImages,
      PROMO_IMAGE_PRUNE_INTERVAL_MS
    );
    // Do not sweep R2 immediately after every deploy. The first periodic sweep
    // happens after the interval, keeping the startup/hot-deploy window free
    // for live customer media traffic.
    const tempMediaPruneTimer = setIntervalFn(
      pruneStaleTemporaryMediaSafely,
      TEMP_MEDIA_PRUNE_INTERVAL_MS
    );
    tempMediaPruneTimer?.unref?.();

    startInboundProcessingRecovery({ processBatch: processIncomingBatch });
    startWhatsAppDeliveryStatusRecovery();
    whatsappResultMediaQueue.start();
    secondaryAiMediaQueue.start();
    coexistenceMediaQueue.start();
    coexistenceMutations.start();
    coexistenceHistory.start();
    startWhatsappOutboundRetryWorker();
    startTelegramImmediateAlertRecovery();
    startScheduledMessageWorker();
    startCustomerDataLifecycle({ setIntervalFn });
    startAutomatedFollowUps();
    startWhatsAppFreeEntryFollowUps();
    // No Ariel followup scheduler starts unless explicitly enabled, and
    // sender-specific rules have no default enabled entries.
    startSecondaryFollowUps();
    startStaffWaitingAlerts();
    startLeadScoring();
    metaCommentAutomation.startRecovery();
    startMetaAdsInsightsSync();
    console.log("[Startup] Maintenance and recovery workers started.");
    }

    startupReadiness.markReady();
    console.log(
      "[Startup] Service initialization complete; readiness checks are passing."
    );
    return server;
  } catch (err) {
    startupReadiness.markFailed();
    await closeHttpServer(server);
    throw err;
  }
}

module.exports = {
  PROMO_IMAGE_PRUNE_INTERVAL_MS,
  TEMP_MEDIA_PRUNE_INTERVAL_MS,
  pruneStaleTemporaryMediaSafely,
  startApplication,
};
