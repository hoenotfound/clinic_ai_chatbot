const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const whatsappCoexistence = require("./services/whatsappCoexistenceService");
const metaMessaging = require("./services/metaMessagingService");
const metaStaffEcho = require("./services/metaStaffEchoService");
const metaCommentAutomation = require("./services/metaCommentAutomationService");
const {
  processStoredDeliveryStatuses,
  storeDeliveryStatusUpdates,
} = require("./services/whatsappDeliveryStatusService");
const setupStatusRepo = require("./db/setupStatusRepo");
const promoImagesRepo = require("./db/promoImagesRepo");
const messagesRepo = require("./db/messagesRepo");
const realtimeEvents = require("./utils/realtimeEvents");
const { verifyWebhookSignature } = require("./middleware/verifyWebhookSignature");
const { verifyMetaWebhookSignature } = require("./middleware/verifyMetaWebhookSignature");
const {
  createAdvancedConfigJsonParser,
  createPortalJsonParser,
  createWebhookJsonParser,
  payloadTooLargeErrorHandler,
} = require("./middleware/requestBodyLimits");
const {
  applyPortalSecurityHeaders,
  buildPortalSessionOptions,
  enforcePortalRequestOrigin,
} = require("./middleware/portalSecurity");
const { requireAuth } = require("./middleware/requireAuth");
const { resolveTrustProxy } = require("./utils/proxyTrust");
const { verifyTokenMatches } = require("./utils/webhookVerification");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const configRoutes = require("./routes/config");
const advancedConfigRoutes = require("./routes/advancedConfig");
const contactsRoutes = require("./routes/contacts");
const pipelineRoutes = require("./routes/pipeline");
const setupStatusRoutes = require("./routes/setupStatus");
const whatsappCoexistenceOnboardingRoutes = require("./routes/whatsappCoexistenceOnboarding");
const goLiveRoutes = require("./routes/goLive");
const pushNotificationsRoutes = require("./routes/pushNotifications");
const opsReadinessRoutes = require("./routes/opsReadiness");
const startupReadiness = require("./services/startupReadinessService");

function createApp({
  sessionSecret,
  durablyClaimIncoming,
  scheduleDurableClaim,
  queueIncomingForReply,
} = {}) {
  if (!sessionSecret) {
    throw new Error("createApp requires sessionSecret.");
  }
  if (typeof durablyClaimIncoming !== "function") {
    throw new Error("createApp requires durablyClaimIncoming.");
  }
  if (typeof scheduleDurableClaim !== "function") {
    throw new Error("createApp requires scheduleDurableClaim.");
  }
  if (typeof queueIncomingForReply !== "function") {
    throw new Error("createApp requires queueIncomingForReply.");
  }

  const app = express();
  app.disable("x-powered-by");

  // Trust only the known proxy hop count. On Render this defaults to one hop,
  // which keeps req.protocol/req.ip correct without trusting arbitrary
  // leftmost X-Forwarded-For values supplied by clients.
  app.set("trust proxy", resolveTrustProxy(process.env));
  app.use(applyPortalSecurityHeaders);

  // Webhooks need the raw body in the verify hook so Meta signatures are
  // validated against the exact bytes received.
  const webhookJsonParser = createWebhookJsonParser(verifyWebhookSignature);
  const metaWebhookJsonParser = createWebhookJsonParser(verifyMetaWebhookSignature);
  const portalJsonParser = createPortalJsonParser();
  const advancedConfigJsonParser = createAdvancedConfigJsonParser();

  // Portal API: reject browser cross-origin mutations before parsing bodies,
  // then apply normal JSON parsing + signed session cookies for staff login.
  // Advanced Config alone gets a larger body budget because detailed service,
  // FAQ and AI instruction JSON can legitimately exceed the normal portal cap.
  app.use("/api", enforcePortalRequestOrigin);
  app.use("/api", (req, res, next) => {
    const parser = req.path === "/advanced-config" || req.path.startsWith("/advanced-config/")
      ? advancedConfigJsonParser
      : portalJsonParser;
    return parser(req, res, next);
  });
  app.use(
    "/api",
    cookieSession(buildPortalSessionOptions(sessionSecret, process.env))
  );

  // Keep "/" as the Render-compatible readiness check for existing deployments.
  app.get("/", startupReadiness.rootReadinessHandler);
  app.get("/health/live", startupReadiness.livenessHandler);
  app.get("/health/ready", startupReadiness.readinessHandler);

  // The socket opens before database/config initialization so Render can detect
  // the port, but customer/API traffic stays blocked until startup is complete.
  app.use(startupReadiness.requireReady);

  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && verifyTokenMatches(token, process.env.WHATSAPP_VERIFY_TOKEN)) {
      console.log("WhatsApp webhook verified successfully.");
      return res.status(200).send(challenge);
    }

    console.warn("WhatsApp webhook verification failed — token mismatch.");
    return res.sendStatus(403);
  });

  app.post("/webhook", webhookJsonParser, async (req, res) => {
    const incomingMessages = whatsapp.parseIncomingMessages(req.body);
    const reactionEvents = whatsapp.parseReactionEvents(req.body);
    const businessAppEchoes = whatsapp.parseBusinessAppEchoes(req.body);
    const statusUpdates = whatsapp.parseStatusUpdates(req.body);
    const passiveSync = whatsappCoexistence.summarizePassiveSync(req.body);
    for (const echo of businessAppEchoes) {
      whatsappCoexistence.beginPendingAiForEcho(echo);
    }

    let durableClaims;
    let durableStatusJobs;
    let durableBusinessAppEchoes;
    let durableReactionUpdates;
    try {
      [durableClaims, durableStatusJobs, durableBusinessAppEchoes, durableReactionUpdates] = await Promise.all([
        Promise.all(
          incomingMessages.map(async (incoming) => ({
            queueKey: incoming.from,
            durableClaim: await durablyClaimIncoming(incoming.from, incoming),
          }))
        ),
        storeDeliveryStatusUpdates(statusUpdates),
        Promise.all(
          businessAppEchoes.map((echo) =>
            whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true })
          )
        ),
        Promise.all(
          reactionEvents.map((reaction) =>
            messagesRepo.applyWhatsappReaction(reaction)
          )
        ),
      ]);
    } catch (err) {
      for (const echo of businessAppEchoes) {
        whatsappCoexistence.releasePendingAiForEcho(echo);
      }
      console.error("Failed to durably accept WhatsApp webhook work:", err);
      return res.sendStatus(503);
    }

    for (const persisted of durableBusinessAppEchoes) {
      if (!persisted) continue;
      await whatsappCoexistence.finalizeBusinessAppEcho(persisted);
    }

    for (const update of durableReactionUpdates) {
      if (
        !update ||
        update.pending === true ||
        update.changed === false ||
        update.contactId == null ||
        update.messageId == null ||
        !Array.isArray(update.reactions)
      ) {
        continue;
      }
      realtimeEvents.publish("conversation_changed", {
        contactId: update.contactId,
        messageId: update.messageId,
        reactions: update.reactions,
        reason: "reaction",
      });
    }

    res.sendStatus(200);

    if (passiveSync.historyChunks || passiveSync.appStateItems) {
      console.log(
        `Acknowledged WhatsApp coexistence sync event without operational import: history=${passiveSync.historyChunks}, app_state=${passiveSync.appStateItems}`
      );
    }

    setupStatusRepo.recordWebhook("whatsapp_webhook").catch((err) => {
      console.error("Failed to record WhatsApp webhook activity:", err);
    });
    for (const { queueKey, durableClaim } of durableClaims) {
      scheduleDurableClaim(queueKey, durableClaim).catch((err) => {
        console.error("Failed to schedule durable WhatsApp inbound work:", err);
      });
    }

    processStoredDeliveryStatuses(durableStatusJobs).catch((err) => {
      console.error("Failed to schedule durable WhatsApp delivery-status work:", err);
    });
  });

  app.get("/meta-webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && verifyTokenMatches(token, process.env.META_VERIFY_TOKEN)) {
      console.log("Facebook/Instagram webhook verified successfully.");
      return res.status(200).send(challenge);
    }

    console.warn("Facebook/Instagram webhook verification failed — token mismatch.");
    return res.sendStatus(403);
  });

  app.post("/meta-webhook", metaWebhookJsonParser, async (req, res) => {
    const incomingMessages = metaMessaging.parseIncomingMessages(req.body);
    const staffEchoes = metaMessaging.parseStaffEchoes(req.body);
    for (const echo of staffEchoes) {
      metaStaffEcho.beginPendingAiForEcho(echo);
    }

    let durableClaims;
    let commentJobs;
    let durableStaffEchoes;
    try {
      [durableClaims, commentJobs, durableStaffEchoes] = await Promise.all([
        Promise.all(
          incomingMessages.map(async (incoming) => {
            const queueKey = `${incoming.channel}:${incoming.from}`;
            return {
              queueKey,
              durableClaim: await durablyClaimIncoming(queueKey, incoming),
            };
          })
        ),
        metaCommentAutomation.acceptIncomingComments(req.body),
        Promise.all(
          staffEchoes.map((echo) =>
            metaStaffEcho.persistStaffEcho(echo, { pendingStarted: true })
          )
        ),
      ]);
    } catch (err) {
      for (const echo of staffEchoes) {
        metaStaffEcho.releasePendingAiForEcho(echo);
      }
      console.error("Failed to durably accept incoming Meta event(s):", err);
      return res.sendStatus(503);
    }

    for (const persisted of durableStaffEchoes) {
      if (!persisted) continue;
      await metaStaffEcho.finalizeStaffEcho(persisted);
    }

    res.sendStatus(200);
    setupStatusRepo.recordWebhook("meta_webhook").catch((err) => {
      console.error("Failed to record Meta webhook activity:", err);
    });

    for (const { queueKey, durableClaim } of durableClaims) {
      scheduleDurableClaim(queueKey, durableClaim).catch((err) => {
        console.error("Failed to schedule durable Meta inbound work:", err);
      });
    }

    for (const job of commentJobs || []) {
      metaCommentAutomation.scheduleJob(job.id).catch((err) => {
        console.error("Failed to schedule Meta comment automation work:", err);
      });
    }

    metaMessaging.resolveMessageEditEvents(req.body)
      .then((resolvedEditMessages) => Promise.all(
        resolvedEditMessages.map((incoming) =>
          queueIncomingForReply(
            `${incoming.channel}:${incoming.from}`,
            incoming
          )
        )
      ))
      .catch((err) => {
        console.error("Failed to process Meta message-edit event(s):", err);
      });
  });

  app.get("/promo-images/:id", async (req, res) => {
    try {
      const image = await promoImagesRepo.getPublicImage(req.params.id);
      if (!image) return res.status(404).send("Not found");

      res.set("Content-Type", image.mime_type);
      res.set("Cache-Control", "public, max-age=3600");
      res.set("X-Content-Type-Options", "nosniff");
      res.send(Buffer.from(image.data, "base64"));
    } catch (err) {
      console.error("Failed to serve promo image:", err);
      res.status(500).send("Something went wrong.");
    }
  });

  // Read-only machine endpoint for the separate Ops Registry. This intentionally
  // bypasses portal sessions and has its own bearer-token guard.
  app.use("/api/ops/readiness", opsReadinessRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/conversations", requireAuth, conversationsRoutes);
  app.use("/api/config", requireAuth, configRoutes);
  app.use("/api/advanced-config", requireAuth, advancedConfigRoutes);
  app.use("/api/contacts", requireAuth, contactsRoutes);
  app.use("/api/pipeline", requireAuth, pipelineRoutes);
  app.use("/api/setup-status", requireAuth, setupStatusRoutes);
  app.use(
    "/api/whatsapp-coexistence/onboarding",
    requireAuth,
    whatsappCoexistenceOnboardingRoutes
  );
  app.use("/api/go-live", requireAuth, goLiveRoutes);
  app.use("/api/push", requireAuth, pushNotificationsRoutes);

  // Keep oversized JSON failures predictable for Meta retries and portal callers.
  app.use(payloadTooLargeErrorHandler);

  const portalBuildPath = path.join(__dirname, "../portal-frontend/dist");
  app.use(express.static(portalBuildPath));
  app.get(/^(?!\/(webhook|meta-webhook|api)).*/, (req, res) => {
    res.sendFile(path.join(portalBuildPath, "index.html"), (err) => {
      if (err) {
        res.status(404).send(
          "Portal not built yet — run `npm run build` in portal-frontend/, or use `npm run dev` there for local development."
        );
      }
    });
  });

  return app;
}

module.exports = {
  createApp,
};
