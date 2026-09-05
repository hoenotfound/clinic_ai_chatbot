const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const repository = require("../db/whatsappDeliveryStatusRepo");
const realtimeEvents = require("../utils/realtimeEvents");

const RECOVERY_INTERVAL_MS = 10 * 1000;
const STALE_AFTER_SECONDS = 60;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const COMPLETED_RETENTION_HOURS = 24;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function deliveryFailureReason(job) {
  return job.error_message || job.error_title || "WhatsApp reported delivery as failed.";
}

function defaultPublish(message) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason: "delivery_status",
  });
}

function retryableMissingWamidError(wamid) {
  const err = new Error(
    `WhatsApp delivery status arrived before message ${wamid} was linked locally.`
  );
  err.code = "DELIVERY_STATUS_MESSAGE_NOT_LINKED";
  return err;
}

function createWhatsAppDeliveryStatusService({
  repo = repository,
  messages = messagesRepo,
  contacts = contactsRepo,
  publish = defaultPublish,
  logger = console,
} = {}) {
  let recoveryRunning = false;
  let lastPrunedAt = 0;

  async function storeDeliveryStatusUpdates(updates) {
    return repo.storeBatch(updates);
  }

  async function processClaimedJob(job) {
    const errorText = job.error_message || job.error_title || null;
    let updatedMessage = await messages.updateDeliveryStatusByWamid(
      job.wamid,
      job.delivery_status,
      errorText
    );

    if (!updatedMessage) {
      // A no-op update can mean either "this status was already applied/stale"
      // or "the provider callback beat our WAMID persistence". Only the former
      // is complete. The latter must stay retryable so a fast Meta callback is
      // never silently lost.
      updatedMessage = await repo.findMessageByWamid(job.wamid);
      if (!updatedMessage) throw retryableMissingWamidError(job.wamid);
    } else {
      try {
        publish(updatedMessage);
      } catch (err) {
        logger.error("Failed to publish durable WhatsApp delivery status:", err);
      }
    }

    if (job.delivery_status === "failed" && updatedMessage.delivery_status === "failed") {
      const reason = deliveryFailureReason(job);
      logger.error(
        `Delivery failed for message ${job.wamid}${job.error_code ? ` (code ${job.error_code})` : ""}:`,
        reason
      );
      // If the process dies after the message status update but before this
      // attention write, replay sees the already-failed message above and runs
      // this step again. The database update itself is idempotent; Telegram is
      // best-effort just like the existing delivery-failure path.
      await contacts.setDeliveryAttention(
        updatedMessage.contact_id,
        `Delivery failed: ${reason}`
      );
    }

    await repo.markCompleted(job.id);
    return updatedMessage;
  }

  async function processOne(job) {
    try {
      return await processClaimedJob(job);
    } catch (err) {
      logger.error(
        `Failed to process durable WhatsApp delivery status job ${job.id} (${job.wamid}/${job.delivery_status}):`,
        err
      );
      try {
        await repo.markFailed(job.id, err);
      } catch (markErr) {
        // Leaving the row in processing state is intentional here. The stale
        // lease recovery path will reclaim it after STALE_AFTER_SECONDS.
        logger.error(`Failed to mark delivery-status job ${job.id} retryable:`, markErr);
      }
      return null;
    }
  }

  async function processStoredDeliveryStatuses(storedJobs) {
    const ids = (storedJobs || []).map((job) => job?.id).filter(Boolean);
    if (!ids.length) return [];
    const claimed = await repo.claimByIds(ids);
    const results = [];
    for (const job of claimed) {
      results.push(await processOne(job));
    }
    return results;
  }

  async function surfaceExhaustedJobs() {
    const exhausted = await repo.listExhausted({
      limit: BATCH_SIZE,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      maxAttempts: MAX_ATTEMPTS,
    });

    for (const job of exhausted) {
      const terminal = await repo.markTerminal(job.id);
      if (!terminal) continue;
      logger.error(
        `WhatsApp delivery-status job ${job.id} exhausted ${job.attempts} attempts ` +
        `for ${job.wamid}/${job.delivery_status}. The durable row was retained for diagnosis.`
      );

      // Failed delivery callbacks are actionable even if the worker exhausted
      // on a later bookkeeping step. Best-effort surface them to staff once
      // more before giving up; non-failure delivery states should not create a
      // human-attention incident merely because bookkeeping failed.
      if (job.delivery_status === "failed") {
        try {
          const message = await repo.findMessageByWamid(job.wamid);
          if (message) {
            await contacts.setDeliveryAttention(
              message.contact_id,
              `Delivery failed: ${deliveryFailureReason(job)}`
            );
          }
        } catch (err) {
          logger.error(`Failed to surface exhausted delivery-status job ${job.id}:`, err);
        }
      }
    }
  }

  async function maybePruneCompleted(now = Date.now()) {
    if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
    lastPrunedAt = now;
    try {
      await repo.pruneCompleted({ olderThanHours: COMPLETED_RETENTION_HOURS });
    } catch (err) {
      logger.error("Failed to prune completed WhatsApp delivery-status jobs:", err);
    }
  }

  async function runRecovery() {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      const claimed = await repo.claimRecoverable({
        limit: BATCH_SIZE,
        staleAfterSeconds: STALE_AFTER_SECONDS,
        maxAttempts: MAX_ATTEMPTS,
      });
      for (const job of claimed) {
        await processOne(job);
      }
      await surfaceExhaustedJobs();
      await maybePruneCompleted();
    } catch (err) {
      logger.error("WhatsApp delivery-status recovery sweep failed:", err);
    } finally {
      recoveryRunning = false;
    }
  }

  function startWhatsAppDeliveryStatusRecovery() {
    runRecovery();
    const timer = setInterval(runRecovery, RECOVERY_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return {
    processClaimedJob,
    processStoredDeliveryStatuses,
    runRecovery,
    startWhatsAppDeliveryStatusRecovery,
    storeDeliveryStatusUpdates,
  };
}

const defaultService = createWhatsAppDeliveryStatusService();

module.exports = {
  BATCH_SIZE,
  COMPLETED_RETENTION_HOURS,
  MAX_ATTEMPTS,
  RECOVERY_INTERVAL_MS,
  STALE_AFTER_SECONDS,
  createWhatsAppDeliveryStatusService,
  processStoredDeliveryStatuses: defaultService.processStoredDeliveryStatuses,
  runWhatsAppDeliveryStatusRecovery: defaultService.runRecovery,
  startWhatsAppDeliveryStatusRecovery: defaultService.startWhatsAppDeliveryStatusRecovery,
  storeDeliveryStatusUpdates: defaultService.storeDeliveryStatusUpdates,
};
