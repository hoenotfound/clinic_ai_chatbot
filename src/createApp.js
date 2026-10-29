const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");

const whatsapp = require("./services/whatsappService");
const { partitionLegacyWhatsAppWebhook } = require("./services/whatsappLegacySenderBoundary");
const { partitionSecondaryInboxWebhook } = require("./services/whatsappSecondaryInboxBoundary");
const { recordSignedSecondaryStatusBatch } = require("./services/whatsappSecondaryReceiptService");
const {
  extractSecondaryLifecycle, persistSecondaryLifecycle,
} = require("./services/whatsappCoexistenceAccountUpdateService");
const { recordQuarantinedWhatsAppChanges } = require("./db/whatsappSenderQuarantineRepo");
const { notifyWhatsAppSenderQuarantine } = require("./services/whatsappSenderQuarantineAlert");
const paidDefaultIngress = require("./services/whatsappPaidDefaultIngress");
const secondaryQaCapture = require("./services/whatsappSecondaryQaCapture");
const secondaryQaBridge = require("./services/whatsappPaidDefaultSecondaryBridge");
const productionHistoryReceiver = require("./services/whatsappPaidProductionHistoryReceiver");
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
const preidentityReceiver = require("./services/pr395PreidentityReceiver");
const legacyLifecycleReceiver = require("./services/pr395LegacyLifecycleReceiver");
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
const salesFollowUpRoutes = require("./routes/salesFollowUp");
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
  captureSecondaryQaBatch = secondaryQaCapture.captureSignedSecondaryBatch,
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
  const verifySignedWhatsappBody = (req, res, buf) => {
    verifyWebhookSignature(req, res, buf);
    // Preserve signed raw bytes for whichever explicitly enabled secondary
    // sender bridge will independently verify the exact Meta HMAC.
    if (process.env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true" ||
        process.env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED === "true") {
      req.whatsappSignedRawBody = Buffer.from(buf);
    }
  };
  const webhookJsonParser = createWebhookJsonParser(verifySignedWhatsappBody);
  // Meta history chunks may exceed the normal inbound message size.
  // The original Neutro /webhook remains signed and capped at 2 MB.
  const paidDefaultHistoryJsonParser = createWebhookJsonParser(verifySignedWhatsappBody, "8mb");
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

  // App-default relay bootstrap may receive a signed account_update before
  // Embedded Signup provides the new WABA ID. Only the isolated QA Neon stores
  // sanitized lifecycle evidence. No sender is activated or customer message
  // processed. The raw JSON parser verifies Meta app HMAC before this handler.
  app.post("/pr395-preidentity-webhook", webhookJsonParser, async (req,res) => {
    if(!preidentityReceiver.enabled(process.env)){
      res.set("Cache-Control","no-store");
      return res.sendStatus(503);
    }
    try {
      const result=await preidentityReceiver.acceptPreidentityBatch(req.body);
      if(!result.durable)return res.sendStatus(503);
      res.set("X-DA-Coexistence-Preidentity-Accepted","1");
      res.set("Cache-Control","no-store");
      return res.sendStatus(200);
    }catch(error){
      console.error("[PR395 preidentity] refused undurable or foreign signed event:",
        error?.message || "unknown");
      res.set("Cache-Control","no-store");
      return res.sendStatus(503);
    }
  });

  // Dedicated audit-only ingress for known legacy WABA app-default lifecycle
  // events during a separately authorized cutover rehearsal. Requires the
  // original raw-body Meta app HMAC, then a committed isolated Neon audit.
  app.post("/pr395-legacy-lifecycle-webhook", webhookJsonParser, async(req,res)=>{
    res.set("Cache-Control","no-store");
    if(!legacyLifecycleReceiver.enabled(process.env))return res.sendStatus(503);
    try{
      const saved=await legacyLifecycleReceiver.recordBatch(req.body);
      if(!saved.durable)return res.sendStatus(503);
      res.set("X-DA-Legacy-Lifecycle-Accepted","1");
      return res.sendStatus(200);
    }catch(error){
      console.error("[PR395 legacy lifecycle] event refused or undurable:",
        error?.message||"unknown");
      return res.sendStatus(503);
    }
  });

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

  let primaryWhatsappWebhookHandler;
  app.post("/webhook", webhookJsonParser, stagingWebhookGuard, primaryWhatsappWebhookHandler = async (req, res) => {
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

    // Lifecycle account_update events can use the app-level WhatsApp callback
    // without phone_number_id metadata. Match a pinned secondary account and
    // E164 before excluding them from foreign-event quarantine. Never route
    // them through the customer-message or AI handlers.
    let secondaryLifecycle;
    try {
      secondaryLifecycle = extractSecondaryLifecycle(req.body, process.env);
    } catch (error) {
      console.error("Rejected invalid WhatsApp coexistence lifecycle batch:", error);
      return res.sendStatus(503);
    }
    if (secondaryLifecycle.length) {
      const lifeKeys = new Set(secondaryLifecycle.map((item) => item.quarantineFingerprint || item.fingerprint));
      isolated.quarantined = isolated.quarantined.filter((item) => !lifeKeys.has(item.fingerprint));
    }

    // Bound secondary DB work during a mixed callback. A stalled second-number
    // query must not indefinitely block Neutro's durable customer work.
    // Timed-out work is NOT acknowledged: the entire Meta callback returns
    // retryable 503; WAMIDs and receipt/event fingerprints keep replay safe.
    function boundedSecondaryWork(operation, label, onLateSuccess = null) {
      const configured = Number(process.env.WHATSAPP_SECONDARY_WEBHOOK_WORK_TIMEOUT_MS);
      const timeoutMs = Number.isInteger(configured) && configured >= 100 &&
        configured <= 5000 ? configured : 2500;
      // Never claim that Meta accepted unfinished work. If a secondary
      // customer insert commits after timeout, we still schedule its durable
      // message exactly once rather than relying on a duplicate replay to
      // claim it again. Other late successes are idempotent audit/receipt work.
      return new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          const error = new Error(label + " timed out");
          error.code = "SECONDARY_WEBHOOK_TIMEOUT";
          reject(error);
        }, timeoutMs);
        Promise.resolve().then(operation).then((result) => {
          if (expired) {
            if (onLateSuccess) {
              try { onLateSuccess(result); } catch (error) {
                console.error("Could not schedule late secondary webhook claim:", error);
              }
            }
            return;
          }
          clearTimeout(timer);
          resolve(result);
        }, (error) => {
          if (expired) {
            console.error("Late secondary webhook operation failed after retry response:", error);
            return;
          }
          clearTimeout(timer);
          reject(error);
        });
      });
    }
    // Write a disconnect before processing secondary customer turns in this
    // callback. A reconnection notice is audit-only and never auto-activates.
    const lifecycleWork = secondaryLifecycle.length ?
      boundedSecondaryWork(
        () => persistSecondaryLifecycle(secondaryLifecycle, { env: process.env }),
        "Secondary coexistence lifecycle",
      ).catch((error) => {
        console.error("Could not durably process secondary lifecycle:", error);
        return { accepted: false };
      }) : Promise.resolve({ accepted: true, count: 0 });

    // Save genuinely foreign-only callbacks before ACK. Legitimate secondary
    // billing statuses are handled separately after their signed receipt is
    // recorded; they must not require a foreign-event audit first.
    const hasExpectedSecondaryStatus = process.env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true" &&
      isolated.quarantined.some((event) =>
        event.reason === "unsupported_whatsapp_event" &&
        event.field === "messages" &&
        event.accountId === process.env.WHATSAPP_SECONDARY_WABA_ID &&
        event.phoneNumberId === process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID
      );
    let quarantineOnly = isolated.quarantined.length > 0 &&
      isolated.acceptedActionable === 0 && !hasExpectedSecondaryStatus;
    if (quarantineOnly) {
      try {
        await recordQuarantinedWhatsAppChanges(isolated.quarantined);
      } catch (error) {
        console.error("Could not durably quarantine WhatsApp callback:", error);
        void notifyWhatsAppSenderQuarantine(isolated.quarantined);
        return res.sendStatus(503);
      }
      void notifyWhatsAppSenderQuarantine(isolated.quarantined);
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
              const secondary = process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
                incoming.businessPhoneNumberId === process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
              if (secondary && secondaryLifecycle.length) {
                const life = await lifecycleWork;
                if (!life.accepted) throw Error("Secondary lifecycle audit not durable");
                if (secondaryLifecycle.some((item) =>
                  item.eventType === "PARTNER_REMOVED" || item.eventType === "ACCOUNT_OFFBOARDED"
                )) throw Error("Secondary sender disconnected during this callback");
              }
              const durableClaim = secondary ?
                await boundedSecondaryWork(
                  () => durablyClaimIncoming(queueKey, incoming),
                  "Secondary inbound claim",
                  (lateClaim) => {
                    if (lateClaim) {
                      scheduleDurableClaim(queueKey, lateClaim).catch((error) => {
                        console.error("Failed to schedule late durable WhatsApp inbound:", error);
                      });
                    }
                  },
                ) : await durablyClaimIncoming(queueKey, incoming);
              // Claim independently. An unrelated secondary DB error cannot
              // erase the successful Neutro claim; prepare/reply starts only
              // AFTER the webhook responds, including on a partial 503 retry.
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
            const secondary = process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
              echo.businessPhoneNumberId === process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
            if (secondary && secondaryLifecycle.length) {
              const life = await lifecycleWork;
              if (!life.accepted || secondaryLifecycle.some((item) =>
                item.eventType === "PARTNER_REMOVED" || item.eventType === "ACCOUNT_OFFBOARDED"
              )) throw Error("Secondary Business App connection not active");
            }
            return secondary ?
              await boundedSecondaryWork(
                () => whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true }),
                "Secondary Business App echo",
                (lateEcho) => {
                  // Persistence itself resolves/cancels pending-AI ownership.
                  // After a timeout the normal result array no longer includes
                  // this echo, so still run any post-persist side effects.
                  if (lateEcho) {
                    Promise.resolve().then(() => whatsappCoexistence.finalizeBusinessAppEcho(lateEcho))
                      .catch((lateError) => console.error("Late Business App echo finalization failed:", lateError));
                  }
                },
              ) : await whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true });
          } catch (error) {
            durabilityFailures += 1;
            // A timeout does NOT cancel the pending ownership barrier:
            // the underlying DB operation is still alive and may commit
            // a real staff echo after the webhook has returned 503.
            // persistBusinessAppEcho releases/confirms when it actually settles.
            if (error.code !== "SECONDARY_WEBHOOK_TIMEOUT") {
              whatsappCoexistence.releasePendingAiForEcho(echo);
            }
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
        lifecycleWork.then((result) => {
          if (!result.accepted) durabilityFailures += 1;
          return result;
        }),
      ]);
    } catch (err) {
      for (const echo of businessAppEchoes) {
        whatsappCoexistence.releasePendingAiForEcho(echo);
      }
      console.error("Failed to durably accept WhatsApp webhook work:", err);
      return res.sendStatus(503);
    }

    for (let echoIndex = 0; echoIndex < durableBusinessAppEchoes.length; echoIndex++) {
      const persisted = durableBusinessAppEchoes[echoIndex];
      if (!persisted) continue;
      try {
        // The verified originating echo is more authoritative than any
        // optional profile field on a subsequently loaded contact.
        const isSecondaryEcho = process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
          businessAppEchoes[echoIndex]?.businessPhoneNumberId ===
            process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
        if (isSecondaryEcho) {
          await boundedSecondaryWork(
            () => whatsappCoexistence.finalizeBusinessAppEcho(persisted),
            "Secondary Business App echo finalization",
          );
        } else {
          await whatsappCoexistence.finalizeBusinessAppEcho(persisted);
        }
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

    // Partial durability failure must preserve an idempotent provider retry,
    // while accepted Neutro work continues only AFTER the HTTP response.
    if (durabilityFailures > 0) {
      res.sendStatus(503);
      scheduleAcceptedWhatsAppWork();
      return;
    }

    // Stage secondary receipts before ACK, but only AFTER genuine inbound
    // messages have been stored and scheduled independently of this ledger.
    // Primary statuses remain in the original legacy partition; secondary
    // statuses remain excluded from all Neutro billing and retry handlers.
    if (process.env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED === "true") {
      if (process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true" ||
          !Buffer.isBuffer(req.whatsappSignedRawBody)) {
        res.sendStatus(503);
        scheduleAcceptedWhatsAppWork();
        return;
      }
      let savedReceipts;
      try {
        savedReceipts = await boundedSecondaryWork(
          () => recordSignedSecondaryStatusBatch({
            rawBody: req.whatsappSignedRawBody,
            signatureHeader: req.headers["x-hub-signature-256"],
            subsetFromVerifiedWebhook: true,
          }),
          "Secondary receipt storage",
        );
      } catch (error) {
        console.error("Could not store verified secondary WhatsApp receipts:", error);
        res.sendStatus(503);
        scheduleAcceptedWhatsAppWork();
        return;
      }
      if (!savedReceipts.accepted) {
        console.error("Could not durably stage verified secondary WhatsApp status receipts:", savedReceipts.code);
        res.sendStatus(503);
        scheduleAcceptedWhatsAppWork();
        return;
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
      await boundedSecondaryWork(
        () => coexistenceSync.acceptPassiveSync(webhookBody),
        "Coexistence passive synchronization",
      );
    } catch (err) {
      console.error("Could not durably accept sender-scoped Business App sync:", err);
      res.sendStatus(503);
      scheduleAcceptedWhatsAppWork();
      return;
    }


    // When a secondary status was stored but other foreign events remain,
    // audit the leftover foreign-only events before success ACK.
    if (!quarantineOnly && isolated.quarantined.length > 0 &&
        isolated.acceptedActionable === 0) {
      try {
        await recordQuarantinedWhatsAppChanges(isolated.quarantined);
      } catch (error) {
        console.error("Could not durably audit remaining foreign WhatsApp events:", error);
        res.sendStatus(503);
        scheduleAcceptedWhatsAppWork();
        return;
      }
      quarantineOnly = true;
      void notifyWhatsAppSenderQuarantine(isolated.quarantined);
    }

    // The app-default relay must never accept a silent 200 from an old
    // server that did not persist the pinned secondary disconnection.
    // This header is emitted only after lifecycleWork has succeeded.
    if (secondaryLifecycle.length && typeof res.setHeader === "function") {
      res.setHeader("X-DA-Coexistence-Lifecycle-Accepted", "1");
    }
    res.sendStatus(200);
    scheduleAcceptedWhatsAppWork();

    // All messaging and delivery-status side effects remain after the
    // response. Calling this on an HTTP 503 permits a durable Neutro
    // message to continue while Meta retries a failed secondary event.
    function scheduleAcceptedWhatsAppWork() {
      setupStatusRepo.recordWebhook("whatsapp_webhook").catch((err) => {
        console.error("Failed to record WhatsApp webhook activity:", err);
      });
      for (const accepted of durableClaims || []) {
        if (!accepted) continue;
        const { queueKey, durableClaim } = accepted;
        scheduleDurableClaim(queueKey, durableClaim).catch((err) => {
          console.error("Failed to schedule durable WhatsApp inbound work:", err);
        });
      }
      processStoredDeliveryStatuses(durableStatusJobs).catch((err) => {
        console.error("Failed to schedule durable WhatsApp delivery-status work:", err);
      });
    }


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


  });

  // Dedicated Meta APP-DEFAULT callback on the existing paid Render process.
  // The primary /webhook remains unchanged. This route is strictly default-OFF,
  // signs with the existing Meta app secret and only records audit metadata for
  // the personal WhatsApp Business App during preidentity bootstrap.
  app.get("/whatsapp/default", (req, res) => {
    if (!paidDefaultIngress.enabled()) return res.sendStatus(503);
    let config;
    try {
      config = paidDefaultIngress.configFromEnv();
    } catch (error) {
      console.error("[Paid default router] Configuration unavailable:", error.message);
      return res.sendStatus(503);
    }
    if (req.query["hub.mode"] === "subscribe" &&
        verifyTokenMatches(req.query["hub.verify_token"], config.verifyToken) &&
        typeof req.query["hub.challenge"] === "string") {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  });

  app.post("/whatsapp/default", (req, res, next) => {
    if (!paidDefaultIngress.enabled()) return res.sendStatus(503);
    try {
      paidDefaultIngress.configFromEnv();
      return next();
    } catch (error) {
      console.error("[Paid default router] Configuration unavailable:", error.message);
      return res.sendStatus(503);
    }
  }, paidDefaultHistoryJsonParser, async (req, res) => {
    try {
      if (productionHistoryReceiver.configured(process.env)) {
        return await productionHistoryReceiver.dispatch(
          req, res, primaryWhatsappWebhookHandler
        );
      }
      return await secondaryQaBridge.dispatchPaidDefaultWithSecondary(
        req, res, primaryWhatsappWebhookHandler, {
          captureSecondary: (body, opts) => captureSecondaryQaBatch(body, opts)
        }
      );
    } catch (error) {
      // Never return 200 for unknown accounts, undurable QA writes, or failed
      // primary processing. Meta may retry; database event keys deduplicate.
      console.error("[Paid default router] Rejected signed event:", error.message);
      if (!res.headersSent) return res.sendStatus(503);
    }
  });

  // Signed synthetic QA capture endpoint. Disabled by default and NOT the
  // Meta app-default callback. No inbound Neutro route changes or sending.
  app.post("/whatsapp/secondary-qa-capture", (req, res, next) => {
    if (process.env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED !== "true") {
      return res.sendStatus(503);
    }
    return next();
  }, paidDefaultHistoryJsonParser, async (req, res) => {
    try {
      // The same signed receiver is used in production staging and the
      // disposable-Postgres HTTP integration test. Injection is only for
      // isolated DB testing; the default never changes.
      const result = await captureSecondaryQaBatch(
        req.body, { signatureVerified: true }
      );
      return res.status(200).json({
        durable: result.durable,
        accepted: result.accepted,
        inserted: result.inserted
      });
    } catch (error) {
      console.error("[Secondary QA] Signed capture rejected:", error.code || "qa_capture_rejected");
      if (!res.headersSent) return res.sendStatus(503);
    }
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
    // Meta can deliver account_update at the app-level default callback rather
    // than at the per-account WhatsApp callback override. Never acknowledge a
    // WhatsApp payload as a Messenger/Instagram turn, or silently lose a
    // coexistence disconnection. Require the SAME verified Meta app secret
    // before the WhatsApp lifecycle path is eligible here.
    if (req.body?.object === "whatsapp_business_account") {
      if (!process.env.META_APP_SECRET || !process.env.WHATSAPP_APP_SECRET ||
          process.env.META_APP_SECRET !== process.env.WHATSAPP_APP_SECRET) {
        return res.sendStatus(503);
      }
      let events;
      try {
        events = extractSecondaryLifecycle(req.body, process.env);
        // Messages/history on this endpoint need the correct callback URL:
        // never ACK-and-drop customer data. Legitimate account_update events
        // of other types are not fatal; durably audit them and return 200.
        const entries = Array.isArray(req.body.entry) ? req.body.entry : null;
        if (!entries || entries.length > 200 ||
            entries.some((entry) => !entry || !Array.isArray(entry.changes)) ||
            entries.some((entry) => entry.changes.some((change) =>
              !change || change.field !== "account_update" ||
              !change.value || typeof change.value !== "object"))) {
          return res.sendStatus(503);
        }
        const changes = entries.flatMap((entry) =>
          entry.changes.map((change) => ({ entry, change })));
        if (changes.length > 200) return res.sendStatus(503);
        const recognized = new Set(events.map((event) => event.quarantineFingerprint || event.fingerprint));
        const crypto = require("node:crypto");
        const other = changes.map(({ entry, change }) => ({
          fingerprint: crypto.createHash("sha256")
            .update(JSON.stringify({ account: entry.id ?? null, change })).digest("hex"),
          reason: "unsupported_whatsapp_event",
          field: "account_update",
          accountId: typeof entry.id === "string" && /^\d+$/.test(entry.id) ? entry.id : null,
          phoneNumberId: null,
        })).filter((item) => !recognized.has(item.fingerprint));
        // A critical disconnection must be durable before it is ACKed.
        if (events.length) await persistSecondaryLifecycle(events, { env: process.env });
        if (other.length) await recordQuarantinedWhatsAppChanges(other);
        return res.sendStatus(200);
      } catch (error) {
        console.error("Could not durably accept signed app-level WhatsApp lifecycle:", error);
        return res.sendStatus(503);
      }
    }
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
  app.use("/api/sales-follow-up", requireAuth, salesFollowUpRoutes);
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
