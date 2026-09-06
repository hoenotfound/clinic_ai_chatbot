const messagesRepo = require("../db/messagesRepo");
const repository = require("../db/whatsappDeliveryStatusRepo");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");

// Fast retry while a real delivery-status job needs work.
const RECOVERY_INTERVAL_MS = 10 * 1000;
const IDLE_RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_SECONDS = 60;
const STALE_RECHECK_GRACE_MS = 5 * 1000;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const COMPLETED_RETENTION_HOURS = 24;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function defaultPublishContact(contactId) {
  if (!contactId) return;
  realtimeEvents.publish("conversation_changed", {
    contactId,
    reason: "contact_state",
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
  publish = defaultPublish,
  publishContact = defaultPublishContact,
  sendDeliveryFailureAlert = telegramImmediateAlerts.sendDeliveryFailureAlert,
  logger = console,
} = {}) {
  let recoveryRunning = false;
  let lastPrunedAt = Date.now();
  let recoveryTimer = null;

  function wakeRecovery(delayMs = 0) {
    return recoveryTimer?.wake(delayMs) || false;
  }

  async function storeDeliveryStatusUpdates(updates) {
    return repo.storeBatch(updates);
  }

  function publishContactSafely(contactId) {
    try {
      publishContact(contactId);
    } catch (err) {
      logger.error("Failed to publish durable WhatsApp delivery attention state:", err);
    }
  }

  function notifyDeliveryFailureBestEffort(contactId, reason) {
    try {
      Promise.resolve(
        sendDeliveryFailureAlert({ contactId, reason })
      ).catch((err) => {
        logger.error(`Telegram delivery failure alert failed for contact ${contactId}:`, err);
      });
    } catch (err) {
      logger.error(`Telegram delivery failure alert failed for contact ${contactId}:`, err);
    }
  }

  async function restoreFailureAttention(job, updatedMessage) {
    if (job.delivery_status !== "failed" || updatedMessage.delivery_status !== "failed") {
      return null;
    }

    const reason = deliveryFailureReason(job);
    const attentionReason = `Delivery failed: ${reason}`;
    const updatedContact = await repo.setDeliveryAttentionState(
      updatedMessage.contact_id,
      attentionReason
    );
    if (updatedContact) publishContactSafely(updatedMessage.contact_id);
    return { reason, attentionReason };
  }

  async function processClaimedJob(job) {
    const errorText = job.error_message || job.error_title || null;
    let statusAppliedNow = false;
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
      statusAppliedNow = true;
      try {
        publish(updatedMessage);
      } catch (err) {
        logger.error("Failed to publish durable WhatsApp delivery status:", err);
      }
    }

    const failure = await restoreFailureAttention(job, updatedMessage);
    if (failure) {
      logger.error(
        `Delivery failed for message ${job.wamid}${job.error_code ? ` (code ${job.error_code})` : ""}:`,
        failure.reason
      );

      // Match the existing alert semantics: Telegram is a best-effort side
      // notification for the original status transition. On replay we restore
      // the durable Inbox attention state but do not emit another Telegram alert.
      if (statusAppliedNow) {
        notifyDeliveryFailureBestEffort(
          updatedMessage.contact_id,
          failure.attentionReason
        );
      }
    }

    // Completion is fenced by the lease token returned by the claim. If a
    // replacement worker reclaimed this row after the lease became stale, this
    // older worker can no longer overwrite the replacement worker's state.
    await repo.markCompleted(job.id, job.lease_token);
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
        await repo.markFailed(job.id, job.lease_token, err);
        wakeRecovery(RECOVERY_INTERVAL_MS);
      } catch (markErr) {
        // Leaving the row in processing state is intentional here. The stale
        // lease recovery path will reclaim it after STALE_AFTER_SECONDS. Lease
        // fencing prevents an older worker from failing a newer worker's claim.
        logger.error(`Failed to mark delivery-status job ${job.id} retryable:`, markErr);
        wakeRecovery(STALE_AFTER_SECONDS * 1000 + STALE_RECHECK_GRACE_MS);
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
      // For a failed provider callback, restore the durable Inbox attention
      // state before terminalizing the job. If this DB step fails, leave the
      // row non-terminal so a later recovery sweep can try again. This removes
      // the crash gap where terminal_at could previously be written first.
      if (job.delivery_status === "failed") {
        try {
          const message = await repo.findMessageByWamid(job.wamid);
          if (message?.delivery_status === "failed") {
            await restoreFailureAttention(job, message);
          }
        } catch (err) {
          logger.error(`Failed to surface exhausted delivery-status job ${job.id}:`, err);
          continue;
        }
      }

      const terminal = await repo.markTerminal(job.id);
      if (!terminal) continue;
      logger.error(
        `WhatsApp delivery-status job ${job.id} exhausted ${job.attempts} attempts ` +
        `for ${job.wamid}/${job.delivery_status}. The durable row was retained for diagnosis.`
      );
    }
    return exhausted.length;
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
    if (recoveryRunning) return { workCount: 0 };
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
      const exhaustedCount = await surfaceExhaustedJobs();
      await maybePruneCompleted();
      return { workCount: claimed.length + exhaustedCount };
    } catch (err) {
      logger.error("WhatsApp delivery-status recovery sweep failed:", err);
      throw err;
    } finally {
      recoveryRunning = false;
    }
  }

  function recoveryDelayForResult(result, { runCount }) {
    if (Number(result?.workCount) > 0) return RECOVERY_INTERVAL_MS;
    // On startup, a lease held by the previous Render process may still look
    // fresh. Recheck once after the stale window, then become truly idle.
    if (runCount === 1) {
      return STALE_AFTER_SECONDS * 1000 + STALE_RECHECK_GRACE_MS;
    }
    return IDLE_RECOVERY_INTERVAL_MS;
  }

  function startWhatsAppDeliveryStatusRecovery() {
    if (recoveryTimer && !recoveryTimer.state().stopped) {
      return () => recoveryTimer.stop();
    }
    recoveryTimer = createAdaptiveWorkerTimer({
      run: runRecovery,
      delayForResult: recoveryDelayForResult,
      errorRetryDelayMs: RECOVERY_INTERVAL_MS,
      logger,
      label: "WhatsApp delivery-status recovery",
    });
    return recoveryTimer.start();
  }

  return {
    processClaimedJob,
    processStoredDeliveryStatuses,
    runRecovery,
    startWhatsAppDeliveryStatusRecovery,
    storeDeliveryStatusUpdates,
    wakeRecovery,
  };
}

const defaultService = createWhatsAppDeliveryStatusService();

module.exports = {
  BATCH_SIZE,
  COMPLETED_RETENTION_HOURS,
  IDLE_RECOVERY_INTERVAL_MS,
  MAX_ATTEMPTS,
  RECOVERY_INTERVAL_MS,
  STALE_AFTER_SECONDS,
  createWhatsAppDeliveryStatusService,
  processStoredDeliveryStatuses: defaultService.processStoredDeliveryStatuses,
  runWhatsAppDeliveryStatusRecovery: defaultService.runRecovery,
  startWhatsAppDeliveryStatusRecovery: defaultService.startWhatsAppDeliveryStatusRecovery,
  storeDeliveryStatusUpdates: defaultService.storeDeliveryStatusUpdates,
};
