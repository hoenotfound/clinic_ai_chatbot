const clinicConfig = require("../config/clinicConfig");
const messagesRepo = require("../db/messagesRepo");
const followUpRepo = require("../db/followUpRepo");
const contactsRepo = require("../db/contactsRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const { detectConversationLanguage } = require("../utils/chatLanguage");
const channelMessaging = require("./channelMessagingService");
const { automatedRepliesEnabled } = require("./automaticReplyControl");

// Retained as the failure-retry delay/export. Normal operation now sleeps until
// the next actual follow-up is due instead of polling Postgres every minute.
const FOLLOW_UP_CHECK_INTERVAL_MS = 60 * 1000;
const FOLLOW_UP_BATCH_SIZE = 25;
const STALE_CLAIM_GRACE_MINUTES = 10;

let sweepRunning = false;
let followUpTimer = null;

function normalizeFollowUpTranslations(value, fallbackMessage) {
  if (value !== undefined && (typeof value !== "object" || value === null)) {
    return null;
  }
  return Object.fromEntries(
    ["en", "ms", "zh"].map((key) => [
      key,
      typeof value?.[key] === "string" && value[key].trim()
        ? value[key].trim()
        : fallbackMessage,
    ])
  );
}

function normalizeServiceOverrides(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return null;

  const configuredServices = new Set(
    (Array.isArray(clinicConfig.services) ? clinicConfig.services : [])
      .map((service) =>
        typeof service?.name === "string"
          ? service.name.trim().toLocaleLowerCase()
          : ""
      )
      .filter(Boolean)
  );
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const serviceName =
      typeof item?.serviceName === "string" ? item.serviceName.trim() : "";
    const message = typeof item?.message === "string" ? item.message.trim() : "";
    if (!serviceName || !message || message.length > 1000) return null;

    const key = serviceName.toLocaleLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);

    // Fail safe at runtime for legacy/stale configs. A renamed or removed
    // service must fall back to the step's general message rather than keep
    // sending copy for a service that no longer exists.
    if (!configuredServices.has(key)) continue;

    const translations = normalizeFollowUpTranslations(
      item.translations,
      message
    );
    if (!translations) return null;
    normalized.push({ serviceName, message, translations });
  }
  return normalized;
}

function normalizeFollowUpStep(value) {
  const delayMinutes = Number(value?.delayMinutes);
  const message = typeof value?.message === "string" ? value.message.trim() : "";
  if (
    !Number.isInteger(delayMinutes) ||
    delayMinutes < 5 ||
    delayMinutes > 23 * 60 ||
    !message ||
    message.length > 1000 ||
    (value?.imageUrl !== undefined && typeof value.imageUrl !== "string")
  ) {
    return null;
  }

  const translations = normalizeFollowUpTranslations(
    value.translations,
    message
  );
  const serviceOverrides = normalizeServiceOverrides(value.serviceOverrides);
  if (!translations || !serviceOverrides) return null;

  return {
    delayMinutes,
    message,
    translations,
    imageUrl: value.imageUrl?.trim() || "",
    serviceOverrides,
  };
}

function getActiveSettings() {
  if (!automatedRepliesEnabled()) return null;

  const settings = clinicConfig.automatedFollowUp;
  if (
    !settings?.enabled ||
    !["all", "staff"].includes(settings.triggerMode) ||
    typeof settings.activatedAt !== "string" ||
    Number.isNaN(Date.parse(settings.activatedAt))
  ) {
    return null;
  }

  const rawAdditionalSteps =
    settings.additionalSteps === undefined ? [] : settings.additionalSteps;
  if (!Array.isArray(rawAdditionalSteps) || rawAdditionalSteps.length > 2) {
    return null;
  }

  const steps = [
    normalizeFollowUpStep(settings),
    ...rawAdditionalSteps.map(normalizeFollowUpStep),
  ];
  if (steps.some((step) => !step)) return null;

  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index].delayMinutes <= steps[index - 1].delayMinutes) {
      return null;
    }
  }

  return {
    triggerMode: settings.triggerMode,
    activatedAt: settings.activatedAt,
    steps,
  };
}

function normalizedServiceName(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
    : "";
}

function serviceTerms(serviceName) {
  const normalizedTarget = normalizedServiceName(serviceName);
  const aliases = Array.isArray(clinicConfig.serviceAliases)
    ? clinicConfig.serviceAliases
        .filter(
          (item) =>
            normalizedServiceName(item?.officialService) === normalizedTarget
        )
        .map((item) => String(item?.alias || "").trim())
        .filter(Boolean)
    : [];
  return [serviceName, ...aliases]
    .map(normalizedServiceName)
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function textContainsServiceTerm(text, term) {
  const normalizedText = normalizedServiceName(text);
  if (!normalizedText || !term) return false;

  // Short Latin service aliases such as "3D" need token boundaries so they
  // do not match inside unrelated words. Chinese/mixed-language names can use
  // a normal substring match because word boundaries are not reliable there.
  if (/^[a-z0-9][a-z0-9 .+\-_/]{0,3}$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i")
      .test(normalizedText);
  }
  return normalizedText.includes(term);
}

function targetedOverridesMentionedInConversation(step, candidate) {
  const transcript = [
    ...(candidate.recent_inbound_messages || []),
    candidate.trigger_message_content,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");

  if (!transcript) return [];
  return step.serviceOverrides.filter((item) =>
    serviceTerms(item.serviceName).some((term) =>
      textContainsServiceTerm(transcript, term)
    )
  );
}

function messageForCandidate(step, candidate, language) {
  const conversationMatches = targetedOverridesMentionedInConversation(
    step,
    candidate
  );
  const interest = normalizedServiceName(candidate.treatment_interest);
  const exactInterest = interest
    ? step.serviceOverrides.find(
        (item) => normalizedServiceName(item.serviceName) === interest
      )
    : null;

  // The recent conversation is the freshest signal. One clear service wins;
  // more than one means the customer is comparing/mixing interests, so use the
  // default copy. Only fall back to the CRM interest when no service is named
  // in the recent conversation.
  const targeted =
    conversationMatches.length === 1
      ? conversationMatches[0]
      : conversationMatches.length > 1
        ? null
        : exactInterest || null;
  const source = targeted || step;
  return {
    message: source.translations[language] || source.message,
    targetedService: targeted?.serviceName || null,
  };
}

function publishConversationChange(message, reason) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason,
  });
}

function contactForCandidate(candidate) {
  const channel = candidate.channel || "whatsapp";
  return {
    id: candidate.contact_id,
    channel,
    whatsapp_number: candidate.whatsapp_number,
    channel_user_id: candidate.channel_user_id,
  };
}

function rejectedFollowUpError(channel) {
  return `${channelMessaging.labelForChannel(channel)} did not accept this automated follow-up. Check the reply window or connection and retry it from the Inbox.`;
}

function deliveryErrorFor(channel, sendResult, rejectedError) {
  // Policy blocks contain a useful reason staff need to see. Other provider
  // failures keep the existing channel-specific wording.
  return sendResult?.policyBlocked && sendResult?.error
    ? sendResult.error
    : rejectedError;
}

async function markContacted(contactId) {
  try {
    await pipelineRepo.markContactedForContact(
      contactId,
      "Automated follow-up"
    );
  } catch (err) {
    console.error(
      `Failed to mark lead ${contactId} as contacted after automated follow-up:`,
      err
    );
  }
}

async function sendSocialImageCompanion(contact, contactId, imageUrl) {
  let imageMessage;
  try {
    imageMessage = await followUpRepo.saveSocialImageCompanion({
      contactId,
      imageUrl,
    });
  } catch (err) {
    console.error(
      `Failed to save optional social follow-up image for contact ${contactId}:`,
      err
    );
    await contactsRepo.setDeliveryAttention(
      contactId,
      "Follow-up text was sent, but the optional follow-up graphic could not be queued."
    );
    return;
  }

  if (!imageMessage) return;
  publishConversationChange(imageMessage, "message");

  let imageResult;
  try {
    // Facebook Messenger and Instagram cannot attach caption text to this
    // image in the same API message. The follow-up text has already been sent
    // and recorded, so this companion must contain only the image. A retry can
    // then resend the image without duplicating the customer-facing text.
    const imageProviderRecorder = messagesRepo.socialProviderAliasRecorder(
      imageMessage.id,
      contact.channel
    );
    imageResult = await channelMessaging.sendImageByUrl(
      contact,
      imageUrl,
      undefined,
      {
        purpose: "marketing",
        ...(imageProviderRecorder
          ? { onProviderMessageId: imageProviderRecorder }
          : {}),
      }
    );
  } catch (err) {
    console.error("Optional social follow-up image send failed:", err);
    imageResult = { success: false, wamid: null, externalMessageId: null };
  }

  const imageError = imageResult?.policyBlocked && imageResult.error
    ? imageResult.error
    : `${channelMessaging.labelForChannel(contact.channel)} did not accept the optional follow-up graphic. The follow-up text was sent; retry this image from the Inbox if needed.`;
  let finalImageMessage = imageMessage;
  if (imageResult?.success && imageResult.externalMessageId) {
    finalImageMessage =
      (await messagesRepo.setSocialProviderMessageId(
        imageMessage.id,
        `${contact.channel}:${imageResult.externalMessageId}`,
        "sent"
      )) || imageMessage;
  } else {
    finalImageMessage =
      (await messagesRepo.setDeliveryStatusById(
        imageMessage.id,
        imageResult?.success ? "sent" : "failed",
        imageResult?.success ? null : imageError
      )) || imageMessage;
  }
  publishConversationChange(finalImageMessage, "delivery_status");

  if (!imageResult?.success) {
    await contactsRepo.setDeliveryAttention(
      contactId,
      `Delivery failed: ${imageError}`
    );
  }
}

async function sendCandidate(candidate) {
  // Read the live settings again for every candidate. A staff member may
  // pause the tool or make its criteria stricter while a sweep is running.
  const settings = getActiveSettings();
  if (!settings) return;

  const stepIndex = Number(candidate.next_follow_up_step) || 1;
  const step = settings.steps[stepIndex - 1];
  if (!step) return;

  const language = detectConversationLanguage([
    ...(candidate.recent_inbound_messages || []),
    candidate.trigger_message_content,
  ]);
  const { message: followUpMessage } = messageForCandidate(
    step,
    candidate,
    language
  );
  const contact = contactForCandidate(candidate);
  const channel = contact.channel || "whatsapp";
  const isSocial = channel === "facebook" || channel === "instagram";

  // WhatsApp can send its image + caption as one tracked message. Messenger
  // and Instagram require separate text/image API messages, so the atomic
  // follow-up claim represents only the durable text message on those channels.
  const saved = await followUpRepo.saveIfStillEligible({
    contactId: candidate.contact_id,
    triggerMessageId: candidate.trigger_message_id,
    content: followUpMessage,
    mediaUrl: !isSocial && step.imageUrl ? step.imageUrl : null,
    stepIndex,
    delayMinutes: step.delayMinutes,
    triggerMode: settings.triggerMode,
    activatedAt: settings.activatedAt,
  });

  // The customer may have replied since the candidate query, or another
  // server instance may already have claimed this exact trigger.
  if (!saved) return;

  publishConversationChange(saved, "message");

  const rejectedError = rejectedFollowUpError(channel);

  let sendResult;
  try {
    if (isSocial) {
      // Record the follow-up text separately from an optional image so an image
      // failure/retry can never duplicate a text message Meta already accepted.
      const textProviderRecorder = messagesRepo.socialProviderAliasRecorder(
        saved.id,
        channel
      );
      sendResult = await channelMessaging.sendText(
        contact,
        followUpMessage,
        {
          purpose: "marketing",
          ...(textProviderRecorder
            ? { onProviderMessageId: textProviderRecorder }
            : {}),
        }
      );
    } else {
      const policyOptions = { purpose: "marketing" };
      sendResult = step.imageUrl
        ? await channelMessaging.sendImageByUrl(
            contact,
            step.imageUrl,
            followUpMessage,
            policyOptions
          )
        : await channelMessaging.sendText(
            contact,
            followUpMessage,
            policyOptions
          );
    }
  } catch (err) {
    console.error("Automated follow-up send failed:", err);
    sendResult = { success: false, wamid: null, externalMessageId: null };
  }

  const deliveryError = deliveryErrorFor(channel, sendResult, rejectedError);
  let finalMessage = saved;
  if (sendResult?.wamid) {
    // WhatsApp keeps using its asynchronous WAMID delivery-status pipeline.
    finalMessage =
      (await messagesRepo.setWhatsappMessageId(saved.id, sendResult.wamid)) || saved;
  } else if (!sendResult?.success) {
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(
        saved.id,
        "failed",
        deliveryError
      )) || saved;
  } else if (isSocial) {
    // Keep Meta's provider id for echo dedupe without entering WhatsApp's
    // asynchronous delivery-status pipeline.
    finalMessage = sendResult.externalMessageId
      ? (await messagesRepo.setSocialProviderMessageId(
          saved.id,
          `${channel}:${sendResult.externalMessageId}`,
          "sent"
        )) || saved
      : (await messagesRepo.setDeliveryStatusById(saved.id, "sent", null)) || saved;
  }

  publishConversationChange(finalMessage, "delivery_status");

  if (!sendResult?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      `Delivery failed: ${deliveryError}`
    );
    return;
  }

  // The successful text/WhatsApp follow-up is enough to move a new lead to
  // Contacted. Optional social image delivery is tracked independently below.
  await markContacted(candidate.contact_id);

  if (isSocial && step.imageUrl) {
    await sendSocialImageCompanion(
      contact,
      candidate.contact_id,
      step.imageUrl
    );
  }
}

async function recoverInterruptedFollowUps() {
  const recovered = await followUpRepo.markStaleClaimsUnconfirmed({
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
    limit: FOLLOW_UP_BATCH_SIZE,
  });

  for (const message of recovered) {
    publishConversationChange(message, "delivery_status");
    try {
      await contactsRepo.setDeliveryAttention(
        message.contact_id,
        `Delivery unconfirmed: ${message.delivery_error}`
      );
    } catch (err) {
      console.error(
        `Failed to flag interrupted automated follow-up ${message.id} for attention:`,
        err
      );
    }
  }
  return recovered.length;
}

async function nextInterruptedRecoveryAt() {
  if (typeof followUpRepo.getNextStaleClaimDueAt !== "function") return null;
  return followUpRepo.getNextStaleClaimDueAt({
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
  });
}

async function runAutomatedFollowUps() {
  if (sweepRunning) {
    return {
      enabled: Boolean(getActiveSettings()),
      candidateCount: 0,
      recoveredCount: 0,
      nextDueAt: null,
      nextRecoveryAt: null,
    };
  }

  sweepRunning = true;
  try {
    // Recovery is independent of the current tool setting. A staff member
    // may disable the tool after a restart, but an already-claimed message
    // must still become visible and retryable in the Inbox.
    const recoveredCount = await recoverInterruptedFollowUps();

    const settings = getActiveSettings();
    if (!settings) {
      return {
        enabled: false,
        candidateCount: 0,
        recoveredCount,
        nextDueAt: null,
        nextRecoveryAt: await nextInterruptedRecoveryAt(),
      };
    }

    const candidates = await followUpRepo.findCandidates({
      delayMinutes: settings.steps.map((step) => step.delayMinutes),
      triggerMode: settings.triggerMode,
      activatedAt: settings.activatedAt,
      limit: FOLLOW_UP_BATCH_SIZE,
    });

    for (const candidate of candidates) {
      try {
        await sendCandidate(candidate);
      } catch (err) {
        console.error(
          `Failed to process automated follow-up for contact ${candidate.contact_id}:`,
          err
        );
      }
    }

    const liveSettings = getActiveSettings();
    const nextDueAt = liveSettings && typeof followUpRepo.getNextCandidateDueAt === "function"
      ? await followUpRepo.getNextCandidateDueAt({
          delayMinutes: liveSettings.steps.map((step) => step.delayMinutes),
          triggerMode: liveSettings.triggerMode,
          activatedAt: liveSettings.activatedAt,
        })
      : null;
    const nextRecoveryAt = await nextInterruptedRecoveryAt();

    return {
      enabled: Boolean(liveSettings),
      candidateCount: candidates.length,
      recoveredCount,
      nextDueAt,
      nextRecoveryAt,
    };
  } catch (err) {
    console.error("Automated follow-up sweep failed:", err);
    throw err;
  } finally {
    sweepRunning = false;
  }
}

function earliestTimestamp(...values) {
  let earliest = null;
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return NaN;
    if (earliest === null || timestamp < earliest) earliest = timestamp;
  }
  return earliest;
}

function delayUntilNextFollowUp(result) {
  const timestamp = earliestTimestamp(
    result?.enabled ? result.nextDueAt : null,
    result?.nextRecoveryAt
  );
  if (timestamp === null) return null;
  if (Number.isNaN(timestamp)) return FOLLOW_UP_CHECK_INTERVAL_MS;
  // Avoid a zero-delay spin if another instance wins a race between candidate
  // discovery/recovery and the atomic claim.
  return Math.max(1000, timestamp - Date.now());
}

function wakeAutomatedFollowUps(delayMs = 0) {
  return followUpTimer?.wake(delayMs) || false;
}

function startAutomatedFollowUps() {
  if (followUpTimer && !followUpTimer.state().stopped) {
    return () => followUpTimer.stop();
  }

  followUpTimer = createAdaptiveWorkerTimer({
    run: runAutomatedFollowUps,
    delayForResult: delayUntilNextFollowUp,
    errorRetryDelayMs: FOLLOW_UP_CHECK_INTERVAL_MS,
    label: "Automated follow-up worker",
  });
  return followUpTimer.start();
}

// Any conversation change can make an outbound message newly eligible or make
// an existing candidate ineligible. Recalculate while the database is already
// active; once the chat becomes quiet the worker sleeps until the exact due time.
realtimeEvents.subscribe("conversation_changed", () => {
  wakeAutomatedFollowUps(0);
});

realtimeEvents.subscribe("config_changed", (payload) => {
  if (payload?.keys?.includes("automatedFollowUp")) wakeAutomatedFollowUps(0);
});

module.exports = {
  FOLLOW_UP_CHECK_INTERVAL_MS,
  STALE_CLAIM_GRACE_MINUTES,
  runAutomatedFollowUps,
  startAutomatedFollowUps,
  wakeAutomatedFollowUps,
};