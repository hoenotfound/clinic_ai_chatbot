require("dotenv").config();

const aiReplyCancellation = require("./services/aiReplyCancellationService");
const metaMessaging = require("./services/metaMessagingService");
const channelMessaging = require("./services/channelMessagingService");
const ai = require("./services/aiService");
const { transcribeAudio } = require("./services/transcriptionService");
const { convertToMp3 } = require("./services/audioConvertService");
const { getAiOwnedContact } = require("./services/automaticReplyGuard");
const { automatedRepliesEnabled } = require("./services/automaticReplyControl");
const {
  loadMetaAdReplyContext,
  resolveMetaAdCreativeService,
} = require("./services/metaAdReplyContextService");
const {
  getPendingAiHandoffContact,
  pauseAiForHumanHandoff,
} = require("./services/aiHandoffService");
const {
  claimIncomingMessage,
  prepareIncomingClaim,
  storeIncomingMessage,
} = require("./services/inboundMessageClaimService");
const {
  processClaimedBatch,
} = require("./services/inboundProcessingService");
const { markBookingReadyForContact } = require("./services/bookingReadyOutcomeService");
const { recordStaffAppointmentAcceptance } = require("./services/staffAppointmentAcceptanceService");
const conversationStore = require("./utils/conversationStore");
const { resolvePricePromotionForReply, selectPromoDuplicateCheck } = require("./utils/pricePromotionTrigger");
const { resolveAiPricingDecision, hasCustomerRequestedPriceReply } = require("./utils/aiPricingIntentDecision");
const { resolveScopedPackagePriceContinuation } = require("./utils/scopedPackagePriceContinuation");
const { resolveClarifiedPriceService } = require("./utils/priceClarificationContext");
const { resolveNumberedPricingMenuSelection } = require("./utils/numberedPricingMenuSelection");
const { resolveShadowPriceException, recentVerifiedPricingSession } = require("./utils/shadowPriceException");
const { resolveTwoTreatmentPriceReply, canRecoverTwoPriceInformationReview } = require("./utils/priceConversationRecovery");
const { resolveApprovedPricingAssessment } = require("./utils/approvedPricingDecision");
const { resolveVerifiedPriceFollowUpService } = require("./utils/priceFollowUpContext");
const { ensureVerifiedPriceReply, verifiedPricesForService, guardUnfulfilledPriceQuote } = require("./utils/verifiedPriceReply");
const { guardUnconfirmedMediaPromise } = require("./utils/unconfirmedMediaPromiseGuard");
const { appendRequestedBusinessFacts } = require("./utils/verifiedPricingBusinessFacts");
const { planInformationPriceRecovery } = require("./utils/informationPriceReviewRecovery");
const { setTimeout: pauseBeforeResultMedia } = require("node:timers/promises");
const {
  RESULT_MEDIA_SEND_SPACING_MS,
  planPromotionMediaPacing,
  planResultMediaPacing,
} = require("./utils/resultMediaPacing");
const resultMediaDecisionRepo = require("./db/resultMediaDecisionRepo");
const pricingDecisionAuditRepo = require("./db/pricingDecisionAuditRepo");
const whatsappResultMediaQueue = require("./services/whatsappResultMediaQueue");
const secondaryAiMediaQueue = require("./services/whatsappSecondaryAiMediaQueue");
const whatsappZeroCostGuard = require("./services/whatsappZeroCostGuard");
const { resultMediaAuditOutcome } = require("./utils/resultMediaAudit");
const { categorizeAiReview, hasClinicalMediaRisk } = require("./utils/aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion, complimentaryAssessmentFeeReply, ambiguousAssessmentOrTreatmentFeeReply } = require("./utils/complimentaryAssessmentExperience");
const { isUnanswerableCustomerReply } = require("./utils/aiSilentReviewPolicy");
const {
  resolveResultMediaForReply,
  isEarlyContextualAdEnquiry,
} = require("./utils/resultMediaTrigger");
const { isContextualAdServiceEnquiry } = require("./utils/customerEnquiryEvidence");
const { resolveFixedAdFirstReply } = require("./utils/fixedAdFirstReply");
const { parseAiReplyResult } = require("./utils/aiReplyResult");
const { fallbackHandoffReply } = require("./utils/handoffReply");
const {
  detectConversationLanguage,
  shouldGenerateLocalizedIntro,
} = require("./utils/chatLanguage");
const { preserveOriginalIntroFacts } = require("./utils/localizedIntroGuard");
const { guardFutureOfferIntroductionReply, guardAssessmentFirstPricingReply, ensureFirstAssessmentInvitation, safeServiceFromCustomer, hasCommercialReplyContent, safeIntroReply } = require("./utils/initialOfferReplyGuard");
const { isStandalonePriceQuestion } = require("./utils/customerEnquiryEvidence");
const { bareServiceName, isStandaloneSpinalConcern, planTcmReviewReply } = require("./utils/tcmServiceReviewReply");
const whatsappPolicy = require("./services/whatsappPolicyService");
const clinicConfig = require("./config/clinicConfig");
const { secondaryUsesPrimaryClinicContent } = require("./services/whatsappSenderActivationGate");
const { getOperationalLabels } = require("./utils/businessTerminology");
const { formatUnsupportedReview } = require("./utils/unsupportedWhatsAppReview");
const {
  deliveryErrorForSend,
  publicDeliveryError,
} = require("./utils/socialDeliveryError");
const messagesRepo = require("./db/messagesRepo");
const inboundProcessingRepo = require("./db/inboundProcessingRepo");
const whatsappOutboundRetry = require("./services/whatsappOutboundRetryService");
const { sendSecondaryStaffText } = require("./services/whatsappSecondaryStaffDispatch");
const outboundMessageEvidenceRepo = require("./db/outboundMessageEvidenceRepo");
const contactsRepo = require("./db/contactsRepo");
const pipelineRepo = require("./db/pipelineRepo");
const {
  URGENT_SAFETY_REASON,
  checkKeywordTriggers,
  isUrgentSafetyMessage,
  isActiveSafetyConcern,
  isExplicitStaffRequest,
} = require("./utils/attentionTriggers");
const realtimeEvents = require("./utils/realtimeEvents");
const {
  enqueueConversation,
  enqueueConversationBurst,
} = require("./utils/conversationQueue");
const {
  reviewLeadTemperatureForMessage,
} = require("./services/leadTemperatureAutomation");
const { createApp } = require("./createApp");
const { startApplication } = require("./services/applicationStartup");

const WHATSAPP_SEND_REJECTED_ERROR =
  "WhatsApp did not accept this message. Check the reply window or connection and try again.";

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

async function persistSendOutcome(
  savedMessage,
  sendResult,
  errorText = WHATSAPP_SEND_REJECTED_ERROR,
  channel = "whatsapp"
) {
  let updated = null;
  if (sendResult.wamid) {
    updated = await messagesRepo.setWhatsappMessageId(savedMessage.id, sendResult.wamid, {
      preserveVerifiedSecondaryReceipt: sendResult.secondarySender === true,
    });
  } else if (sendResult.externalMessageId && channel !== "whatsapp") {
    updated = await messagesRepo.setSocialProviderMessageId(
      savedMessage.id,
      `${channel}:${sendResult.externalMessageId}`,
      null
    );
  } else if (!sendResult.success) {
    updated = await messagesRepo.setDeliveryStatusById(
      savedMessage.id,
      sendResult.ambiguous ? "unknown" : "failed",
      errorText
    );
  }
  publishDeliveryStatus(updated);
  return updated || savedMessage;
}

function providerMessageId(sendResult) {
  return sendResult?.wamid || sendResult?.externalMessageId || null;
}

async function recordReadinessSendEvidence(savedMessage, contact, sendResult, origin) {
  if (!savedMessage?.id || !contact?.id) return;
  if (!["ai_reply", "system_fallback"].includes(origin)) return;

  const providerId = providerMessageId(sendResult);
  const accepted = sendResult?.success === true && Boolean(providerId);
  try {
    await outboundMessageEvidenceRepo.recordOutcome({
      messageId: savedMessage.id,
      contactId: contact.id,
      channel: contact.channel || "whatsapp",
      origin,
      accepted,
      providerMessageId: accepted ? providerId : null,
    });
  } catch (err) {
    // Readiness telemetry must never become a dependency of customer delivery.
    // Fail closed for go-live verification by leaving the evidence absent.
    console.error(
      `Failed to record ${contact.channel || "whatsapp"} ${origin} readiness evidence for message ${savedMessage.id}:`,
      err
    );
  }
}

async function sendTrackedText(
  contact,
  text,
  origin = "ai_reply",
  { canSend = null, processingJobId = null } = {}
) {
  const guarded = typeof canSend === "function";

  if (guarded && canSend() !== true) {
    return {
      finalMessage: null,
      sendResult: { success: false, wamid: null, cancelled: true, error: null },
    };
  }

  // For durable inbound work, reserve the assistant row and the outbound-attempt
  // marker in one database transaction before calling Meta. A restart after
  // this point is therefore reconciled as accepted/rejected/ambiguous instead
  // of blindly generating and sending the same turn again.
  let saved;
  let durableOutboundReserved = false;
  if (processingJobId) {
    const reservation = await inboundProcessingRepo.reserveOutboundAttempt({
      processingJobId,
      contactId: contact.id,
      content: text,
      origin,
    });
    if (reservation.alreadyStarted) {
      const err = new Error(
        `Inbound processing job ${processingJobId} already has an outbound attempt.`
      );
      err.code = "INBOUND_OUTBOUND_ALREADY_STARTED";
      throw err;
    }
    saved = reservation.message;
    durableOutboundReserved = true;
    if (!guarded) {
      realtimeEvents.publish("conversation_changed", {
        contactId: saved.contact_id,
        messageId: saved.id,
        reason: "message",
      });
    }
  } else {
    // Compatibility path for callers that are not backed by a durable inbound
    // processing job.
    saved = await conversationStore.appendMessageForContact(
      contact.id,
      "assistant",
      text,
      null,
      null,
      null,
      null,
      guarded ? { publish: false } : undefined
    );
  }

  const socialProviderRecorder = messagesRepo.socialProviderAliasRecorder(
    saved.id,
    contact.channel
  );

  let sendResult;
  try {
    const verifiedContact = contact.channel === "whatsapp" &&
      contact.whatsapp_sender_id != null && !contact.whatsapp_sender_key
      ? await contactsRepo.getContactById(contact.id) : contact;
    if (verifiedContact?.whatsapp_sender_id != null &&
        (!verifiedContact.whatsapp_sender_key ||
         !verifiedContact.whatsapp_sender_phone_number_id ||
         !verifiedContact.whatsapp_sender_account_id)) {
      throw new Error("Cannot verify persisted WhatsApp sender before AI dispatch.");
    }
    const secondaryAi = verifiedContact.channel === "whatsapp" &&
      verifiedContact.whatsapp_sender_id != null &&
      verifiedContact.whatsapp_sender_key !== process.env.WHATSAPP_PRIMARY_SENDER_KEY;
    sendResult = secondaryAi
      ? await sendSecondaryStaffText({
          contact: verifiedContact, messageId: saved.id, text, origin,
          preSendCheck: guarded ? canSend : null,
        })
      : await channelMessaging.sendText(
          contact,
          text,
          {
            ...(guarded ? { preSendCheck: canSend } : {}),
            currentMessageId: saved.id,
            ...(socialProviderRecorder
              ? { onProviderMessageId: socialProviderRecorder }
              : {}),
          }
        );
  } catch (err) {
    if (durableOutboundReserved) {
      const ambiguousReason =
        "Delivery could not be confirmed because the messaging request was interrupted. Check the customer chat before replying to avoid sending it twice.";
      try {
        const ambiguous = await inboundProcessingRepo.markOutboundAttemptAmbiguous(
          processingJobId,
          ambiguousReason
        );
        if (ambiguous?.message) {
          publishDeliveryStatus(ambiguous.message);
        }
      } catch (markErr) {
        console.error(
          `Failed to mark interrupted outbound attempt for inbound job ${processingJobId}:`,
          markErr
        );
      }
      err.outboundDeliveryAmbiguous = true;
    }
    throw err;
  }

  if (sendResult.cancelled) {
    if (durableOutboundReserved) {
      const cancelledAttempt = await inboundProcessingRepo.cancelOutboundAttempt(
        processingJobId
      );
      if (!cancelledAttempt?.cancelled) {
        const err = new Error(
          `Inbound processing job ${processingJobId} could not be durably cancelled.`
        );
        err.code = "INBOUND_OUTBOUND_CANCEL_NOT_SAFE";
        throw err;
      }
    } else {
      await messagesRepo.deleteUnsentAssistantMessage(saved.id);
    }
    return { finalMessage: null, sendResult };
  }

  if (guarded) {
    realtimeEvents.publish("conversation_changed", {
      contactId: saved.contact_id,
      messageId: saved.id,
      reason: "message",
    });
  }

  const errorText = sendResult.error || channelMessaging.rejectedError(contact.channel);
  const finalMessage = await persistSendOutcome(
    saved,
    sendResult,
    errorText,
    contact.channel || "whatsapp"
  );
  if (durableOutboundReserved) {
    await inboundProcessingRepo.finalizeOutboundAttempt(
      processingJobId,
      {
        outcome: sendResult.success
          ? "accepted"
          : sendResult.ambiguous
            ? "ambiguous"
            : "rejected",
        providerMessageId: providerMessageId(sendResult),
        errorText: sendResult.success ? null : errorText,
      }
    ).catch((err) => {
      // The provider outcome is already reflected on the message row. Recovery
      // can reconcile from that row if this bookkeeping write is interrupted.
      console.error(
        `Failed to finalize outbound attempt for inbound job ${processingJobId}:`,
        err
      );
    });
  }
  if (!sendResult.success) {
    let retryQueued = false;

    if (
      contact.channel === "whatsapp" &&
      sendResult.retryable === true &&
      sendResult.ambiguous !== true &&
      ["ai_reply", "system_fallback"].includes(origin)
    ) {
      try {
        const queued = await whatsappOutboundRetry.queueTextRetry({
          messageId: saved.id,
          contactId: contact.id,
          recipient: contact.whatsapp_number,
          origin,
          sendResult,
        });
        retryQueued = Boolean(queued);
        if (retryQueued) {
          console.warn(
            `Queued transient WhatsApp send failure for message ${saved.id} for automatic retry.`
          );
        }
      } catch (retryQueueErr) {
        console.error(
          `Failed to queue WhatsApp retry for message ${saved.id}:`,
          retryQueueErr
        );
      }
    }

    if (!retryQueued) {
      await contactsRepo.setDeliveryAttention(
        contact.id,
        sendResult.ambiguous
          ? `Delivery unconfirmed: ${errorText}`
          : `Delivery failed: ${errorText}`,
        saved.id
      );

      // Do not extend the customer-delivery path for readiness telemetry.
      // A queued transient retry deliberately skips the initial rejected
      // evidence so a late async write cannot overwrite a later successful
      // retry's accepted evidence.
      recordReadinessSendEvidence(saved, contact, sendResult, origin);
    }
  } else {
    recordReadinessSendEvidence(saved, contact, sendResult, origin);
  }

  return { finalMessage, sendResult };
}

function unwrapIncoming(item) {
  return item?.incoming || item;
}

function dedupeIncomingBatch(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const incoming = unwrapIncoming(item);
    const channel = incoming?.channel || "whatsapp";
    const id = incoming?.id;
    const key = id ? `${channel}:${id}` : `${channel}:${incoming?.from}:${result.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function canGenerateAutomatedReplyForIncoming(item) {
  const incoming = unwrapIncoming(item);
  // Stickers and captionless videos are real customer turns for unread/follow-up
  // semantics, but the bot must not invent meaning from media it does not
  // interpret. If either lands at the end of a typing burst, reply to the last
  // text/voice/photo/captioned-video turn instead.
  if (incoming?.unsupportedType) return false;
  if (incoming?.mediaType === "sticker") return false;
  if (incoming?.mediaType === "video" && !String(incoming?.text || "").trim()) {
    return false;
  }
  return true;
}

async function processIncomingBatch(items) {
  const batch = dedupeIncomingBatch(items);
  if (!batch.length) return;

  let firstMessageWasSuppressed = false;
  let inheritedKeywordReason = null;
  let replyTargetIndex = -1;
  // Safety incidents and explicit staff requests take priority over other
  // messages in a burst; normal later questions remain staff-visible.
  for (let index = batch.length - 1; index >= 0; index -= 1) {
    const incoming = unwrapIncoming(batch[index]);
    const message = String(incoming?.text || "");
    if (canGenerateAutomatedReplyForIncoming(batch[index]) &&
        Boolean(checkKeywordTriggers(message))) {
      replyTargetIndex = index;
      break;
    }
  }
  if (replyTargetIndex < 0) {
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      if (canGenerateAutomatedReplyForIncoming(batch[index])) {
        replyTargetIndex = index;
        break;
      }
    }
  }

  for (let index = 0; index < batch.length; index += 1) {
    const isReplyTarget = index === replyTargetIndex;
    const result = await processIncomingMessage(batch[index], {
      suppressAutoReply: !isReplyTarget,
      forceFirstMessage: isReplyTarget && firstMessageWasSuppressed,
      inheritedKeywordReason,
    });

    if (result?.wasFirstMessage) firstMessageWasSuppressed = true;
    // Never make a benign final enquiry inherit an earlier complaint or
    // ordinary staff-review keyword. Only urgent safety stays sticky.
    if (result?.keywordReason === URGENT_SAFETY_REASON) {
      inheritedKeywordReason = URGENT_SAFETY_REASON;
    }
  }
}

/**
 * Store only the durable webhook state. This runs on the short per-contact
 * claim queue and is safe to await before returning HTTP 200 to Meta because
 * it does no media download, transcription or AI work.
 */
async function durablyClaimIncoming(queueKey, incoming) {
  return enqueueConversation(
    queueKey,
    () => storeIncomingMessage(incoming)
  );
}

/**
 * After the webhook has been acknowledged, lease the durable job, complete the
 * normal bookkeeping and feed it into the existing typing-burst processor.
 */
async function scheduleDurableClaim(queueKey, durableClaim) {
  // Even with a durable inbound claim, the isolated provider rehearsal is
  // receive-only. Do not lease or process a customer turn in staging.
  if (process.env.PR395_STAGING_MODE === "true") return null;
  if (!durableClaim) return null;
  try {
    const prepared = await enqueueConversation(
      queueKey,
      () => prepareIncomingClaim(durableClaim)
    );
    if (!prepared) return null;

    return await enqueueConversationBurst(
      queueKey,
      prepared,
      (items) => processClaimedBatch(items, processIncomingBatch)
    );
  } catch (err) {
    const incoming = durableClaim.incoming || {};
    console.error(
      `Failed to prepare/queue incoming ${incoming.channel || "whatsapp"} message ${incoming.id || "without id"}:`,
      err
    );
    return null;
  }
}

/** Compatibility helper for resolved Meta edit events and internal callers. */
async function queueIncomingForReply(queueKey, incoming) {
  try {
    const durableClaim = await durablyClaimIncoming(queueKey, incoming);
    if (!durableClaim) {
      console.log(
        `Skipping duplicate/retried ${incoming.channel || "whatsapp"} message ${incoming.id}`
      );
      return null;
    }
    return scheduleDurableClaim(queueKey, durableClaim);
  } catch (err) {
    console.error(
      `Failed to durably claim incoming ${incoming.channel || "whatsapp"} message ${incoming.id || "without id"}:`,
      err
    );
    return null;
  }
}

async function processIncomingMessage(
  item,
  {
    suppressAutoReply = false,
    forceFirstMessage = false,
    inheritedKeywordReason = null,
  } = {}
) {
  const preclaimed = item?.incoming && item?.contact && item?.savedInbound
    ? item
    : null;
  const incoming = preclaimed?.incoming || item;
  const {
    id,
    from,
    mediaType,
    unsupportedType,
  } = incoming;
  const channel = incoming.channel || "whatsapp";
  let aiCancellationKey = null;
  let aiCancellationToken = 0;
  let canSendAutomatedReply = null;

  const { customerLabel, customerSingular } = getOperationalLabels(clinicConfig);
  let contact = preclaimed?.contact || null;
  let savedInbound = preclaimed?.savedInbound || null;
  let processingJobId = preclaimed?.processingJobId || null;
  let responseAttempted = false;
  let wasFirstMessage = Boolean(preclaimed?.wasFirstMessage);
  let keywordReason = inheritedKeywordReason;

  try {
    // Keep a direct-call fallback for internal/tests, but normal webhook flow
    // arrives here already durably claimed before the reply debounce starts.
    if (!preclaimed) {
      const claimed = await claimIncomingMessage(incoming);
      if (!claimed) {
        console.log(`Skipping duplicate/retried ${channel} message ${id}`);
        return { wasFirstMessage: false, keywordReason };
      }
      contact = claimed.contact;
      savedInbound = claimed.savedInbound;
      processingJobId = claimed.processingJobId || null;
      wasFirstMessage = Boolean(claimed.wasFirstMessage);
    }

    const senderScoped = channel === "whatsapp" &&
      process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true";
    if (senderScoped && !contact?.whatsapp_sender_key) {
      throw new Error("Sender-scoped AI reply cannot resolve a verified sender key.");
    }
    const secondaryAiConversation = senderScoped &&
      contact.whatsapp_sender_key === process.env.WHATSAPP_SECONDARY_SENDER_KEY &&
      process.env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED === "true" &&
      process.env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true" &&
      // Recheck at dispatch as defense in depth. A runtime flag toggle must
      // not make secondary WhatsApp generate Neutro-branded replies without authorization.
      secondaryUsesPrimaryClinicContent(process.env);
    const secondaryInboxOnly = senderScoped &&
      process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
      contact.whatsapp_sender_key === process.env.WHATSAPP_SECONDARY_SENDER_KEY &&
      !secondaryAiConversation;
    aiCancellationKey = channel === "whatsapp"
      ? aiReplyCancellation.keyForWhatsAppNumber(
          from, senderScoped ? contact.whatsapp_sender_key : null
        )
      : (channel === "facebook" || channel === "instagram")
        ? aiReplyCancellation.keyForChannelContact(channel, from)
        : null;
    aiCancellationToken = aiReplyCancellation.snapshot(aiCancellationKey);
    canSendAutomatedReply = aiCancellationKey
      ? () => aiReplyCancellation.safeToSend(aiCancellationKey, aiCancellationToken)
      : null;

    if (unsupportedType) {
      // Meta diagnostics are staff-only. Never invent a customer response.
      const label = channelMessaging.labelForChannel(channel);
      await contactsRepo.setAiReviewAttention(
        contact.id,
        savedInbound.id,
        formatUnsupportedReview({
          channelLabel: label,
          unsupportedType,
          detail: incoming.unsupportedErrors?.[0] || {},
        }),
        "information"
      );
      return { wasFirstMessage, keywordReason };
    }

    let text = incoming.text || "";
    let mediaAttachment = null;

    if (mediaType === "audio") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      const [transcript, mp3] = media
        ? await Promise.all([
            transcribeAudio(media.buffer, media.mimeType, { contactId: contact.id }),
            convertToMp3(media.buffer),
          ])
        : [null, null];

      if (media) {
        mediaAttachment = mp3
          ? { mimeType: mp3.mimeType, buffer: mp3.buffer }
          : {
              mimeType: media.mimeType.split(";")[0].trim(),
              buffer: media.buffer,
            };
      }

      if (!transcript) {
        await conversationStore.updateInboundMessage(
          contact.id,
          savedInbound.id,
          "🎤 [Voice message could not be transcribed]",
          mediaAttachment
        );
        await contactsRepo.setAiReviewAttention(
          contact.id, savedInbound.id,
          `A ${customerSingular} voice message could not be transcribed. Listen in Inbox if needed.`,
          "information"
        );

        // Keep this unreadable attachment for staff; no automatic apology.
        return { wasFirstMessage, keywordReason };
      }

      text = `🎤 ${transcript}`;
      await conversationStore.updateInboundMessage(
        contact.id,
        savedInbound.id,
        text,
        mediaAttachment
      );
    }

    if (mediaType === "image") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      if (!media) {
        await contactsRepo.setAiReviewAttention(
          contact.id, savedInbound.id,
          `A ${customerSingular} photo could not be downloaded.`,
          "information"
        );
        // A photo can have a valid text caption. Staff reviews the missing
        // picture, but the caption must still be handled as an ordinary
        // customer question, not silently discarded.
        if (!String(incoming.text || "").trim()) {
          return { wasFirstMessage, keywordReason };
        }
      } else {
        mediaAttachment = { mimeType: media.mimeType, buffer: media.buffer };
      }

      text = incoming.text ? `📷 ${incoming.text}` : `📷 [${customerLabel} sent a photo]`;
      await conversationStore.updateInboundMessage(
        contact.id, savedInbound.id, text, mediaAttachment
      );
    }

    if (mediaType === "video") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      text = incoming.text
        ? `🎥 ${incoming.text}`
        : `🎥 [${customerLabel} sent a video]`;

      if (media) {
        const downloadedMime = String(media.mimeType || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        mediaAttachment = {
          mimeType: downloadedMime.startsWith("video/")
            ? downloadedMime
            : "video/mp4",
          buffer: media.buffer,
        };

        try {
          await conversationStore.updateInboundMessage(
            contact.id,
            savedInbound.id,
            text,
            mediaAttachment
          );
        } catch (videoStorageErr) {
          // The durable inbound placeholder is already visible in the Inbox.
          // Storage failure should not trigger a misleading AI/system reply.
          console.error(
            `Failed to store WhatsApp video media for ${channel}:${from}; keeping the durable placeholder:`,
            videoStorageErr
          );
          await contactsRepo.setAiReviewAttention(
            contact.id, savedInbound.id,
            `A ${customerSingular} video could not be stored.`,
            "information"
          );
          mediaAttachment = null;
        }
      } else {
        console.warn(
          `Could not download WhatsApp video ${incoming.mediaId || id || "without media id"} for ${from}; keeping the durable placeholder.`
        );
        await contactsRepo.setAiReviewAttention(
          contact.id, savedInbound.id,
          `A ${customerSingular} video could not be downloaded.`,
          "information"
        );
      }
    }

    if (mediaType === "sticker") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      text = `🙂 [${customerLabel} sent a sticker]`;

      if (media) {
        const downloadedMime = String(media.mimeType || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        mediaAttachment = {
          // WhatsApp stickers are WebP media. Keep a defensive image fallback
          // so a missing/odd provider MIME does not make the Inbox download
          // render as an arbitrary binary attachment.
          mimeType: downloadedMime.startsWith("image/")
            ? downloadedMime
            : "image/webp",
          buffer: media.buffer,
        };
      } else {
        console.warn(
          `Could not download WhatsApp sticker ${incoming.mediaId || id || "without media id"} for ${from}; keeping the customer turn as a text placeholder.`
        );
      }

      try {
        await conversationStore.updateInboundMessage(
          contact.id,
          savedInbound.id,
          text,
          mediaAttachment
        );
      } catch (stickerStorageErr) {
        // The durable inbound claim already contains the neutral sticker
        // placeholder. Sticker artwork is optional UI media, so an R2/storage
        // problem must not trigger the generic customer-facing error reply or
        // hand the conversation to staff. A later customer turn should continue
        // normally even if this sticker could not be attached.
        console.error(
          `Failed to store WhatsApp sticker media for ${channel}:${from}; keeping the durable placeholder without changing ownership:`,
          stickerStorageErr
        );
        mediaAttachment = null;
      }
    }

    // Preserve incoming secondary media before handing the turn to staff.
    // Do not enter any AI response, promotion, or auto-follow-up path.
    if (secondaryInboxOnly) {
      await contactsRepo.setAiReviewAttention(contact.id, savedInbound.id,
        "Secondary WhatsApp Inbox: reply using the linked Business App. " +
        "Cloud API sending for this number is not yet enabled.",
        "information");
      return { wasFirstMessage, keywordReason };
    }

    // Photos/videos without captions and stickers contain no textual intent
    // that can safely support a sales-temperature decision.
    const temperatureReviewEligible = Boolean(text.trim()) && !(
      (mediaType === "image" && !incoming.text) ||
      (mediaType === "video" && !incoming.text) ||
      mediaType === "sticker"
    );

    if (temperatureReviewEligible) {
      try {
        await reviewLeadTemperatureForMessage(contact.id, savedInbound.id, text);
      } catch (temperatureErr) {
        // Lead categorization must never prevent or replace a customer reply.
        console.error(
          `Failed to apply lead temperature rules for contact ${contact.id}:`,
          temperatureErr
        );
      }
    }

    // Preserve a real customer acceptance of the latest verified STAFF offer
    // before calling the model. It is a pending preference, NOT a booking.
    let acceptedStaffOffer = null;
    if (["aesthetic_clinic", "tcm_clinic"].includes(clinicConfig.businessType)) {
      try {
        acceptedStaffOffer = await recordStaffAppointmentAcceptance(contact.id, savedInbound.id, text);
      } catch (agreementError) {
        console.error(`Could not record staff appointment acceptance for contact ${contact.id}:`, agreementError);
      }
    }

    const hasInterpretableText =
      mediaType !== "sticker" &&
      !(mediaType === "video" && !String(incoming.text || "").trim());
    const currentKeywordReason =
      hasInterpretableText ? checkKeywordTriggers(text) : null;
    const urgentSafety =
      hasInterpretableText &&
      (isUrgentSafetyMessage(text) || inheritedKeywordReason === URGENT_SAFETY_REASON);
    keywordReason = urgentSafety
      ? URGENT_SAFETY_REASON
      : currentKeywordReason;

    // Re-read ownership after media processing. Staff may have taken over
    // while a download or transcription was running.
    const currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact) throw new Error(`Contact ${contact.id} disappeared during processing.`);
    contact = currentContact;

    if (contact.mode === "human") {
      await contactsRepo.setAttention(
        contact.id,
        true,
        keywordReason || "New message — conversation is staff-owned.",
        {
          // Routine inbound messages in an already staff-owned conversation
          // should update Inbox attention without becoming phone push spam.
          // Deterministic keyword/safety escalations remain high priority.
          notifyWebPush: Boolean(keywordReason),
        }
      );
      console.log(`Skipping AI reply for ${channel}:${from} — conversation is in human mode.`);
      return { wasFirstMessage, keywordReason };
    }

    if (mediaType === "video" && !String(incoming.text || "").trim()) {
      // The Inbox can play the stored video, but the AI does not inspect video
      // frames or audio. Keep captionless videos as genuine inbound turns
      // without inventing a response from media content it cannot interpret.
      // Surface the turn to staff while leaving AI ownership unchanged so the
      // next normal customer message can still be handled automatically.
      await contactsRepo.setAiReviewAttention(
        contact.id, savedInbound.id,
        `${customerLabel} sent a video without a caption. Review frames in Inbox.`,
        "information"
      );
      console.log(
        `Stored WhatsApp video for ${channel}:${from} without generating an AI reply.`
      );
      return { wasFirstMessage, keywordReason };
    }

    if (mediaType === "sticker") {
      // Stickers deliberately stop here. They remain genuine inbound customer
      // turns (unread + follow-up boundary), but no AI interpretation or
      // customer-facing fallback is generated from the artwork.
      console.log(
        `Stored WhatsApp sticker for ${channel}:${from} without generating an AI reply.`
      );
      return { wasFirstMessage, keywordReason };
    }

    const staffAlreadyReplied = await messagesRepo.hasStaffReplyAfter(
      contact.id,
      savedInbound.id
    );
    if (staffAlreadyReplied) {
      // A live staff assist answers this turn without permanently taking over.
      // Avoid a duplicate customer reply. Urgent safety still locks ownership
      // until staff explicitly releases it, even when staff answered quickly.
      if (keywordReason === URGENT_SAFETY_REASON) {
        await pauseAiForHumanHandoff(contact.id, keywordReason);
      }
      console.log(
        `Skipping AI reply for ${channel}:${from} — staff already answered this customer turn.`
      );
      return { wasFirstMessage, keywordReason };
    }

    // Earlier messages in the same typing burst are fully saved/transcribed and
    // included in history, but only the last one gets an AI response. This is
    // what turns three short chat bubbles into one coherent assistant reply.
    if (suppressAutoReply) {
      // A prior non-urgent issue in the burst must still be visible to staff
      // even when the final text is the only customer-facing AI answer.
      if (keywordReason && keywordReason !== URGENT_SAFETY_REASON) {
        await contactsRepo.setAiReviewAttention(
          contact.id, savedInbound.id, String(text).slice(0, 350), "clinical"
        );
      }
      return { wasFirstMessage, keywordReason };
    }

    if (!automatedRepliesEnabled()) {
      // Even with replies globally disabled, every deterministic safety,
      // complaint and human-request keyword must alert staff. Use the legacy
      // recovery reason only for nonmedical takeovers (PR #304).
      if (keywordReason) {
        const medicalConcern = keywordReason === URGENT_SAFETY_REASON ||
          isActiveSafetyConcern(text);
        const pausedContact = await pauseAiForHumanHandoff(
          contact.id,
          medicalConcern ? keywordReason : "AI handed off this conversation."
        );
        if (pausedContact) contact = pausedContact;
      }
      console.log(`Skipping AI reply for ${channel}:${from} — automated replies are globally paused.`);
      return { wasFirstMessage, keywordReason };
    }

    const history = await conversationStore.getHistoryForContact(contact.id, {
      throughMessageId: savedInbound.id,
    });
    const mediaLanguage = detectConversationLanguage(
      history
        .slice()
        .reverse()
        .filter((message) => message?.role === "user")
        .map((message) => message.content)
    );
    const marketingStopQuestion = whatsappPolicy.extractQuestionAfterMarketingOptOut(text);
    // Keep the actual customer message intact in Neon. Only the model's
    // current-turn context is narrowed to the separately asked service question
    // so it cannot interpret the marketing refusal as a request for a deal.
    const replyHistory = marketingStopQuestion
      ? history.map((entry, index) => index === history.length - 1 && entry?.role === "user"
          ? { ...entry, content: marketingStopQuestion } : entry)
      : history;
    const isFirstMessage = forceFirstMessage || history.length === 1;
    const customerMessages = history.filter((message) => message?.role === "user");
    const newestCustomerText = customerMessages.at(-1)?.content || text;
    const generateFirstIntro = isFirstMessage && shouldGenerateLocalizedIntro(
      newestCustomerText,
      clinicConfig.introMessage
    );

    // High-confidence urgent safety phrases must not depend on an AI provider.
    // Bypass model generation completely so outages/capacity failures cannot
    // replace immediate-care guidance with the generic processing-error reply.
    let aiReply;
    let flagged = false;
    let reviewRequired = false;
    let reviewType = null;
    let clinicalAcknowledgement = null;
    let bookingReady = false;
    let serviceQuery = false;
    let serviceQuerySource = null;
    let metaAdContext = null;
    let metaAdCreativeService = null;
    let priceQuery = false;
    let packageQuery = false;
    let details = null;
    let fixedAdFirstReply = null;
    // Treat a digit as a pricing choice only when it answers a recent,
    // assistant-authored numbered service menu in an active price thread.
    // This avoids Gemini timeout/fallback and spurious clinical reviews for "1".
    const numberedPricingSelection = !keywordReason && !marketingStopQuestion &&
      clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
      ? resolveNumberedPricingMenuSelection({
          customerText: text, conversationHistory: history,
          services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
        }) : null;

    if (urgentSafety || isActiveSafetyConcern(text)) {
      flagged = true;
      aiReply = fallbackHandoffReply(
        text,
        clinicConfig.escalation.handoffMessage,
        { urgent: true }
      );
    } else if (isExplicitStaffRequest(text)) {
      flagged = true;
      aiReply = fallbackHandoffReply(text, clinicConfig.escalation.handoffMessage);
    } else {
      try {
        // This is a local Postgres lookup only. Meta enrichment stays
        // fire-and-forget, so a Graph API delay/failure can never block the
        // customer reply. Creative copy takes priority. Internal ad names may
        // contribute only a canonical configured service, not raw metadata.
        metaAdContext = await loadMetaAdReplyContext(contact.id, {
          services: clinicConfig.services,
          aliases: clinicConfig.serviceAliases,
          promotions: clinicConfig.promotions,
        });
        metaAdCreativeService = resolveMetaAdCreativeService(
          metaAdContext,
          clinicConfig.services,
          clinicConfig.serviceAliases
        );
      } catch (contextErr) {
        console.error(
          `Failed to load Meta ad reply context for contact ${contact.id}:`,
          contextErr
        );
      }

      // The CRM booking status is separate from chat text. Give the model the
      // verified status so an accepted staff offer does not become a fabricated
      // reservation, and a confirmed booking does not request confirmation again.
      let bookingContext = null;
      try {
        const lead = await pipelineRepo.getActiveLeadForContact(contact.id);
        if (lead) {
          bookingContext = {
            status: lead.appointment_status,
            appointmentAt: lead.appointment_at,
            ...(acceptedStaffOffer ? { acceptedStaffOffer: acceptedStaffOffer.agreedTimeText } : {}),
          };
        }
      } catch (bookingContextErr) {
        console.warn(`Failed to load appointment state for contact ${contact.id}:`, bookingContextErr);
      }
      fixedAdFirstReply = !keywordReason && !marketingStopQuestion
        ? resolveFixedAdFirstReply({
            config: clinicConfig.adFirstReply,
            // Use the durable all-message first-turn evidence. The AI context
            // filters failed/sticker rows and is not a reliable uniqueness test.
            isFirstMessage: wasFirstMessage === true,
            conversationHistory: history,
            customerText: text,
            language: mediaLanguage,
            metaAdContext,
            metaAdCreativeService,
            keywordReason,
            isTextMessage: !mediaType || mediaType === "text",
            hasExistingBooking: Boolean(acceptedStaffOffer ||
              bookingContext?.appointmentAt ||
              bookingContext?.acceptedStaffOffer ||
              /^(?:booked|confirmed|scheduled)$/iu.test(String(bookingContext?.status || ""))),
            services: clinicConfig.services,
            serviceAliases: clinicConfig.serviceAliases,
            businessName: clinicConfig.businessName,
            onSkip: (reason) => {
              if (metaAdContext) console.info(
                "[Fixed ad first reply] decision=ai_fallback contact=" + contact.id +
                " inbound=" + savedInbound.id + " reason=" + reason
              );
            },
          }) : null;
      if (numberedPricingSelection) {
        // This is an independently verified customer choice, not an inferred
        // model outcome. Price and media remain subject to downstream guards.
        aiReply = "我帮你核对这项疗程的最新配套价格 😊";
        priceQuery = true;
        details = { treatment: numberedPricingSelection.treatment };
      } else if (fixedAdFirstReply) {
        aiReply = fixedAdFirstReply.reply;
        serviceQuery = fixedAdFirstReply.serviceQuery;
        serviceQuerySource = fixedAdFirstReply.serviceQuerySource;
        details = { treatment: fixedAdFirstReply.treatment };
        console.info("[Fixed ad first reply] contact=" + contact.id +
          " inbound=" + savedInbound.id + " treatment=" + fixedAdFirstReply.treatment);
      } else {
        const rawAiReply = await ai.getReply(replyHistory, {
          bookingContext,
          contactId: contact.id,
          isFirstMessage,
          generateFirstIntro,
          channel,
          metaAdContext,
        });
        const parsedReply = parseAiReplyResult(rawAiReply);
        ({
          text: aiReply,
          flagged,
          reviewRequired,
          reviewType,
          bookingReady,
          serviceQuery,
          serviceQuerySource,
          priceQuery,
          packageQuery,
          details,
        } = parsedReply);
      }

      // A model can miss a clear complaint, refund or legal escalation.
      // These need staff ownership, unlike a single unknown FAQ.
      if (keywordReason && (!flagged || reviewRequired)) {
        flagged = true;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
        aiReply = fallbackHandoffReply(text, clinicConfig.escalation.handoffMessage);
      }
      // Resolve exact TCM treatment names using verified current config, the
      // recent conversation, and durable unresolved clinical reviews. Do not
      // downgrade clinical concerns simply because the latest message names a
      // service. A narrowly safe acknowledgment can accompany a staff review,
      // but never enables promotional images, follow-ups or booking actions.
      if (!keywordReason && !bookingReady && (!flagged || reviewRequired) &&
          clinicConfig.businessType === "tcm_clinic" &&
          (bareServiceName(text, clinicConfig.services, clinicConfig.serviceAliases) ||
           isStandaloneSpinalConcern(text))) {
        const verifiedEvidence = await contactsRepo.getTcmReviewEvidence(
          contact.id, savedInbound.id
        );
        if (verifiedEvidence) {
          const plan = planTcmReviewReply({
            businessType: clinicConfig.businessType,
            customerText: text,
            language: mediaLanguage,
            services: clinicConfig.services,
            serviceAliases: clinicConfig.serviceAliases,
            conversationHistory: history,
            ...verifiedEvidence,
          });
          if (plan?.preserveReview) {
            flagged = true;
            reviewRequired = true;
            reviewType = "clinical";
            clinicalAcknowledgement = plan.reply;
            bookingReady = false;
            serviceQuery = false;
            serviceQuerySource = null;
            priceQuery = false;
            packageQuery = false;
            details = null;
          } else if (plan?.reply && reviewRequired) {
            // Isolated, unpriced service name with no unresolved clinical issue.
            aiReply = plan.reply;
            flagged = false;
            reviewRequired = false;
            reviewType = null;
            bookingReady = false;
            serviceQuery = false;
            serviceQuerySource = null;
            priceQuery = false;
            packageQuery = false;
            details = null;
          } else if (plan?.reply && !flagged && plan.alreadyInvited) {
            // Do not send the same assessment invitation again when a patient
            // lists several treatments in separate WhatsApp messages.
            aiReply = plan.reply;
          }
        } else {
          // A failed clinical-review lookup must not permit recovery.
          flagged = true;
          reviewRequired = true;
          reviewType = "clinical";
          bookingReady = false;
        }
      }

      // The clinic has already verified this administrative fee: the
      // introductory posture assessment + experience is free. Do not escalate
      // a model's stale "centre needs to confirm" answer to staff. Preserve
      // all clinical/safety and explicit human-request handoffs.
      const verifiedFreeIntroFee = isComplimentaryAssessmentFeeQuestion(
        text,
        clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
        history
      ) && !urgentSafety && !isActiveSafetyConcern(text) &&
        !isExplicitStaffRequest(text) && !hasClinicalMediaRisk(text);
      if (verifiedFreeIntroFee &&
          (!flagged || (reviewRequired && reviewType === "information"))) {
        aiReply = complimentaryAssessmentFeeReply(mediaLanguage);
        flagged = false;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
      }
      // Do not permit a model to smuggle an inability-to-answer apology
      // through a nominally normal outcome.
      if (!flagged && isUnanswerableCustomerReply(aiReply, text)) {
        flagged = true;
        reviewRequired = true;
        reviewType = "information";
        bookingReady = false;
      }
    }

    // Full multi-turn information-review recovery remains Enabled-only.
    // In Shadow, only a separate independently verified early-treatment or
    // current-Meta-ad pricing exception may use the legacy reply path.
    const aiPricingMode = clinicConfig.aiPricingIntentMode || "off";
    const aiPricingEnabled = aiPricingMode === "enabled";
    const shadowPriceException = aiPricingMode === "shadow" &&
      clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
      !keywordReason && !urgentSafety && !isActiveSafetyConcern(text) &&
      !isExplicitStaffRequest(text) && !marketingStopQuestion
      ? resolveShadowPriceException({
          customerText: text, conversationHistory: history, metaAdContext,
          services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
          promotions: clinicConfig.promotions,
          allowOfferEnquiries: clinicConfig.aiPricingOfferEnquiriesEnabled === true,
          complimentaryAssessmentExperienceEnabled:
            clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
        }) : null;
    if (aiPricingEnabled &&
        flagged && reviewRequired && reviewType === "information" &&
        clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
        !keywordReason && !urgentSafety && !isActiveSafetyConcern(text) &&
        !isExplicitStaffRequest(text) && !marketingStopQuestion) {
      const reviewEvidence = await contactsRepo.getTcmReviewEvidence(
        contact.id, savedInbound.id
      );
      const recovered = planInformationPriceRecovery({
        enabled: true, flagged, reviewRequired, reviewType,
        customerText: text, conversationHistory: history,
        services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
        promotions: clinicConfig.promotions, resultMedia: clinicConfig.resultMedia,
        language: mediaLanguage, hasKeywordAlert: Boolean(keywordReason),
        urgentSafety, activeSafety: isActiveSafetyConcern(text),
        explicitStaffRequest: isExplicitStaffRequest(text),
        marketingStop: Boolean(marketingStopQuestion),
        pendingClinicalReview: reviewEvidence?.pendingClinicalReview,
      });
      if (recovered) {
        aiReply = recovered.reply;
        flagged = false;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
        priceQuery = true;
        packageQuery = false;
        details = { ...details, treatment: recovered.treatment };
        console.info(
          "[Pricing] Recovered verified informational review for " +
          "contact=" + contact.id + " inbound=" + savedInbound.id
        );
      }
    }

    // Recover narrowly verified Shadow price questions ONLY if the AI
    // classified them as informational review and Neon confirms that no
    // clinical review is pending. Clinical, safety and staff handoffs never
    // enter this path. No extension of general AI-led pricing is enabled.
    if (shadowPriceException && flagged && reviewRequired &&
        reviewType === "information") {
      const reviewEvidence = await contactsRepo.getTcmReviewEvidence(
        contact.id, savedInbound.id
      );
      if (reviewEvidence?.pendingClinicalReview === false) {
        flagged = false;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
        priceQuery = true;
        packageQuery = false;
        details = { ...details, treatment: shadowPriceException.treatment };
        aiReply = "我帮你核对这项疗程的价格 😊";
        console.info("[Pricing] Recovered narrow Shadow price information review " +
          "contact=" + contact.id + " inbound=" + savedInbound.id);
      }
    }

    // A model can classify an objectively answerable TWO-treatment price
    // question as an INFORMATION review. Resolve the two independently
    // verified offers first; only a fresh Neon check confirming NO pending
    // clinical review may clear that specific information flag.
    // Keep clinical, staff, safety, consent and billing controls unchanged.
    const recoverableTwoPriceReview = flagged && reviewRequired &&
      reviewType === "information";
    let twoTreatmentQuote = aiPricingMode === "shadow" &&
      clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
      (!flagged || recoverableTwoPriceReview) &&
      !bookingReady && !keywordReason && !urgentSafety &&
      !isActiveSafetyConcern(text) && !isExplicitStaffRequest(text) &&
      !marketingStopQuestion
      ? resolveTwoTreatmentPriceReply({
          customerText: text,
          session: recentVerifiedPricingSession(history, text),
          services: clinicConfig.services,
          serviceAliases: clinicConfig.serviceAliases,
          promotions: clinicConfig.promotions,
          language: mediaLanguage,
        }) : null;
    if (twoTreatmentQuote && recoverableTwoPriceReview) {
      const reviewEvidence = await contactsRepo.getTcmReviewEvidence(
        contact.id, savedInbound.id
      );
      if (canRecoverTwoPriceInformationReview({
        quote: twoTreatmentQuote, flagged, reviewRequired, reviewType,
        pendingClinicalReview: reviewEvidence?.pendingClinicalReview,
      })) {
        flagged = false;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
        priceQuery = true;
        packageQuery = false;
        aiReply = "我帮你确认这两项护理各自的价格 😊";
        console.info("[Pricing] Recovered verified two-price information review " +
          "contact=" + contact.id + " inbound=" + savedInbound.id);
      } else {
        twoTreatmentQuote = null;
      }
    }

    // A customer-confirmed ad treatment can scope "all of them" to the
    // packages of THAT treatment only when the previous user asked about
    // price and the bot just asked "which treatment's price?".
    // This is a narrow legacy price-correction as well as a new AI-pricing
    // decision; it never turns on general AI-Led Pricing in Shadow mode.
    const scopedReviewCandidate = flagged && reviewRequired &&
      reviewType === "information";
    let scopedPackagePrice = (!flagged || scopedReviewCandidate) &&
      !keywordReason && !urgentSafety && !isActiveSafetyConcern(text) &&
      !isExplicitStaffRequest(text) && !marketingStopQuestion
      ? resolveScopedPackagePriceContinuation({
          customerText: text, conversationHistory: history, metaAdContext,
          services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
          promotions: clinicConfig.promotions,
        }) : null;
    if (scopedPackagePrice && scopedReviewCandidate) {
      // A verified amount request is answerable without staffing a generic
      // INFORMATION review. Clinical/safety reviews never enter this branch.
      // The DB may have newer unresolved clinical evidence than the current
      // Gemini result; any unavailable evidence must fail closed.
      const reviewEvidence = await contactsRepo.getTcmReviewEvidence(
        contact.id, savedInbound.id
      );
      if (reviewEvidence?.pendingClinicalReview === false) {
        flagged = false;
        reviewRequired = false;
        reviewType = null;
        bookingReady = false;
        priceQuery = true;
        packageQuery = false;
        details = { ...details, treatment: scopedPackagePrice.treatment };
        // The price-only formatter replaces this safe placeholder with
        // currently configured and independently verified package amounts.
        aiReply = "我帮你核对这两项配套的价格 😊";
        console.info("[Pricing] Resolved verified scoped-package information review " +
          "contact=" + contact.id + " inbound=" + savedInbound.id);
      } else {
        scopedPackagePrice = null;
      }
    }

    // Customer-selected treatment remains authoritative. In enabled mode,
    // an unambiguous current-lead Meta ad can anchor an early short pricing
    // enquiry, but cannot override a later customer treatment switch.
    // The model already returns priceQuery/packageQuery and treatment. Resolve
    // one verified decision for reply text and optional promotional media.
    const numberedPrices = numberedPricingSelection
      ? verifiedPricesForService(
          numberedPricingSelection.treatment, clinicConfig.promotions,
          text, history, { clarifiedPriceService: numberedPricingSelection.treatment }
        ) : null;
    const numberedPricingDecision = numberedPrices?.length
      ? {
          type: "price", treatment: numberedPricingSelection.treatment,
          source: "numbered_price_menu",
          clarifiedPriceService: numberedPricingSelection.treatment,
          prices: numberedPrices, servicePrice: null,
        } : null;
    const pricingDecision = ["shadow", "enabled"].includes(aiPricingMode) && !flagged
      ? (numberedPricingSelection ? numberedPricingDecision : scopedPackagePrice || resolveAiPricingDecision({
          priceQuery, packageQuery, treatment: details?.treatment || null,
          customerText: text, conversationHistory: history,
          services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
          promotions: clinicConfig.promotions,
          allowOfferEnquiries: clinicConfig.aiPricingOfferEnquiriesEnabled === true,
          complimentaryAssessmentExperienceEnabled:
            clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
          metaAdContext,
        }))
      : null;
    if (aiPricingMode === "shadow") {
      console.info("[AI pricing shadow] contact=" + contact.id +
        " priceQuery=" + priceQuery + " packageQuery=" + packageQuery +
        " verified=" + Boolean(pricingDecision) +
        " amountVerified=" + Boolean(pricingDecision?.prices?.length));
    }
    // One approved result is shared by the outbound guard, verified text and
    // optional promo-media selector. Shadow observations never authorize sales;
    // only narrowly verified Shadow exceptions or explicit menu continuations do.
    const pricingApproval = resolveApprovedPricingAssessment({
      mode: aiPricingMode, aiDecision: pricingDecision,
      shadowException: shadowPriceException,
      scopedPackageDecision: scopedPackagePrice,
      numberedMenuDecision: numberedPricingDecision,
      customerText: text, conversationHistory: history,
      services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
      resultMedia: clinicConfig.resultMedia,
      flagged, bookingReady, keywordReason, marketingStopQuestion,
      allowOfferEnquiries: clinicConfig.aiPricingOfferEnquiriesEnabled === true,
    });
    const approvedPricingDecision = pricingApproval.decision;
    if (priceQuery || packageQuery || pricingDecision || approvedPricingDecision ||
        twoTreatmentQuote || shadowPriceException || numberedPricingSelection || scopedPackagePrice) {
      console.info("[Pricing authority] contact=" + contact.id +
        " inbound=" + savedInbound.id +
        " mode=" + aiPricingMode +
        " observed=" + Boolean(pricingDecision) +
        " authorized=" + Boolean(approvedPricingDecision || twoTreatmentQuote) +
        " reason=" + (twoTreatmentQuote ? "two_treatments_verified" : pricingApproval.reason) +
        " source=" + (twoTreatmentQuote?.source || approvedPricingDecision?.source || "none") +
        " treatment=" + (twoTreatmentQuote
          ? twoTreatmentQuote.prices.map(item => item.treatment).join(" / ")
          : approvedPricingDecision?.treatment || "none"));
    }
    // Enabled and independently verified Shadow exceptions MUST use the
    // approved decision exclusively. A rejected candidate cannot re-enter the
    // formatter/graphic selector through the former model/legacy fallbacks.
    // Ordinary Shadow and Off enquiries retain their original legacy route.
    const exceptionalPricingCandidate = Boolean(
      shadowPriceException || numberedPricingSelection || scopedPackagePrice
    );
    const pricingAuthorityRequired = aiPricingEnabled || (
      aiPricingMode === "shadow" && exceptionalPricingCandidate
    );
    const authorizedPricingInput = pricingAuthorityRequired
      ? approvedPricingDecision : undefined;
    const verifiedPriceService = pricingAuthorityRequired
      ? (clinicConfig.services || []).find(
          service => service.name === approvedPricingDecision?.treatment
        ) || null
      : aiPricingMode === "off" && (scopedPackagePrice || numberedPricingSelection)
        ? (clinicConfig.services || []).find(s =>
            s.name === (scopedPackagePrice?.treatment || numberedPricingSelection?.treatment)
          ) || null
      : clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
        ? safeServiceFromCustomer(text, clinicConfig.services, clinicConfig.serviceAliases) ||
          resolveVerifiedPriceFollowUpService({
            customerText: text, conversationHistory: history,
            services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
            promotions: clinicConfig.promotions,
            allowContinuedPriceContext: false,
          })
        : null;
    const clarifiedPriceService = pricingAuthorityRequired
      ? approvedPricingDecision?.clarifiedPriceService || null
      : scopedPackagePrice?.clarifiedPriceService ||
        numberedPricingSelection?.treatment ||
        (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
          ? resolveClarifiedPriceService({
              customerText: text, conversationHistory: history,
              services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
            }) : null);

    let reply = isFirstMessage && !flagged && !generateFirstIntro && !fixedAdFirstReply
      ? `${clinicConfig.introMessage}\n\n${aiReply}`
      : aiReply;
    if (isFirstMessage && !flagged && generateFirstIntro && !fixedAdFirstReply) {
      const guardedIntro = preserveOriginalIntroFacts(clinicConfig.introMessage, aiReply);
      reply = guardedIntro.reply;
      if (guardedIntro.usedOriginalFallback) {
        console.warn(
          `Localized first intro omitted ${guardedIntro.missingCount} protected details; ` +
          "appended configured source intro to avoid silently losing clinic information."
        );
      }
    }

    // Last assembled-text boundary before Meta/Neon outbound reservation.
    // An unrelated treatment refusal or ambiguous future marketing consent
    // must NEVER allow unsolicited first-contact prices to slip through.
    // Actual current price enquiries still bypass the guard. Preserve all AI
    // intent fields, clinical escalation and Before & After media eligibility.
    if (!flagged) {
      const guardedOfferIntro = guardFutureOfferIntroductionReply({
        channel,
        isFirstMessage: clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true ? false : isFirstMessage,
        customerText: text,
        reply,
        flagged,
        language: mediaLanguage,
        services: clinicConfig.services,
        serviceAliases: clinicConfig.serviceAliases,
      });
      const finalOfferGuard = clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
        ? guardAssessmentFirstPricingReply({
            channel, customerText: text, reply, flagged, language: mediaLanguage,
            services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
            // Do not let Gemini's treatment guess create pricing permission.
            // Short price follow-ups use only the verified customer-named
            // treatment, with bounded history and topic-change safeguards.
            treatment: verifiedPriceService?.name || null,
            clarifiedPriceService,
            verifiedPricingIntent: Boolean(approvedPricingDecision),
            requireVerifiedTreatment: true,
            resultMedia: clinicConfig.resultMedia, conversationHistory: history,
            promotions: clinicConfig.promotions,
            allowContinuedPriceContext: aiPricingEnabled,
          })
        : guardedOfferIntro;
      if (finalOfferGuard.replaced) {
        console.warn("[Reply guard] Replaced unsolicited treatment price before sending.");
        reply = finalOfferGuard.reply;
      }
    }

    // A real price question must receive an amount even when the model tries
    // to move straight to the assessment. Use only this verified treatment's
    // active configured packages, never a guessed amount or stacked voucher.
    if (!flagged && !marketingStopQuestion &&
        (aiPricingEnabled ||
         clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true)) {
      const priced = ensureVerifiedPriceReply({
        customerText: text, reply, treatment: verifiedPriceService?.name || null,
        clarifiedPriceService,
        priceOnlyResponse: pricingAuthorityRequired
          ? Boolean(approvedPricingDecision && exceptionalPricingCandidate)
          : false,
        verifiedNumberedSelection: pricingAuthorityRequired
          ? (approvedPricingDecision?.source === "numbered_price_menu"
              ? approvedPricingDecision.treatment : null)
          : numberedPricingSelection?.treatment || null,
        verifiedShadowPriceService: pricingAuthorityRequired
          ? (approvedPricingDecision && shadowPriceException
              ? approvedPricingDecision.treatment : null)
          : null,
        pricingDecision: authorizedPricingInput,
        // Only customer-authored pricing evidence (not model flags) can
        // trigger a fallback clarification on the outbound text path.
        priceRequested: pricingAuthorityRequired &&
          hasCustomerRequestedPriceReply({
            customerText: text, pricingDecision: approvedPricingDecision,
          }),
        services: clinicConfig.services,
        serviceAliases: clinicConfig.serviceAliases, promotions: clinicConfig.promotions,
        resultMedia: clinicConfig.resultMedia, conversationHistory: history,
        language: mediaLanguage,
        allowContinuedPriceContext: aiPricingEnabled || Boolean(approvedPricingDecision),
      });
      if (priced.restored) {
        console.info("[Pricing] Restored confirmed active package amounts for a verified price enquiry.");
      }
      reply = priced.reply;
      // The verified price formatter intentionally replaces model-authored
      // text. Recover independently configured branch/hours details when the
      // same customer turn also asks for them (e.g. location + RM488).
      // Never append administrative facts to rejected/unverified pricing.
      const approvedPriceQuoted = Boolean(approvedPricingDecision && priced.restored &&
        (approvedPricingDecision.prices?.some(item =>
          item.price && reply.includes(item.price)) ||
          (approvedPricingDecision.servicePrice &&
            reply.includes(approvedPricingDecision.servicePrice))));
      if (approvedPriceQuoted) {
        reply = appendRequestedBusinessFacts({
          customerText: text, reply, language: mediaLanguage,
          branches: clinicConfig.branches, hours: clinicConfig.hours,
        });
      }
    }

    // "How much?" after discussion of the complimentary intro AND separate
    // body treatment is ambiguous. When no treatment price is independently
    // verified, clarify the two fees rather than claiming all care is free.
    if (!flagged && !marketingStopQuestion && !shadowPriceException &&
        clinicConfig.businessType === "tcm_clinic" &&
        clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true &&
        !approvedPricingDecision?.prices?.length &&
        !pricingDecision?.prices?.length && !verifiedPriceService) {
      const feeClarification = ambiguousAssessmentOrTreatmentFeeReply(
        text, history, mediaLanguage
      );
      if (feeClarification) reply = feeClarification;
    }

    if (twoTreatmentQuote) {
      // A verified multi-treatment request is not approval for promotional
      // graphics. Existing WhatsApp send/billing controls still apply.
      reply = twoTreatmentQuote.reply;
      console.info("[Pricing] Verified two separate text-only prices contact=" +
        contact.id + " inbound=" + savedInbound.id);
    }

    // Images are optional and sent only AFTER Meta accepts this text.
    // A later delivery failure must never turn an AI promise into a lie.
    // Even when a verified price is quoted, do not claim graphics are sent
    // before the separate media selector and provider confirm acceptance.
    if (!flagged && !marketingStopQuestion) {
      const mediaPromise = guardUnconfirmedMediaPromise(reply, mediaLanguage);
      if (mediaPromise.changed) {
        console.warn("[Reply guard] Removed unconfirmed outbound media claim.");
        reply = mediaPromise.reply;
      }
    }

    // Preserve the useful original service explanation. If an eligible first
    // treatment enquiry omits an assessment invitation, append just one
    // invitation without replacing the answer or altering result-media intent.
    if (!flagged && !marketingStopQuestion &&
        clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
        !fixedAdFirstReply) {
      // A fixed reply is a staff-authored complete message; do not append a
      // second sales question. Price/safety/billing guards still run normally.
      const invited = ensureFirstAssessmentInvitation({
        isFirstMessage, customerText: text, reply, flagged, language: mediaLanguage,
        serviceQuery, treatment: details?.treatment,
        verifiedAdService: serviceQuerySource === "meta_ad" ? metaAdCreativeService : null,
        services: clinicConfig.services, serviceAliases: clinicConfig.serviceAliases,
      });
      reply = invited.reply;
    }

    // Never send a draft that offers a price list but omits all amounts.
    // Only a separately approved pricing decision may supply a monetary quote.
    if (!flagged && !marketingStopQuestion) {
      const completeQuote = guardUnfulfilledPriceQuote(reply, mediaLanguage);
      if (completeQuote.changed) {
        console.warn("[Reply guard] Replaced unfulfilled price-list promise.");
        reply = completeQuote.reply;
      }
    }

    // A marketing STOP must not become a price/promotion reply even if the
    // model adds unsolicited commercial copy. Preserve useful service answers.
    if (marketingStopQuestion && hasCommercialReplyContent(reply) && !flagged) {
      reply = safeIntroReply({
        customerText: marketingStopQuestion,
        language: mediaLanguage,
        services: clinicConfig.services,
        serviceAliases: clinicConfig.serviceAliases,
      });
    }

    // Coexistence staff can reply from the phone while generation is in flight.
    // Give the echo webhook a brief chance to arrive, then abort this AI turn
    // if that staff action changed the cancellation epoch.
    if (
      aiCancellationKey &&
      !(await aiReplyCancellation.settleBeforeSend(
        aiCancellationKey,
        aiCancellationToken
      ))
    ) {
      console.log(
        `Skipping AI reply for ${channel}:${from} — staff replied before the AI send.`
      );
      return { wasFirstMessage, keywordReason };
    }

    // AI generation can take long enough for staff to take over after the
    // earlier ownership check. Re-check immediately before any AI-owned state
    // change or outbound send.
    const aiReplyContact = await getAiOwnedContact(contact, {
      channel,
      from,
      reason: "AI reply",
      inboundMessageId: savedInbound.id,
    });
    if (!aiReplyContact) return { wasFirstMessage, keywordReason };
    contact = aiReplyContact;

    if (flagged && reviewRequired) {
      // This issue belongs to staff, not a scripted customer apology. Keep AI
      // ownership so the next unrelated enquiry is answered as normal.
      await contactsRepo.setAiReviewAttention(
        contact.id, savedInbound.id,
        String(text || "Unanswered customer question").slice(0, 350),
        categorizeAiReview(text, reviewType)
      );
      if (clinicalAcknowledgement) {
        // A narrow, non-diagnostic acknowledgement can be sent without
        // resolving the clinical review. Re-check staff ownership after the
        // review write, then use the same guarded provider send as normal.
        const reviewOwner = await getAiOwnedContact(contact, {
          channel, from,
          reason: "TCM clinical review acknowledgment",
          inboundMessageId: savedInbound.id,
        });
        if (!reviewOwner || (canSendAutomatedReply && !canSendAutomatedReply())) {
          return { wasFirstMessage, keywordReason };
        }
        responseAttempted = true;
        await sendTrackedText(
          reviewOwner, clinicalAcknowledgement, "ai_reply",
          { canSend: canSendAutomatedReply, processingJobId }
        );
      }
      return { wasFirstMessage, keywordReason };
    } else if (flagged) {
      // Genuine takeover/safety events keep the existing strict staff pause.
      // PR #304 can safely clear this exact legacy handoff reason only after
      // an accepted staff reply and explicit Return to AI. Keep medical/safety
      // cases distinct so the normal handoff recovery never clears them.
      const handoffReason = urgentSafety || isActiveSafetyConcern(text)
        ? (keywordReason || "Medical safety concern requires staff attention.")
        : "AI handed off this conversation.";
      const pausedContact = await pauseAiForHumanHandoff(
        contact.id,
        handoffReason
      );
      if (!pausedContact) return { wasFirstMessage, keywordReason };

      const pendingHandoff = await getPendingAiHandoffContact(pausedContact.id);
      if (!pendingHandoff) return { wasFirstMessage, keywordReason };
      contact = pendingHandoff;
    }

    // Explicit staff requests, complaints and safety incidents use a true
    // handoff acknowledgement. Unanswered one-off questions return above.
    const finalSendContact = flagged && !reviewRequired
      ? await getPendingAiHandoffContact(contact.id)
      : await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "AI provider send",
          inboundMessageId: savedInbound.id,
        });
    if (!finalSendContact) return { wasFirstMessage, keywordReason };
    contact = finalSendContact;

    // Optional automatic pictures need a fresh clinical-review and ownership
    // check at the provider's final pre-send boundary. A new clinical review,
    // human takeover, staff reply or cancellation must stop delayed media.
    const allowOptionalMediaSend = async () => {
      if (canSendAutomatedReply && canSendAutomatedReply() !== true) return false;
      const liveOwner = await getAiOwnedContact(contact, {
        channel,
        from,
        reason: "optional automated picture",
        inboundMessageId: savedInbound.id,
      });
      return liveOwner
        ? contactsRepo.canSendAutomaticReviewMedia(liveOwner.id)
        : false;
    };

    // Run this after the final ownership read, as close as possible to the
    // tracked provider send. A native/inbox staff action marks its cancellation state
    // synchronously before any DB work, so a slow echo transaction also blocks
    // the AI instead of allowing a competing reply.
    if (
      aiCancellationKey &&
      !aiReplyCancellation.safeToSend(aiCancellationKey, aiCancellationToken)
    ) {
      console.log(
        `Skipping AI reply for ${channel}:${from} — staff activity is pending or confirmed.`
      );
      return { wasFirstMessage, keywordReason };
    }

    responseAttempted = true;
    const sendOutcome = await sendTrackedText(
      contact,
      reply,
      "ai_reply",
      { canSend: canSendAutomatedReply, processingJobId }
    );
    if (sendOutcome.sendResult.cancelled) {
      console.log(
        `Skipping AI reply for ${channel}:${from} — staff activity reached the final send boundary.`
      );
      return { wasFirstMessage, keywordReason };
    }

    // If this turn recovered from a temporary provider outage, clear only
    // that exact attention flag after the customer-facing AI reply was
    // accepted. Keep every newer or higher-priority attention reason intact.
    if (!flagged && sendOutcome.sendResult.success) {
      try {
        const recoveredContact = await contactsRepo.clearTemporaryAiAttention(
          contact.id
        );
        if (recoveredContact) contact = recoveredContact;
      } catch (attentionErr) {
        console.error(
          `Failed to clear temporary AI attention for contact ${contact.id}:`,
          attentionErr
        );
      }
    }

    // Apply conversion-ready state only after this AI turn was not suppressed
    // by a staff phone reply. Provider rejection still keeps the existing
    // behavior of surfacing Booking Ready for staff follow-up.
    if (bookingReady) {
      try {
        await markBookingReadyForContact(contact.id, savedInbound.id, {
          details,
          // A genuinely new request to move an existing booking must still
          // reach staff even when the CRM records the old slot as confirmed.
          allowReschedule: /(?:改期|改时间|改時間|换去|换到|換去|換到|重新预约|重新預約|调整时间|調整時間|reschedul|change\s+(?:my\s+)?(?:appointment|date|time|slot)|move\s+(?:my\s+)?appointment|ubah\s+(?:temujanji|masa)|tukar\s+(?:temujanji|masa))/iu.test(String(text || "")),
        });
      } catch (bookingOutcomeErr) {
        console.error(
          `Failed to apply booking-ready outcome for contact ${contact.id}:`,
          bookingOutcomeErr
        );
      }
    }

    // Honor the just-recorded marketing opt-out on this turn. The separate
    // service question is answerable, but no optional promotional or results
    // media should be sent together with an explicit refusal of marketing.
    if (marketingStopQuestion) {
      try {
        await resultMediaDecisionRepo.recordDecision({
          contactId: contact.id,
          inboundMessageId: savedInbound.id,
          status: "skipped",
          reason: "marketing_opt_out_turn",
        });
      } catch (auditError) {
        console.warn("[Result media] marketing opt-out audit failed:", auditError);
      }
      return { wasFirstMessage, keywordReason };
    }

    // secondary WhatsApp shares approved clinic CONTENT, but its optional images must
    // use only its separate durable media queue and billing/Graph transport.
    // An inactive media flag must never reach the primary image-sending path.

    // Promotional media is reactive, not a first-message blast. Only follow a
    // successful normal AI reply when the customer explicitly asked about the
    // price or available packages for one known configured service. Existing
    // safety/ownership gates remain unchanged.
    let automaticPromoMediaSent = 0;
    let queuedPromotionCount = 0;
    let promotionImagesTruncated = false;
    // Promo sends can stop the post-reply sequence before the optional result
    // block is reached. Keep those exit reasons in the same staff-only audit.
    const auditResultMediaEarlyExit = async (reason) => {
      try {
        await resultMediaDecisionRepo.recordDecision({
          contactId: contact.id,
          inboundMessageId: savedInbound.id,
          status: "skipped",
          reason,
          promotionCount: Math.max(0, automaticPromoMediaSent - queuedPromotionCount),
        });
      } catch (auditError) {
        console.warn(`[Result media] early audit failed for contact ${contact.id}:`, auditError);
      }
      console.info(`[Result media] contact=${contact.id} inbound=${savedInbound.id} decision=skipped reason=${reason}`);
    };
    {
      // A directly named service or a one-turn standalone price follow-up
      // remains customer-verified; never trust a stale CRM/ad label.
      let pricingMediaSkipReason = twoTreatmentQuote
        ? "two_treatments_text_only" : "not_evaluated";
      const promoBundle = twoTreatmentQuote ? null : await resolvePricePromotionForReply({
        priceQuery,
        packageQuery,
        pricingDecision: pricingAuthorityRequired ? approvedPricingDecision : null,
        aiPricingEnabled: pricingAuthorityRequired,
        metaAdContext,
        treatment: verifiedPriceService?.name ||
          (pricingAuthorityRequired ? null : details?.treatment),
        verifiedServiceFromText: verifiedPriceService?.name || null,
        verifiedNumberedSelection: pricingAuthorityRequired
          ? (approvedPricingDecision?.source === "numbered_price_menu"
              ? approvedPricingDecision.treatment : null)
          : numberedPricingSelection?.treatment || null,
        verifiedShadowPriceService: pricingAuthorityRequired
          ? (approvedPricingDecision && shadowPriceException
              ? approvedPricingDecision.treatment : null)
          : shadowPriceException?.treatment || null,
        customerText: text,
        conversationHistory: history,
        flagged,
        bookingReady,
        keywordReason,
        needsAttention: !(await contactsRepo.canSendAutomaticReviewMedia(contact.id)),
        textSendSucceeded: sendOutcome.sendResult.success,
        onSkip: (reason) => { pricingMediaSkipReason = reason; },
        promotions: clinicConfig.promotions,
        services: clinicConfig.services,
        serviceAliases: clinicConfig.serviceAliases,
        resultMedia: clinicConfig.resultMedia,
        language: mediaLanguage,
        contactId: contact.id,
        // The verified pricing paths must not resend manually delivered images
        // when staff used an older caption than the current promotion copy.
        // Unverified legacy behaviour retains its existing matching rules.
        wasPromoRecentlySent: selectPromoDuplicateCheck({
          aiPricingEnabled: pricingAuthorityRequired,
          numberedPricingSelection: pricingAuthorityRequired
            ? (approvedPricingDecision?.source === "numbered_price_menu"
                ? numberedPricingSelection : null)
            : numberedPricingSelection,
          shadowPriceException: pricingAuthorityRequired
            ? (approvedPricingDecision ? shadowPriceException : null)
            : shadowPriceException,
          scopedPackagePrice: pricingAuthorityRequired
            ? (approvedPricingDecision ? scopedPackagePrice : null)
            : scopedPackagePrice,
          messagesRepo,
        }),
        hasUnconfirmedMediaDelivery: messagesRepo.hasUnconfirmedMediaDelivery,
      });
      // Store a stage summary only for pricing-related inbound turns.
      // This optional write occurs after the text-send outcome is known and
      // cannot affect accepted text, media sending or retry semantics.
      if (priceQuery || packageQuery || pricingDecision || approvedPricingDecision ||
          twoTreatmentQuote || shadowPriceException || scopedPackagePrice || numberedPricingSelection) {
        const quotedApprovedPrices = approvedPricingDecision?.prices?.length
          ? approvedPricingDecision.prices.every(item => reply.includes(item.price))
          : false;
        // Fire-and-catch the optional audit: Neon latency must never hold
        // up a WhatsApp/media send or delay an otherwise valid reply.
        void pricingDecisionAuditRepo.recordDecision({
            contactId: contact.id,
            inboundMessageId: savedInbound.id,
            mode: aiPricingMode,
            observed: Boolean(pricingDecision),
            approved: Boolean(approvedPricingDecision || twoTreatmentQuote),
            approvalReason: twoTreatmentQuote ? "two_treatments_verified_text_only"
              : pricingApproval.reason,
            treatment: twoTreatmentQuote
              ? twoTreatmentQuote.prices.map(item => item.treatment).join(" / ")
              : approvedPricingDecision?.treatment || null,
            decisionSource: twoTreatmentQuote?.source || approvedPricingDecision?.source || null,
            replyStatus: !sendOutcome.sendResult.success ? "text_not_accepted"
              : twoTreatmentQuote ? "verified_two_treatment_prices_quoted"
              : approvedPricingDecision ? (quotedApprovedPrices ? "approved_price_quoted"
                : approvedPricingDecision.servicePrice && reply.includes(approvedPricingDecision.servicePrice)
                  ? "approved_service_price_quoted" : "approved_quote_not_found")
                : "legacy_or_no_approved_price",
            mediaStatus: promoBundle ? "selected" : "skipped",
            mediaReason: promoBundle ? null : pricingMediaSkipReason,
            mediaPackagesSelected: Math.min(3, promoBundle?.packages?.length || 0),
          }).catch(auditError => {
            console.warn("[Pricing audit] Optional stage recording failed:", auditError);
          });
      }
      if (promoBundle) {
        const pacedPromotions = planPromotionMediaPacing(promoBundle.packages);
        promotionImagesTruncated = !!pacedPromotions.reason;
        const queuedPromotions = channel === "whatsapp" &&
          (secondaryAiConversation || whatsappZeroCostGuard.enabled()) &&
          pacedPromotions.items.length > 0 && sendOutcome.sendResult.success;
        if (queuedPromotions) {
          try {
            const queue = secondaryAiConversation ? secondaryAiMediaQueue : whatsappResultMediaQueue;
            const enqueued = await queue.enqueue({
              contactId:contact.id,
              inboundMessageId:savedInbound.id,
              items:pacedPromotions.items,
              kind:"promotion",
              sequenceOffset:0,
            });
            if (secondaryAiConversation && !enqueued) {
              await auditResultMediaEarlyExit("secondary_media_not_enabled");
              return { wasFirstMessage, keywordReason };
            }
          } catch (queueError) {
            // Optional media failures must not invalidate the already accepted
            // AI text or cause a durable inbound job to replay that reply.
            console.error("[Result queue] Could not schedule price graphics:",queueError);
            await contactsRepo.setDeliveryAttention(contact.id,
              "Automatic price image could not be queued. Please review this chat."
            ).catch(()=>{});
            await auditResultMediaEarlyExit("promotion_media_enqueue_failed");
            return { wasFirstMessage, keywordReason };
          }
          queuedPromotionCount = pacedPromotions.items.length;
          // The pacing limit counts planned graphics, not only images already
          // delivered. The audit separately counts actual Meta acceptance.
          automaticPromoMediaSent += queuedPromotionCount;
        }
        for (const promoPackage of (queuedPromotions || secondaryAiConversation ? [] : pacedPromotions.items)) {
          const promoContact = await getAiOwnedContact(contact, {
            channel,
            from,
            reason: `automatic promo package ${promoPackage.name || "image"}`,
            inboundMessageId: savedInbound.id,
          });
          // Re-check ownership and attention before every package so a staff
          // takeover between Package A and B stops the remaining automation.
          if (!promoContact || !(await contactsRepo.canSendAutomaticReviewMedia(promoContact.id))) {
            await auditResultMediaEarlyExit("staff_review_or_takeover");
            return { wasFirstMessage, keywordReason };
          }
          contact = promoContact;

          if (canSendAutomatedReply && canSendAutomatedReply() !== true) {
            await auditResultMediaEarlyExit("reply_window_or_staff_cancellation");
            return { wasFirstMessage, keywordReason };
          }

          const guardedPromo = typeof canSendAutomatedReply === "function";
          const savedPromo = await conversationStore.appendMessageForContact(
            contact.id,
            "assistant",
            promoPackage.caption || "",
            null,
            null,
            promoPackage.imageUrl,
            null,
            guardedPromo ? { publish: false } : undefined
          );
          const promoProviderRecorder = messagesRepo.socialProviderAliasRecorder(
            savedPromo.id,
            contact.channel
          );
          const promoResult = await channelMessaging.sendImageByUrl(
            contact,
            promoPackage.imageUrl,
            promoPackage.caption,
            {
              preSendCheck: allowOptionalMediaSend,
              ...(promoProviderRecorder
                ? { onProviderMessageId: promoProviderRecorder }
                : {}),
            }
          );

          if (promoResult.cancelled) {
            await messagesRepo.deleteUnsentAssistantMessage(savedPromo.id);
            await auditResultMediaEarlyExit("reply_window_or_staff_cancellation");
            return { wasFirstMessage, keywordReason };
          }

          if (guardedPromo) {
            realtimeEvents.publish("conversation_changed", {
              contactId: savedPromo.contact_id,
              messageId: savedPromo.id,
              reason: "message",
            });
          }

          const promoError = deliveryErrorForSend(
            promoResult,
            promoResult.error || channelMessaging.rejectedError(contact.channel)
          );
          await persistSendOutcome(
            savedPromo,
            promoResult,
            promoError,
            contact.channel || "whatsapp"
          );
          if (!promoResult.success) {
            console.warn(
              `Promo package ${promoPackage.name || "image"} failed to send to ${channel}:${from}; stopping the remaining package sequence.`
            );
            await contactsRepo.setDeliveryAttention(
              contact.id,
              `Delivery failed: ${publicDeliveryError(promoError)}`,
              savedPromo.id
            );
            await auditResultMediaEarlyExit("promotion_delivery_failed");
            return { wasFirstMessage, keywordReason };
          }
          automaticPromoMediaSent += 1;
        }
      }
    }

    // Result examples are optional social proof. Independently evaluate them
    // even after two promotion images; a separate pacing policy limits volume.
    // Keep errors isolated from the core AI reply path and never expose the
    // internal skip reason in customer-facing messages.
    {
      let pendingResultMessage = null;
      let pendingResultSend = null;
      let pendingResultError = null;
      let auditReason = "not_evaluated";
      let auditSelected = 0;
      let auditSent = 0;
      // The single finally block records every outcome, including early returns
      // after a staff takeover, provider failure or a partially sent sequence.
      try {
        // A Meta ad may be enriched while the AI composes/sends its text reply.
        // Refresh the local Neon attribution only AFTER the text was accepted,
        // so this optional evidence read never delays the customer's answer.
        // If the second read fails or creative remains ambiguous, fail closed
        // rather than relying on an earlier stale/ad-name-only service hint.
        let resultMediaCreativeService = metaAdCreativeService;
        let verifiedPriorCustomerTexts = null;
        if (sendOutcome.sendResult.success && isContextualAdServiceEnquiry(text)) {
          try {
            // Query earliest persisted conversation messages, NOT the AI
            // snapshot. A fifth prior message is an ineligible sentinel,
            // including automated and staff replies.
            verifiedPriorCustomerTexts = await messagesRepo.getPriorCustomerTextsForAdEnquiry(
              contact.id,
              savedInbound.id
            );
          } catch (historyErr) {
            console.warn(
              `[Result media] inbound-history verification failed for contact ${contact.id}; skipping contextual ad media:`,
              historyErr
            );
          }

          if (isEarlyContextualAdEnquiry({
            customerText: text,
            priorCustomerTexts: verifiedPriorCustomerTexts,
          })) {
            try {
              const refreshedMetaAdContext = await loadMetaAdReplyContext(contact.id, {
                services: clinicConfig.services,
                aliases: clinicConfig.serviceAliases,
                promotions: clinicConfig.promotions,
              });
              resultMediaCreativeService = resolveMetaAdCreativeService(
                refreshedMetaAdContext,
                clinicConfig.services,
                clinicConfig.serviceAliases
              );
            } catch (refreshErr) {
              resultMediaCreativeService = null;
              console.warn(
                `[Result media] local Meta attribution refresh failed for contact ${contact.id}; skipping unverified ad media:`,
                refreshErr
              );
            }
          } else {
            resultMediaCreativeService = null;
          }
        }

        // This lookup is called ONLY after the original Before & After trigger
        // has skipped for missing enquiry evidence, not for guarded failures.
        const loadPriorResultContext = async () => {
          try {
            return await messagesRepo.getRecentResultProofContext(
              contact.id, savedInbound.id
            );
          } catch (contextError) {
            console.warn(
              `[Result media] Recent customer-treatment context unavailable for contact ${contact.id}; original skip preserved:`,
              contextError
            );
            return null;
          }
        };

        const resultBundle = await resolveResultMediaForReply({
          serviceQuery,
          serviceQuerySource,
          metaAdCreativeService: resultMediaCreativeService,
          customerText: text,
          priorCustomerTexts: verifiedPriorCustomerTexts,
          loadPriorResultContext,
          onSkip: (reason) => { auditReason = reason; },
          priceQuery,
          packageQuery,
          treatment: details?.treatment,
          flagged,
          bookingReady,
          keywordReason,
          needsAttention: !(await contactsRepo.canSendAutomaticReviewMedia(contact.id)),
          textSendSucceeded: sendOutcome.sendResult.success,
          resultMedia: clinicConfig.resultMedia,
          serviceAliases: clinicConfig.serviceAliases,
          services: clinicConfig.services,
          language: mediaLanguage,
          contactId: contact.id,
          wasMediaRecentlySent: messagesRepo.wasMediaRecentlySent,
          hasUnconfirmedMediaDelivery: messagesRepo.hasUnconfirmedMediaDelivery,
          getMostRecentlySentMediaUrl: messagesRepo.getMostRecentlySentMediaUrl,
        });

        if (resultBundle) {
          const paced = planResultMediaPacing({
            customerText: text,
            promotionCount: automaticPromoMediaSent,
            items: resultBundle.items,
            allowRelatedPriceProof: resultBundle.allowRelatedPriceProof === true,
            completedPriceClarification: Boolean(clarifiedPriceService),
          });
          auditSelected = paced.items.length;
          auditReason = paced.reason;
          if (paced.items.length) {
            console.info(
              `Automatic result media eligible for ${resultBundle.service} via ${resultBundle.serviceQuerySource || resultBundle.triggerMode}; ${paced.items.length} result images after ${automaticPromoMediaSent} promo images.`
            );
          }
          // Under Strict RM0, provider billing arrives asynchronously. Queue the
          // optional images after the text reply instead of racing the account
          // gate and generating a false delivery failure/Telegram alert.
          // The durable worker rechecks AI ownership, safety, billing and
          // duplicate protection before every actual provider send.
          let queuedForBilling = false;
          if (channel === "whatsapp" &&
              (secondaryAiConversation || whatsappZeroCostGuard.enabled()) &&
              paced.items.length && sendOutcome.sendResult.success) {
            queuedForBilling = await (secondaryAiConversation
              ? secondaryAiMediaQueue : whatsappResultMediaQueue).enqueue({
              contactId: contact.id,
              inboundMessageId: savedInbound.id,
              items: paced.items,
              kind: "result",
              sequenceOffset: queuedPromotionCount,
            });
            if (queuedForBilling) auditReason = "awaiting_sender_billing_receipt";
            if (secondaryAiConversation && !queuedForBilling) {
              auditReason = "secondary_media_not_enabled";
              return { wasFirstMessage, keywordReason };
            }
          }
          let resultImageIndex = 0;
          for (const resultItem of (queuedForBilling || secondaryAiConversation ? [] : paced.items)) {
            // Allow the customer to absorb a promotion before its optional
            // result example. We recheck ownership, safety and reply-window
            // conditions AFTER the gap, immediately before each provider send.
            if (automaticPromoMediaSent > 0 || resultImageIndex > 0) {
              await pauseBeforeResultMedia(RESULT_MEDIA_SEND_SPACING_MS);
            }
            resultImageIndex += 1;
            const resultContact = await getAiOwnedContact(contact, {
              channel,
              from,
              reason: `automatic result media for ${resultBundle.service || "service"}`,
              inboundMessageId: savedInbound.id,
            });
            if (!resultContact || !(await contactsRepo.canSendAutomaticReviewMedia(resultContact.id))) {
              auditReason = "staff_review_or_takeover";
              return { wasFirstMessage, keywordReason };
            }
            contact = resultContact;

            if (canSendAutomatedReply && canSendAutomatedReply() !== true) {
              auditReason = "reply_window_or_staff_cancellation";
              return { wasFirstMessage, keywordReason };
            }

            const guardedResult = typeof canSendAutomatedReply === "function";
            const savedResult = await conversationStore.appendMessageForContact(
              contact.id,
              "assistant",
              resultItem.caption,
              null,
              null,
              resultItem.imageUrl,
              null,
              guardedResult ? { publish: false } : undefined
            );
            pendingResultMessage = savedResult;
            const resultProviderRecorder = messagesRepo.socialProviderAliasRecorder(
              savedResult.id,
              contact.channel
            );
            const resultSend = await channelMessaging.sendImageByUrl(
              contact,
              resultItem.imageUrl,
              resultItem.caption,
              {
                preSendCheck: allowOptionalMediaSend,
                ...(resultProviderRecorder
                  ? { onProviderMessageId: resultProviderRecorder }
                  : {}),
              }
            );
            pendingResultSend = resultSend;

            if (resultSend.success) auditSent += 1;
            if (resultSend.cancelled) {
              auditReason = "reply_window_or_staff_cancellation";
              await messagesRepo.deleteUnsentAssistantMessage(savedResult.id);
              pendingResultMessage = null;
              pendingResultSend = null;
              return { wasFirstMessage, keywordReason };
            }

            if (guardedResult) {
              realtimeEvents.publish("conversation_changed", {
                contactId: savedResult.contact_id,
                messageId: savedResult.id,
                reason: "message",
              });
            }

            const resultError = deliveryErrorForSend(
              resultSend,
              resultSend.error || channelMessaging.rejectedError(contact.channel)
            );
            pendingResultError = resultError;
            await persistSendOutcome(
              savedResult,
              resultSend,
              resultError,
              contact.channel || "whatsapp"
            );
            pendingResultMessage = null;
            pendingResultSend = null;
            pendingResultError = null;

            if (!resultSend.success) {
              auditReason = "provider_send_failed";
              console.warn(
                `Result media failed to send to ${channel}:${from}; stopping the remaining result sequence.`
              );
              await contactsRepo.setDeliveryAttention(
                contact.id,
                `Delivery failed: ${publicDeliveryError(resultError)}`,
                savedResult.id
              );
              return { wasFirstMessage, keywordReason };
            }
          }
        }
      } catch (resultMediaErr) {
        auditReason = "result_media_exception";
        console.error(
          `Optional result media failed for ${channel}:${from}; keeping AI ownership unchanged:`,
          resultMediaErr
        );

        // If the provider returned an outcome but persisting it threw, retry
        // that idempotent persistence first. This preserves a known provider ID
        // instead of accidentally downgrading an accepted send to "unknown".
        if (pendingResultMessage?.id && pendingResultSend) {
          try {
            await persistSendOutcome(
              pendingResultMessage,
              pendingResultSend,
              pendingResultError ||
                deliveryErrorForSend(
                  pendingResultSend,
                  pendingResultSend.error ||
                    channelMessaging.rejectedError(contact.channel)
                ),
              contact.channel || "whatsapp"
            );

            if (!pendingResultSend.success) {
              await contactsRepo.setDeliveryAttention(
                contact.id,
                `Delivery failed: ${publicDeliveryError(
                  pendingResultError || pendingResultSend.error
                )}`,
                pendingResultMessage.id
              );
            }
            pendingResultMessage = null;
          } catch (recoveryErr) {
            console.error(
              `Failed to recover result media delivery state for message ${pendingResultMessage.id}:`,
              recoveryErr
            );
          }
        }

        // If no provider outcome was available, or persistence is still
        // unavailable, keep the row visible as unconfirmed. This changes only
        // message delivery state and never changes the conversation owner.
        if (pendingResultMessage?.id) {
          try {
            const unknown = await messagesRepo.setDeliveryStatusById(
              pendingResultMessage.id,
              "unknown",
              "Result media delivery could not be confirmed."
            );
            publishDeliveryStatus(unknown);
          } catch (cleanupErr) {
            console.error(
              `Failed to mark interrupted result media ${pendingResultMessage.id} as unconfirmed:`,
              cleanupErr
            );
          }
        }
      } finally {
        const { status: auditStatus, reason: finalAuditReason } =
          resultMediaAuditOutcome({
            reason: auditReason,
            sentCount: auditSent,
            promotionImagesTruncated,
          });
        // Do not let audit availability affect messaging, billing or handoff.
        try {
          await resultMediaDecisionRepo.recordDecision({
            contactId: contact.id,
            inboundMessageId: savedInbound.id,
            status: auditStatus,
            reason: finalAuditReason,
            promotionCount: Math.max(0,automaticPromoMediaSent - queuedPromotionCount),
            selectedCount: auditSelected,
            sentCount: auditSent,
          });
        } catch (auditError) {
          console.warn(`[Result media] audit persistence failed for contact ${contact.id}:`, auditError);
        }
        if (finalAuditReason) {
          console.info(`[Result media] contact=${contact.id} inbound=${savedInbound.id} decision=${auditStatus} reason=${finalAuditReason} promos=${automaticPromoMediaSent} results=${auditSent}/${auditSelected}`);
        }
      }
    }

    return { wasFirstMessage, keywordReason };
  } catch (err) {
    console.error(`Error handling incoming ${channel} message ${id || "without id"}:`, err);

    if (contact && savedInbound) {
      try {
        // Save an internal review, not a customer-facing error message.
        // A later customer message may still be handled by the AI normally.
        if (ai.isRecoverableAiReplyFailure(err)) {
          await contactsRepo.setTemporaryAiAttention(contact.id);
        } else {
          await contactsRepo.setAiReviewAttention(
            contact.id,
            savedInbound.id,
            "Automated message processing failed. Staff should inspect this customer turn.",
            "clinical"
          );
        }
      } catch (attentionErr) {
        console.error("Failed to flag the conversation after processing failure:", attentionErr);
      }
    }
    return { wasFirstMessage, keywordReason };
  }
}

// Runtime secret checks stay in the entry point so a misconfigured production
// deployment still fails before the Express application is constructed.
// Staging also fails before Express is constructed if secrets, access
// controls, QA database isolation or outbound guards are missing.
try {
  require("./services/pr395StagingSafety").assertPr395StagingSafety(process.env);
} catch (error) {
  console.error("[PR395 staging] Unsafe runtime configuration:", error.message);
  process.exit(1);
}

// Existing production runtime secret checks remain after the staging gate.
if (!process.env.WHATSAPP_APP_SECRET && process.env.NODE_ENV === "production") {
  console.error(
    "❌ WHATSAPP_APP_SECRET is not set. Refusing to start, since without it " +
      "the webhook cannot verify incoming requests actually came from Meta. " +
      "Set WHATSAPP_APP_SECRET (see .env.example) and restart."
  );
  process.exit(1);
}

const socialMessagingConfigured =
  metaMessaging.configured("facebook") || metaMessaging.configured("instagram");
if (
  socialMessagingConfigured &&
  !process.env.META_APP_SECRET &&
  process.env.NODE_ENV === "production"
) {
  console.error(
    "❌ META_APP_SECRET is not set. Refusing to start with Facebook/Instagram messaging enabled, " +
      "since the social webhook cannot verify requests from Meta."
  );
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error(
    "❌ SESSION_SECRET is not set. Refusing to start, since a missing/default " +
      "session secret would let anyone forge a valid staff login cookie. Set " +
      "SESSION_SECRET (see .env.example) and restart."
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const app = createApp({
  sessionSecret: SESSION_SECRET,
  durablyClaimIncoming,
  scheduleDurableClaim,
  queueIncomingForReply,
});

startApplication({
  app,
  port: PORT,
  processIncomingBatch,
}).catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
