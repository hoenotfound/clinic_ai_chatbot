const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const { partitionLegacyWhatsAppWebhook } = require("./services/whatsappLegacySenderBoundary");
const { partitionSecondaryInboxWebhook } = require("./services/whatsappSecondaryInboxBoundary");
const { recordSignedSecondaryStatusBatch } = require("./services/whatsappSecondaryReceiptService");
const { recordQuarantinedWhatsAppChanges } = require("./db/whatsappSenderQuarantineRepo");
const { notifyWhatsAppSenderQuarantine } = require("./services/whatsappSenderQuarantineAlert");
const whatsappCoexistence = require("./services/whatsappCoexistenceService");
const coexistenceSync = require("./services/whatsappCoexistenceHistoryService");
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
const { stagingAccessGuard } = require("./middleware/pr395StagingBasicAuth");
const { stagingWebhookGuard } = require("./services/pr395StagingSafety");
const { resolveTrustProxy } = require("./utils/proxyTrust");
const { verifyTokenMatches } = require("./utils/webhookVerification");

const authRoutes = require("./routes/auth");
const conversationsRoutes = require("./routes/conversations");
const configRoutes = require("./routes/config");
const followUpActivityRoutes = require("./routes/followUpActivity");
const followUpHealthRoutes = require("./routes/followUpHealth");
const followUpPerformanceRoutes = require("./routes/followUpPerformance");
const advancedConfigRoutes = require("./routes/advancedConfig");
const contactsRoutes = require("./routes/contacts");
const pipelineRoutes = require("./routes/pipeline");
const setupStatusRoutes = require("./routes/setupStatus");
const whatsappCoexistenceOnboardingRoutes = require("./routes/whatsappCoexistenceOnboarding");
const goLiveRoutes = require("./routes/goLive");
const pushNotificationsRoutes = require("./routes/pushNotifications");
const opsReadinessRoutes = require("./routes/opsReadiness");
const startupReadiness = require("./services/startupReadinessService");
const { assertSenderIngressSafety } = require("./services/whatsappSenderActivationGate");

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

  assertSenderIngressSafety(process.env);
  const app = express();
  app.disable("x-powered-by");

  // Trust only the known proxy hop count. On Render this defaults to one hop,
  // which keeps req.protocol/req.ip correct without trusting arbitrary
  // leftmost X-Forwarded-For values supplied by clients.
  app.set("trust proxy", resolveTrustProxy(process.env));
  app.use(applyPortalSecurityHeaders);
  app.use(stagingAccessGuard);

  // Webhooks need the raw body in the verify hook so Meta signatures are
  // validated against the exact bytes received.
  const webhookJsonParser = createWebhookJsonParser((req, res, buf) => {
    verifyWebhookSignature(req, res, buf);
    // Copy only for the explicitly enabled sender-specific receipt ingress.
    // The receipt service independently verifies HMAC against these bytes.
    if (process.env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true") {
      req.whatsappSignedRawBody = Buffer.from(buf);
    }
  });
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

  app.post("/webhook", webhookJsonParser, stagingWebhookGuard, async (req, res) => {
    // The single-sender compatibility boundary runs only AFTER Meta signature
    // verification. It rejects explicitly foreign sender events before any
    // legacy customer lookups, AI cancellation, or receipt writes.
    let isolated;
    try {
      isolated = process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true"
        ? partitionSecondaryInboxWebhook(req.body, {
            primaryPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            primaryAccountId: process.env.WHATSAPP_WABA_ID,
            secondaryPhoneId: process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
            secondaryAccountId: process.env.WHATSAPP_SECONDARY_WABA_ID,
          })
        : partitionLegacyWhatsAppWebhook(req.body, {
        expectedPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        // Account validation must be enabled only after the real callback
        // account ID has been checked against the client's WABA setting.
        expectedAccountId: process.env.WHATSAPP_WABA_ID,
        strictAccount: process.env.WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED === "true",
        strictMissingMetadata: process.env.WHATSAPP_SINGLE_SENDER_STRICT_METADATA === "true",
      });
    } catch (err) {
      console.error("Rejected WhatsApp webhook due to sender config or payload limit:", err);
      return res.sendStatus(503);
    }

    const webhookBody = isolated.acceptedBody;
    const incomingMessages = whatsapp.parseIncomingMessages(webhookBody);
    const reactionEvents = whatsapp.parseReactionEvents(webhookBody).filter((event) =>
      process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true" ||
      event.businessPhoneNumberId === process.env.WHATSAPP_PHONE_NUMBER_ID
    );
    const businessAppEchoes = whatsapp.parseBusinessAppEchoes(webhookBody);
    const statusUpdates = whatsapp.parseStatusUpdates(webhookBody);
    const passiveSync = whatsappCoexistence.summarizePassiveSync(webhookBody);
    // Mark phone-side staff replies pending BEFORE slow optional history
    // imports; otherwise an in-flight AI generation can race the echo.
    for (const echo of businessAppEchoes) {
      whatsappCoexistence.beginPendingAiForEcho(echo);
    }
    let durabilityFailures = 0;
    let durableClaims;
    let durableStatusJobs;
    let durableBusinessAppEchoes;
    let durableReactionUpdates;
    try {
      [durableClaims, durableStatusJobs, durableBusinessAppEchoes, durableReactionUpdates] = await Promise.all([
        Promise.all(
          incomingMessages.map(async (incoming) => {
            const queueKey = process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" && incoming.businessPhoneNumberId
              ? `whatsapp:${incoming.businessPhoneNumberId}:${incoming.from}` : incoming.from;
            try {
              const durableClaim = await durablyClaimIncoming(queueKey, incoming);
              // Start each verified customer turn as soon as it is durable.
              // A failing second-number echo/receipt/history must not hold up
              // a Neutro response in the same Meta callback.
              scheduleDurableClaim(queueKey, durableClaim).catch((error) => {
                console.error("Failed to schedule durable WhatsApp inbound work:", error);
              });
              return { queueKey, durableClaim };
            } catch (error) {
              durabilityFailures += 1;
              console.error("Failed to durably claim WhatsApp inbound message:", error);
              return null;
            }
          })
        ),
        storeDeliveryStatusUpdates(statusUpdates).catch((error) => {
          durabilityFailures += 1;
          console.error("Could not durably store primary WhatsApp status updates:", error);
          return [];
        }),
        Promise.all(businessAppEchoes.map(async (echo) => {
          try {
            return await whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true });
          } catch (error) {
            durabilityFailures += 1;
            whatsappCoexistence.releasePendingAiForEcho(echo);
            console.error("Could not durably store WhatsApp Business App echo:", error);
            return null;
          }
        })),
        Promise.all(reactionEvents.map(async (reaction) => {
          try {
            return await messagesRepo.applyWhatsappReaction(reaction);
          } catch (error) {
            durabilityFailures += 1;
            console.error("Could not durably store WhatsApp reaction:", error);
            return null;
          }
        })),
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
      try {
        await whatsappCoexistence.finalizeBusinessAppEcho(persisted);
      } catch (error) {
        // The provider echo was already durably stored. Request an idempotent
        // replay for secondary bookkeeping without holding a primary reply.
        durabilityFailures += 1;
        console.error("Could not finalize WhatsApp Business App echo:", error);
      }
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

    // Primary statuses are already durable and customer turns are scheduled.
    // On secondary failure return 503 for a safe Meta replay, never discard
    // the secondary ledger or delay a valid Neutro conversation.
    processStoredDeliveryStatuses(durableStatusJobs).catch((err) => {
      console.error("Failed to schedule durable WhatsApp delivery-status work:", err);
    });
    if (durabilityFailures > 0) {
      return res.sendStatus(503);
    }

    // Stage secondary receipts before ACK, but only AFTER genuine inbound
    // messages have been stored and scheduled independently of this ledger.
    // Primary statuses remain in the original legacy partition; secondary
    // statuses remain excluded from all Neutro billing and retry handlers.
    if (process.env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true") {
      if (process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true" ||
          !Buffer.isBuffer(req.whatsappSignedRawBody)) return res.sendStatus(503);
      let savedReceipts;
      try {
        savedReceipts = await recordSignedSecondaryStatusBatch({
          rawBody: req.whatsappSignedRawBody,
          signatureHeader: req.headers["x-hub-signature-256"],
          subsetFromVerifiedWebhook: true,
        });
      } catch (error) {
        console.error("Could not store verified secondary WhatsApp receipts:", error);
        return res.sendStatus(503);
      }
      if (!savedReceipts.accepted) {
        console.error("Could not durably stage verified secondary WhatsApp status receipts:", savedReceipts.code);
        return res.sendStatus(503);
      }
      // Previously these expected statuses were quarantined. Now they have
      // been durably staged; retain every other foreign/malformed quarantine.
      isolated.quarantined = isolated.quarantined.filter((event) =>
        !(event.reason === "unsupported_whatsapp_event" &&
          event.field === "messages" &&
          event.accountId === process.env.WHATSAPP_SECONDARY_WABA_ID &&
          event.phoneNumberId === process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)
      );
    }

    // Imported history is passive: no AI, lead stage, service window or
    // follow-up. Errors return 503 so Meta can replay safely by WAMID.
    try {
      await coexistenceSync.acceptPassiveSync(webhookBody);
    } catch (err) {
      console.error("Could not durably accept sender-scoped Business App sync:", err);
      return res.sendStatus(503);
    }

    // A foreign-only callback has no valid Neutro work to delay. Persist
    // its privacy-safe audit before ACK; a transient DB failure asks Meta
    // to retry instead of silently dropping an unknown callback.
    const quarantineOnly = isolated.quarantined.length > 0
      && isolated.acceptedActionable === 0;
    if (quarantineOnly) {
      try {
        await recordQuarantinedWhatsAppChanges(isolated.quarantined);
      } catch (err) {
        console.error("Could not durably quarantine WhatsApp callback:", err);
        void notifyWhatsAppSenderQuarantine(isolated.quarantined);
        return res.sendStatus(503);
      }
      void notifyWhatsAppSenderQuarantine(isolated.quarantined);
    }

    res.sendStatus(200);

    // A mixed batch must never delay/deny the existing customer's accepted
    // message because a foreign-number quarantine insert is slow or failing.
    // Existing events are already durable when we ACK; the rejected-event
    // audit is best effort in mixed batches, with an operator notification.
    if (isolated.quarantined.length && !quarantineOnly) {
      void recordQuarantinedWhatsAppChanges(isolated.quarantined)
        .catch((err) => {
          console.error("WhatsApp quarantine audit failed after valid work was accepted:", err);
        })
        .finally(() => {
          void notifyWhatsAppSenderQuarantine(isolated.quarantined);
        });
    }

    if (passiveSync.historyChunks || passiveSync.appStateItems) {
      console.log(
        `Acknowledged WhatsApp coexistence sync event without operational import: history=${passiveSync.historyChunks}, app_state=${passiveSync.appStateItems}`
      );
    }

    setupStatusRepo.recordWebhook("whatsapp_webhook").catch((err) => {
      console.error("Failed to record WhatsApp webhook activity:", err);
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

  app.post("/meta-webhook", metaWebhookJsonParser, stagingWebhookGuard, async (req, res) => {
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
  app.use("/api/follow-up-activity", requireAuth, followUpActivityRoutes);
  app.use("/api/follow-up-health", requireAuth, followUpHealthRoutes);
  app.use("/api/whatsapp-secondary-followups", requireAuth,
    require("./routes/whatsappSecondaryFollowUpRules"));
  app.use("/api/whatsapp-secondary-media-review", requireAuth,
    require("./routes/whatsappSecondaryMediaReview"));
  app.use("/api/follow-up-performance", requireAuth, followUpPerformanceRoutes);
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
