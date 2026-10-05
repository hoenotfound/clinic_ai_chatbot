const retryRepo = require("../db/whatsappOutboundRetryRepo");
const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const inboundProcessingRepo = require("../db/inboundProcessingRepo");
const outboundMessageEvidenceRepo = require("../db/outboundMessageEvidenceRepo");
const channelMessaging = require("./channelMessagingService");
const {
  TRANSIENT_SEND_ERROR_CODES,
} = require("./whatsappService");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
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
const ATTENTION_RETRY_DELAY_MS = 60 * 1000;
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
  const index = Math.max(
    0,
    Math.min(RETRY_DELAYS_MS.length - 1, Number(attempts) || 0)
  );
  return RETRY_DELAYS_MS[index];
}

function delayUntilNextRetry(result) {
  const nextDueAt = result?.nextDueAt ? new Date(result.nextDueAt).getTime() : NaN;
  if (!Number.isFinite(nextDueAt)) return null;
  return Math.max(0, nextDueAt - Date.now());
}

function acceptedDeliveryEvidence(message) {
  const status = String(message?.delivery_status || "").toLowerCase();
  if (["pending", "sent", "delivered", "read"].includes(status)) return true;
  return Boolean(message?.whatsapp_message_id) && !["failed", "unknown"].includes(status);
}

function rowStillEligible(row, isAutomationEnabled = automatedRepliesEnabled) {
  return (
    isAutomationEnabled() === true &&
    row?.contact_channel === "whatsapp" &&
    String(row?.contact_mode || "").toLowerCase() === "ai" &&
    row?.contact_needs_attention !== true &&
    row?.has_newer_customer_message !== true &&
    row?.has_newer_staff_message !== true
  );
}

function cancellationReason(row, isAutomationEnabled = automatedRepliesEnabled) {
  if (isAutomationEnabled() !== true) {
    return "Automatic WhatsApp retry cancelled because automated replies are disabled.";
  }
  if (row?.contact_channel !== "whatsapp") {
    return "Automatic WhatsApp retry cancelled because the conversation is no longer a WhatsApp conversation.";
  }
  if (String(row?.contact_mode || "").toLowerCase() !== "ai") {
    return "Automatic WhatsApp retry cancelled because the conversation is no longer AI-owned.";
  }
  if (row?.contact_needs_attention === true) {
    return "Automatic WhatsApp retry cancelled because the conversation needs staff attention.";
  }
  if (row?.has_newer_customer_message || row?.has_newer_staff_message) {
    return "Automatic WhatsApp retry cancelled because the conversation changed after the failed send.";
  }
  return "Automatic WhatsApp retry cancelled because final send eligibility could not be verified.";
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

async function queueDeliveryFailureRetry({
  messageId,
  contactId,
  errorText,
  providerErrorCode,
}, repository = retryRepo) {
  const code = Number(providerErrorCode);
  if (!Number.isSafeInteger(code) || !TRANSIENT_SEND_ERROR_CODES.has(code)) {
    return null;
  }

  const queued = await repository.enqueueDeliveryFailureRetry({
    messageId,
    contactId,
    delaySeconds: Math.ceil(INITIAL_RETRY_DELAY_MS / 1000),
    errorText,
    providerErrorCode: code,
    maxAttempts: MAX_RETRY_ATTEMPTS,
  });
  if (queued) wakeWhatsappOutboundRetry(INITIAL_RETRY_DELAY_MS);
  return queued;
}

async function recordAcceptedEvidence(row, providerMessageId, evidence) {
  if (!providerMessageId || typeof evidence?.recordOutcome !== "function") return;
  try {
    await evidence.recordOutcome({
      messageId: row.message_id,
      contactId: row.contact_id,
      channel: "whatsapp",
      origin: row.origin,
      accepted: true,
      providerMessageId,
    });
  } catch (err) {
    console.error(
      `Failed to refresh outbound acceptance evidence for retried message ${row.message_id}:`,
      err
    );
  }
}

async function finalizeInboundAttempt(
  row,
  outcome,
  {
    providerMessageId = null,
    errorText = null,
    inbound = inboundProcessingRepo,
  } = {}
) {
  if (typeof inbound?.finalizeOutboundAttemptByAssistantMessageId !== "function") {
    return null;
  }
  try {
    return await inbound.finalizeOutboundAttemptByAssistantMessageId(
      row.message_id,
      { outcome, providerMessageId, errorText }
    );
  } catch (err) {
    console.error(
      `Failed to update durable inbound outbound-attempt state for message ${row.message_id}:`,
      err
    );
    return null;
  }
}

async function finishAttention(
  row,
  reason,
  {
    terminal = "failed",
    repository = retryRepo,
    contacts = contactsRepo,
    inbound = inboundProcessingRepo,
    leaseToken = row.lease_token,
  } = {}
) {
  const attentionReason = String(reason || "Delivery failed.").slice(0, 1000);

  const prepared = typeof repository.prepareAttention === "function"
    ? await repository.prepareAttention(
        row.id,
        leaseToken,
        attentionReason
      )
    : { id: row.id };
  if (!prepared) return false;

  try {
    await contacts.setDeliveryAttention(row.contact_id, attentionReason);
  } catch (err) {
    console.error(
      `Failed to persist delivery attention for WhatsApp retry ${row.id}; deferring attention recovery:`,
      err
    );
    await repository.deferAttention(
      row.id,
      leaseToken,
      attentionReason,
      { delaySeconds: Math.ceil(ATTENTION_RETRY_DELAY_MS / 1000) }
    );
    return false;
  }

  await finalizeInboundAttempt(
    row,
    terminal === "cancelled" ? "cancelled" : "rejected",
    { errorText: attentionReason, inbound }
  );

  if (terminal === "cancelled") {
    await repository.markCancelled(row.id, leaseToken, attentionReason);
  } else {
    await repository.markFailed(row.id, leaseToken, attentionReason);
  }
  return true;
}

async function recoverAttentionOnly(
  row,
  {
    repository = retryRepo,
    contacts = contactsRepo,
    inbound = inboundProcessingRepo,
  } = {}
) {
  const reason = String(
    row.last_error || "Delivery failed and requires staff review."
  ).slice(0, 1000);
  try {
    await contacts.setDeliveryAttention(row.contact_id, reason);
  } catch (err) {
    console.error(
      `Failed to recover delivery attention for WhatsApp retry ${row.id}:`,
      err
    );
    await repository.deferAttention(
      row.id,
      row.lease_token,
      reason,
      { delaySeconds: Math.ceil(ATTENTION_RETRY_DELAY_MS / 1000) }
    );
    return false;
  }

  await finalizeInboundAttempt(row, "rejected", {
    errorText: reason,
    inbound,
  });
  await repository.markFailed(row.id, row.lease_token, reason);
  return true;
}

async function failClosedAmbiguous(row, reason, {
  repository = retryRepo,
  messages = messagesRepo,
  contacts = contactsRepo,
  evidence = outboundMessageEvidenceRepo,
  inbound = inboundProcessingRepo,
  leaseToken = row.lease_token,
} = {}) {
  const errorText = String(reason || "WhatsApp delivery could not be confirmed.");
  let state;

  if (typeof messages.markDeliveryUnknownIfUnconfirmed === "function") {
    state = await messages.markDeliveryUnknownIfUnconfirmed(
      row.message_id,
      errorText
    );
  } else {
    const updated = await messages.setDeliveryStatusById(
      row.message_id,
      "unknown",
      errorText
    );
    state = { marked: Boolean(updated), accepted: false, message: updated };
  }

  if (state?.accepted) {
    if (leaseToken) {
      await repository.markSent(row.id, leaseToken);
    }
    await recordAcceptedEvidence(
      row,
      state.message?.whatsapp_message_id,
      evidence
    );
    await finalizeInboundAttempt(row, "accepted", {
      providerMessageId: state.message?.whatsapp_message_id,
      inbound,
    });
    await contacts.clearDeliveryAttentionIfNoFailedMessages(row.contact_id);
    return { accepted: true, message: state.message || null };
  }

  publishDeliveryStatus(state?.message || null);
  const attentionReason = `Delivery unconfirmed: ${errorText}`;
  await finishAttention(row, attentionReason, {
    terminal: "failed",
    repository,
    contacts,
    inbound,
    leaseToken,
  });
  await finalizeInboundAttempt(row, "ambiguous", {
    errorText,
    inbound,
  });
  return { accepted: false, message: state?.message || null };
}

async function currentEligibility(
  row,
  repository,
  isAutomationEnabled
) {
  if (isAutomationEnabled() !== true) return null;
  if (typeof repository.checkSendEligibility !== "function") {
    return rowStillEligible(row, isAutomationEnabled) ? row : null;
  }

  const latest = await repository.checkSendEligibility({
    id: row.id,
    leaseToken: row.lease_token,
    messageId: row.message_id,
    contactId: row.contact_id,
  });
  if (!latest || !rowStillEligible(latest, isAutomationEnabled)) return null;
  return latest;
}

function compatibleSender({
  sendText,
  sendMessage,
}) {
  if (typeof sendMessage !== "function") return sendText;
  return async (contact, text, options = {}) => {
    if (typeof options.preSendCheck === "function") {
      let allowed;
      try {
        allowed = await options.preSendCheck();
      } catch (err) {
        return {
          success: false,
          wamid: null,
          cancelled: true,
          preSendCheckFailed: true,
          error: "Message send cancelled because final eligibility could not be verified.",
        };
      }
      if (allowed !== true) {
        return {
          success: false,
          wamid: null,
          cancelled: true,
          error: null,
        };
      }
    }
    return sendMessage(contact.whatsapp_number, text);
  };
}

async function runWhatsappOutboundRetryQueue({
  repository = retryRepo,
  messages = messagesRepo,
  contacts = contactsRepo,
  evidence = outboundMessageEvidenceRepo,
  inbound = inboundProcessingRepo,
  isAutomationEnabled = automatedRepliesEnabled,
  sendText = channelMessaging.sendText,
  sendMessage = null,
} = {}) {
  const deliverText = compatibleSender({ sendText, sendMessage });

  const stale = await repository.recoverStaleProcessing({
    staleAfterSeconds: STALE_PROCESSING_SECONDS,
    limit: BATCH_SIZE,
  });

  for (const row of stale) {
    if (acceptedDeliveryEvidence(row)) {
      await repository.markSent(row.id, row.lease_token);
      await recordAcceptedEvidence(row, row.whatsapp_message_id, evidence);
      await finalizeInboundAttempt(row, "accepted", {
        providerMessageId: row.whatsapp_message_id,
        inbound,
      });
      await contacts.clearDeliveryAttentionIfNoFailedMessages(row.contact_id);
      continue;
    }

    if (row.processing_kind === "send_pending") {
      await repository.reschedule(row.id, row.lease_token, {
        delaySeconds: 0,
        errorText: row.last_error,
        providerStatus: row.provider_status,
        providerErrorCode: row.provider_error_code,
      });
      continue;
    }

    if (row.processing_kind === "attention") {
      await recoverAttentionOnly(row, {
        repository,
        contacts,
        inbound,
      });
      continue;
    }

    await failClosedAmbiguous(
      row,
      row.last_error ||
        "WhatsApp retry was interrupted after the provider call may have started. Check the customer chat before replying.",
      {
        repository,
        messages,
        contacts,
        evidence,
        inbound,
        leaseToken: row.lease_token,
      }
    ).catch((err) => {
      console.error(
        `Failed to surface stale WhatsApp retry ${row.id} for contact ${row.contact_id}:`,
        err
      );
    });
  }

  const retries = await repository.claimDue({ limit: BATCH_SIZE });
  for (const row of retries) {
    const leaseToken = row.lease_token;
    let acceptedPersisted = false;
    let providerAcceptedUnpersisted = false;
    let providerCallStarted = false;
    let providerResultResolved = false;

    try {
      if (row.claimed_from_status === "attention_pending") {
        await recoverAttentionOnly(row, {
          repository,
          contacts,
          inbound,
        });
        continue;
      }

      if (acceptedDeliveryEvidence(row)) {
        await repository.markSent(row.id, leaseToken);
        await recordAcceptedEvidence(row, row.whatsapp_message_id, evidence);
        await finalizeInboundAttempt(row, "accepted", {
          providerMessageId: row.whatsapp_message_id,
          inbound,
        });
        await contacts.clearDeliveryAttentionIfNoFailedMessages(row.contact_id);
        continue;
      }

      if (!rowStillEligible(row, isAutomationEnabled)) {
        const reason = cancellationReason(row, isAutomationEnabled);
        await finishAttention(row, `Delivery failed: ${reason}`, {
          terminal: "cancelled",
          repository,
          contacts,
          inbound,
          leaseToken,
        });
        continue;
      }

      const contactForSend = {
        id: row.contact_id,
        channel: "whatsapp",
        whatsapp_number: String(row.current_recipient || row.recipient || "").trim(),
        mode: "ai",
      };

      const preSendCheck = async () => {
        const latest = await currentEligibility(
          row,
          repository,
          isAutomationEnabled
        );
        if (!latest) return false;

        const started = typeof repository.markSendStarted === "function"
          ? await repository.markSendStarted(row.id, leaseToken)
          : { id: row.id };
        if (!started) return false;
        providerCallStarted = true;
        return true;
      };

      // This deliberately goes through channelMessaging.sendText in production.
      // That preserves the 24-hour WhatsApp policy gate before preSendCheck,
      // while preSendCheck is the last ownership/conversation fence immediately
      // before the provider request.
      const result = await deliverText(
        contactForSend,
        row.message_content,
        {
          purpose: "service",
          preSendCheck,
        }
      );
      providerResultResolved = true;

      if (result?.cancelled) {
        const reason = result?.preSendCheckFailed
          ? result.error
          : "Automatic WhatsApp retry cancelled because final send eligibility changed.";
        await finishAttention(row, `Delivery failed: ${reason}`, {
          terminal: "cancelled",
          repository,
          contacts,
          inbound,
          leaseToken,
        });
        continue;
      }

      if (result?.success && result?.wamid) {
        providerAcceptedUnpersisted = true;
        const updated = await messages.setWhatsappMessageId(
          row.message_id,
          result.wamid
        );
        if (!updated?.whatsapp_message_id) {
          const persistenceError = new Error(
            "WhatsApp accepted the retry but its provider message ID could not be persisted."
          );
          persistenceError.code = "WHATSAPP_RETRY_WAMID_PERSIST_FAILED";
          throw persistenceError;
        }

        acceptedPersisted = true;
        providerAcceptedUnpersisted = false;
        publishDeliveryStatus(updated);
        await repository.markSent(row.id, leaseToken);
        await recordAcceptedEvidence(row, result.wamid, evidence);
        await finalizeInboundAttempt(row, "accepted", {
          providerMessageId: result.wamid,
          inbound,
        });
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
          evidence,
          inbound,
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

      if (
        result?.retryable === true &&
        Number(row.attempts) < MAX_RETRY_ATTEMPTS
      ) {
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

      await finishAttention(row, `Delivery failed: ${errorText}`, {
        terminal: "failed",
        repository,
        contacts,
        inbound,
        leaseToken,
      });
    } catch (err) {
      if (acceptedPersisted) {
        console.error(
          `WhatsApp retry ${row.id} was accepted but post-send bookkeeping failed:`,
          err
        );
        continue;
      }

      if (
        !providerAcceptedUnpersisted &&
        (!providerCallStarted || providerResultResolved)
      ) {
        // No ambiguous provider call exists in this branch. Preserve a durable
        // attention-only retry instead of converting a known rejection or a
        // pre-send failure into an "unknown delivery" state.
        const reason = providerResultResolved
          ? `Delivery failed: ${err?.message || "WhatsApp retry bookkeeping failed."}`
          : `Delivery failed before retry could be sent: ${err?.message || "Final send eligibility could not be verified."}`;
        try {
          await repository.prepareAttention(row.id, leaseToken, reason);
          await repository.deferAttention(
            row.id,
            leaseToken,
            reason,
            { delaySeconds: Math.ceil(ATTENTION_RETRY_DELAY_MS / 1000) }
          );
        } catch (deferErr) {
          console.error(
            `Failed to defer staff attention for WhatsApp retry ${row.id}:`,
            deferErr
          );
        }
        console.error(`WhatsApp outbound retry ${row.id} failed safely:`, err);
        continue;
      }

      await failClosedAmbiguous(
        row,
        "WhatsApp retry was interrupted and delivery could not be confirmed. Check the customer chat before replying.",
        {
          repository,
          messages,
          contacts,
          evidence,
          inbound,
          leaseToken,
        }
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
    nextDueAt: await repository.findNextDueAt({
      staleAfterSeconds: STALE_PROCESSING_SECONDS,
    }),
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
  ATTENTION_RETRY_DELAY_MS,
  BATCH_SIZE,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  STALE_PROCESSING_SECONDS,
  acceptedDeliveryEvidence,
  delayUntilNextRetry,
  failClosedAmbiguous,
  queueDeliveryFailureRetry,
  queueTextRetry,
  recordAcceptedEvidence,
  retryDelayForAttempt,
  runWhatsappOutboundRetryQueue,
  startWhatsappOutboundRetryWorker,
  wakeWhatsappOutboundRetry,
};
