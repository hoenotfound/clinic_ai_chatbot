const retryRepo = require("../db/whatsappOutboundRetryRepo");
const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const whatsapp = require("./whatsappService");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");

const INITIAL_RETRY_DELAY_MS = 15 * 1000;
const RETRY_DELAYS_MS = Object.freeze([
  INITIAL_RETRY_DELAY_MS,
  60 * 1000,
  5 * 60 * 1000,
]);
const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;
const STALE_PROCESSING_SECONDS = 3 * 60;
const WORKER_ERROR_RETRY_MS = 60 * 1000;
const BATCH_SIZE = 10;

let retryWorker = null;

function publishDeliveryStatus(message) {
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

function retryErrorText(result) {
  return String(
    result?.error ||
      "WhatsApp temporarily rejected this message."
  ).slice(0, 1000);
}

function retryDelayForAttempt(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attempts) || 0));
  return RETRY_DELAYS_MS[index];
}

function delayUntilNextRetry(result) {
  const nextDueAt = result?.nextDueAt ? new Date(result.nextDueAt).getTime() : NaN;
  if (!Number.isFinite(nextDueAt)) return null;
  return Math.max(0, nextDueAt - Date.now());
}

async function queueTextRetry({
  messageId,
  contactId,
  recipient,
  origin,
  sendResult,
}, repository = retryRepo) {
  const queued = await repository.enqueueTextRetry({
    messageId,
    contactId,
    recipient,
    origin,
    delaySeconds: Math.ceil(INITIAL_RETRY_DELAY_MS / 1000),
    errorText: retryErrorText(sendResult),
    providerStatus: sendResult?.providerStatus ?? null,
    providerErrorCode: sendResult?.providerErrorCode ?? null,
  });
  if (queued) wakeWhatsappOutboundRetry(INITIAL_RETRY_DELAY_MS);
  return queued;
}

async function failClosedAmbiguous(row, reason, {
  repository = retryRepo,
  messages = messagesRepo,
  contacts = contactsRepo,
  leaseToken = row.lease_token,
} = {}) {
  const errorText = String(reason || "WhatsApp delivery could not be confirmed.");
  const updated = await messages.setDeliveryStatusById(
    row.message_id,
    "unknown",
    errorText
  );
  publishDeliveryStatus(updated);
  if (leaseToken) {
    await repository.markFailed(row.id, leaseToken, errorText);
  }
  await contacts.setDeliveryAttention(
    row.contact_id,
    `Delivery unconfirmed: ${errorText}`
  );
}

async function runWhatsappOutboundRetryQueue({
  repository = retryRepo,
  messages = messagesRepo,
  contacts = contactsRepo,
  sendMessage = whatsapp.sendMessage,
} = {}) {
  const stale = await repository.recoverStaleProcessing({
    staleAfterSeconds: STALE_PROCESSING_SECONDS,
    limit: BATCH_SIZE,
  });
  for (const row of stale) {
    await failClosedAmbiguous(row, row.last_error, {
      repository,
      messages,
      contacts,
      leaseToken: null,
    }).catch((err) => {
      console.error(
        `Failed to surface stale WhatsApp retry ${row.id} for contact ${row.contact_id}:`,
        err
      );
    });
  }

  const retries = await repository.claimDue({ limit: BATCH_SIZE });
  for (const row of retries) {
    const leaseToken = row.lease_token;
    try {
      if (
        row.whatsapp_message_id ||
        ["pending", "sent", "delivered", "read"].includes(
          String(row.delivery_status || "").toLowerCase()
        )
      ) {
        await repository.markSent(row.id, leaseToken);
        continue;
      }

      if (
        row.contact_channel !== "whatsapp" ||
        String(row.contact_mode || "").toLowerCase() !== "ai"
      ) {
        const reason =
          "Automatic WhatsApp retry cancelled because the conversation is no longer AI-owned.";
        await repository.markCancelled(row.id, leaseToken, reason);
        await contacts.setDeliveryAttention(
          row.contact_id,
          `Delivery failed: ${reason}`
        );
        continue;
      }

      if (row.has_newer_customer_message || row.has_newer_staff_message) {
        const reason =
          "Automatic WhatsApp retry cancelled because the conversation changed after the failed send.";
        await repository.markCancelled(row.id, leaseToken, reason);
        await contacts.setDeliveryAttention(
          row.contact_id,
          `Delivery failed: ${reason}`
        );
        continue;
      }

      const recipient = String(row.current_recipient || row.recipient || "").trim();
      const result = await sendMessage(recipient, row.message_content);

      if (result?.success && result?.wamid) {
        const updated = await messages.setWhatsappMessageId(row.message_id, result.wamid);
        publishDeliveryStatus(updated);
        await repository.markSent(row.id, leaseToken);
        await contacts.clearDeliveryAttentionIfNoFailedMessages(row.contact_id);
        console.log(
          `WhatsApp retry succeeded for message ${row.message_id} on attempt ${row.attempts}.`
        );
        continue;
      }

      if (result?.ambiguous) {
        await failClosedAmbiguous(row, retryErrorText(result), {
          repository,
          messages,
          contacts,
          leaseToken,
        });
        continue;
      }

      const errorText = retryErrorText(result);
      const failedMessage = await messages.setDeliveryStatusById(
        row.message_id,
        "failed",
        errorText
      );
      publishDeliveryStatus(failedMessage);

      if (result?.retryable === true && Number(row.attempts) < MAX_RETRY_ATTEMPTS) {
        const delayMs = retryDelayForAttempt(row.attempts);
        await repository.reschedule(row.id, leaseToken, {
          delaySeconds: Math.ceil(delayMs / 1000),
          errorText,
          providerStatus: result?.providerStatus ?? null,
          providerErrorCode: result?.providerErrorCode ?? null,
        });
        console.warn(
          `WhatsApp retry still transient for message ${row.message_id}; retrying again after ${Math.ceil(delayMs / 1000)}s.`
        );
        continue;
      }

      await repository.markFailed(row.id, leaseToken, errorText);
      await contacts.setDeliveryAttention(
        row.contact_id,
        `Delivery failed: ${errorText}`
      );
    } catch (err) {
      // Once a row is claimed, a process interruption during the provider call
      // is ambiguous. Do not reschedule blindly and risk a duplicate.
      await failClosedAmbiguous(
        row,
        "WhatsApp retry was interrupted and delivery could not be confirmed. Check the customer chat before replying.",
        { repository, messages, contacts, leaseToken }
      ).catch((surfaceErr) => {
        console.error(
          `Failed to surface interrupted WhatsApp retry ${row.id}:`,
          surfaceErr
        );
      });
      console.error(`WhatsApp outbound retry ${row.id} failed:`, err);
    }
  }

  return {
    processed: retries.length,
    staleRecovered: stale.length,
    nextDueAt: await repository.findNextDueAt(),
  };
}

function wakeWhatsappOutboundRetry(delayMs = 0) {
  return retryWorker?.wake(delayMs) || false;
}

function startWhatsappOutboundRetryWorker() {
  if (retryWorker && !retryWorker.state().stopped) {
    return () => retryWorker.stop();
  }
  retryWorker = createAdaptiveWorkerTimer({
    run: runWhatsappOutboundRetryQueue,
    delayForResult: delayUntilNextRetry,
    errorRetryDelayMs: WORKER_ERROR_RETRY_MS,
    label: "WhatsApp outbound retry worker",
  });
  return retryWorker.start();
}

module.exports = {
  BATCH_SIZE,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  STALE_PROCESSING_SECONDS,
  delayUntilNextRetry,
  queueTextRetry,
  retryDelayForAttempt,
  runWhatsappOutboundRetryQueue,
  startWhatsappOutboundRetryWorker,
  wakeWhatsappOutboundRetry,
};
