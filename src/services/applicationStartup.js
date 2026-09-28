const { bootstrapAdminUser } = require("../db/bootstrapAdmin");
const configRepo = require("../db/configRepo");
const pipelineRepo = require("../db/pipelineRepo");
const { initSchema } = require("../db/db");
const { startAutomatedFollowUps } = require("./followUpService");
const { startLeadScoring } = require("./leadScoringService");
const { startStaffWaitingAlerts } = require("./staffWaitingAlertService");
const {
  startInboundProcessingRecovery,
} = require("./inboundProcessingService");
const {
  startWhatsAppDeliveryStatusRecovery,
} = require("./whatsappDeliveryStatusService");
const metaCommentAutomation = require("./metaCommentAutomationService");
const startupReadiness = require("./startupReadinessService");
const {
  closeHttpServer,
  listenHttpServer,
} = require("./httpServerStartup");

const PROMO_IMAGE_PRUNE_INTERVAL_MS = 30 * 60 * 1000;

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

    console.log("[Startup] Starting maintenance and recovery workers...");
    configRepo.pruneOrphanedPromoImages();
    setIntervalFn(
      configRepo.pruneOrphanedPromoImages,
      PROMO_IMAGE_PRUNE_INTERVAL_MS
    );

    startInboundProcessingRecovery({ processBatch: processIncomingBatch });
    startWhatsAppDeliveryStatusRecovery();
    startAutomatedFollowUps();
    startStaffWaitingAlerts();
    startLeadScoring();
    metaCommentAutomation.startRecovery();
    console.log("[Startup] Maintenance and recovery workers started.");

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
  startApplication,
};
