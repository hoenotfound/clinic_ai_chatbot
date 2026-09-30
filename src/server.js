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
const conversationStore = require("./utils/conversationStore");
const { getActivePromotion } = require("./utils/activePromotion");
const { parseAiReplyResult } = require("./utils/aiReplyResult");
const { fallbackHandoffReply } = require("./utils/handoffReply");
const clinicConfig = require("./config/clinicConfig");
const { getOperationalLabels } = require("./utils/businessTerminology");
const {
  deliveryErrorForSend,
  publicDeliveryError,
} = require("./utils/socialDeliveryError");
const messagesRepo = require("./db/messagesRepo");
const inboundProcessingRepo = require("./db/inboundProcessingRepo");
const outboundMessageEvidenceRepo = require("./db/outboundMessageEvidenceRepo");
const contactsRepo = require("./db/contactsRepo");
const {
  URGENT_SAFETY_REASON,
  checkKeywordTriggers,
  isUrgentSafetyMessage,
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
    updated = await messagesRepo.setWhatsappMessageId(savedMessage.id, sendResult.wamid);
  } else if (sendResult.externalMessageId && channel !== "whatsapp") {
    updated = await messagesRepo.setSocialProviderMessageId(
      savedMessage.id,
      `${channel}:${sendResult.externalMessageId}`,
      null
    );
  } else if (!sendResult.success) {
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, "failed", errorText);
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
    sendResult = await channelMessaging.sendText(
      contact,
      text,
      {
        ...(guarded ? { preSendCheck: canSend } : {}),
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
        outcome: sendResult.success ? "accepted" : "rejected",
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
  // Do not extend the durable inbound critical path after the provider has
  // already accepted/rejected the customer reply. Missing telemetry fails the
  // later go-live check closed; it must never delay or duplicate customer work.
  recordReadinessSendEvidence(saved, contact, sendResult, origin);

  if (!sendResult.success) {
    await contactsRepo.setDeliveryAttention(
      contact.id,
      `Delivery failed: ${errorText}`
    );
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

async function processIncomingBatch(items) {
  const batch = dedupeIncomingBatch(items);
  if (!batch.length) return;

  let firstMessageWasSuppressed = false;
  let inheritedKeywordReason = null;

  for (let index = 0; index < batch.length; index += 1) {
    const isLast = index === batch.length - 1;
    const result = await processIncomingMessage(batch[index], {
      suppressAutoReply: !isLast,
      forceFirstMessage: isLast && firstMessageWasSuppressed,
      inheritedKeywordReason,
    });

    if (result?.wasFirstMessage) firstMessageWasSuppressed = true;
    if (!inheritedKeywordReason && result?.keywordReason) {
      inheritedKeywordReason = result.keywordReason;
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
  const aiCancellationKey =
    channel === "whatsapp" && aiReplyCancellation.enabled()
      ? aiReplyCancellation.keyForWhatsAppNumber(from)
      : (channel === "facebook" || channel === "instagram")
        ? aiReplyCancellation.keyForChannelContact(channel, from)
        : null;
  const aiCancellationToken = aiReplyCancellation.snapshot(aiCancellationKey);
  const canSendAutomatedReply = aiCancellationKey
    ? () => aiReplyCancellation.safeToSend(aiCancellationKey, aiCancellationToken)
    : null;

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

    if (unsupportedType) {
      const label = channelMessaging.labelForChannel(channel);
      await contactsRepo.setAttention(
        contact.id,
        true,
        `Unsupported ${label} message (${unsupportedType}) needs staff review.`
      );

      if (!suppressAutoReply) {
        const autoReplyContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "unsupported-message fallback",
        });
        if (autoReplyContact) {
          contact = autoReplyContact;
          responseAttempted = true;
          await sendTrackedText(
            contact,
            "Sorry, I can only read text, voice, or photo messages for now — could you type that out for me? 🙂",
            "system_fallback",
            { canSend: canSendAutomatedReply, processingJobId }
          );
        }
      }
      return { wasFirstMessage, keywordReason };
    }

    let text = incoming.text || "";
    let mediaAttachment = null;

    if (mediaType === "audio") {
      const media = await channelMessaging.downloadIncomingMedia(incoming);
      const [transcript, mp3] = media
        ? await Promise.all([
            transcribeAudio(media.buffer, media.mimeType),
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
        await contactsRepo.setAttention(
          contact.id,
          true,
          `A ${customerSingular} voice message could not be transcribed.`
        );

        if (!suppressAutoReply) {
          const autoReplyContact = await getAiOwnedContact(contact, {
            channel,
            from,
            reason: "voice-transcription fallback",
          });
          if (autoReplyContact) {
            contact = autoReplyContact;
            responseAttempted = true;
            await sendTrackedText(
              contact,
              "Sorry, I couldn't quite catch that voice message — mind typing it out, or sending the voice note again? 🙂",
              "system_fallback",
              { canSend: canSendAutomatedReply, processingJobId }
            );
          }
        }
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
        await contactsRepo.setAttention(
          contact.id,
          true,
          `A ${customerSingular} photo could not be downloaded.`
        );

        if (!suppressAutoReply) {
          const autoReplyContact = await getAiOwnedContact(contact, {
            channel,
            from,
            reason: "photo-download fallback",
          });
          if (autoReplyContact) {
            contact = autoReplyContact;
            responseAttempted = true;
            await sendTrackedText(
              contact,
              "Sorry, I couldn't load that photo — mind sending it again? 🙂",
              "system_fallback",
              { canSend: canSendAutomatedReply, processingJobId }
            );
          }
        }
        return { wasFirstMessage, keywordReason };
      }

      mediaAttachment = {
        mimeType: media.mimeType,
        buffer: media.buffer,
      };
      text = incoming.text ? `📷 ${incoming.text}` : `📷 [${customerLabel} sent a photo]`;
      await conversationStore.updateInboundMessage(
        contact.id,
        savedInbound.id,
        text,
        mediaAttachment
      );
    }

    // Photos without captions and failed/unsupported media contain no text
    // that can safely support a sales-temperature decision.
    const temperatureReviewEligible = Boolean(text.trim()) && !(
      mediaType === "image" && !incoming.text
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

    const currentKeywordReason = checkKeywordTriggers(text);
    const urgentSafety =
      isUrgentSafetyMessage(text) || inheritedKeywordReason === URGENT_SAFETY_REASON;
    keywordReason = urgentSafety
      ? URGENT_SAFETY_REASON
      : (keywordReason || currentKeywordReason);

    // Re-read ownership after media processing. Staff may have taken over
    // while a download or transcription was running.
    const currentContact = await contactsRepo.getContactById(contact.id);
    if (!currentContact) throw new Error(`Contact ${contact.id} disappeared during processing.`);
    contact = currentContact;

    if (contact.mode === "human") {
      await contactsRepo.setAttention(
        contact.id,
        true,
        keywordReason || "New message — conversation is staff-owned."
      );
      console.log(`Skipping AI reply for ${channel}:${from} — conversation is in human mode.`);
      return { wasFirstMessage, keywordReason };
    }

    // Earlier messages in the same typing burst are fully saved/transcribed and
    // included in history, but only the last one gets an AI response. This is
    // what turns three short chat bubbles into one coherent assistant reply.
    if (suppressAutoReply) {
      return { wasFirstMessage, keywordReason };
    }

    if (!automatedRepliesEnabled()) {
      // Pausing customer replies must not disable the deterministic safety
      // net. Preserve the normal ownership transition and staff alert for any
      // keyword that requires human review, but do not send a customer-facing
      // handoff acknowledgement while the global switch is off.
      if (keywordReason) {
        const pausedContact = await pauseAiForHumanHandoff(contact.id, keywordReason);
        if (pausedContact) contact = pausedContact;
      }
      console.log(`Skipping AI reply for ${channel}:${from} — automated replies are globally paused.`);
      return { wasFirstMessage, keywordReason };
    }

    const history = await conversationStore.getHistoryForContact(contact.id, {
      throughMessageId: savedInbound.id,
    });
    const isFirstMessage = forceFirstMessage || history.length === 1;
    const rawAiReply = await ai.getReply(history, { isFirstMessage, channel });
    const parsedReply = parseAiReplyResult(rawAiReply);
    let {
      text: aiReply,
      flagged,
      bookingReady,
      details,
    } = parsedReply;

    // The deterministic keyword layer is a safety backstop, not just a badge.
    // If the model misses the handoff entirely, force one. For high-confidence
    // urgent symptom phrases, always use the deterministic immediate-care
    // wording even if the model did choose needs_human but wrote a weak reply.
    if (urgentSafety || (keywordReason && !flagged)) {
      flagged = true;
      bookingReady = false;
      aiReply = fallbackHandoffReply(text, clinicConfig.escalation.handoffMessage);
    }

    const reply = isFirstMessage
      ? `${clinicConfig.introMessage}\n\n${aiReply}`
      : aiReply;

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
        `Skipping AI reply for ${channel}:${from} — WhatsApp Business App staff replied.`
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
    });
    if (!aiReplyContact) return { wasFirstMessage, keywordReason };
    contact = aiReplyContact;

    if (flagged) {
      // A handoff is an actual ownership transition, not only a red badge.
      const pausedContact = await pauseAiForHumanHandoff(
        contact.id,
        keywordReason || "AI handed off this conversation."
      );
      if (!pausedContact) return { wasFirstMessage, keywordReason };

      // Staff can claim the synthetic handoff immediately from the Inbox. Do a
      // final ownership read right before the one allowed AI handoff message so
      // a late model reply does not overwrite a staff member who already acted.
      const pendingHandoff = await getPendingAiHandoffContact(pausedContact.id);
      if (!pendingHandoff) return { wasFirstMessage, keywordReason };
      contact = pendingHandoff;
    }

    // The synthetic AI handoff is intentionally Staff mode, but the one
    // customer-facing handoff acknowledgement is still allowed while that
    // synthetic ownership remains unchanged. Normal replies require AI mode.
    const finalSendContact = flagged
      ? await getPendingAiHandoffContact(contact.id)
      : await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "AI provider send",
        });
    if (!finalSendContact) return { wasFirstMessage, keywordReason };
    contact = finalSendContact;

    // Run this after the final ownership read, as close as possible to the
    // tracked provider send. A Business App webhook marks its echo pending
    // synchronously before any DB work, so a slow echo transaction also blocks
    // the AI instead of allowing a competing reply.
    if (
      aiCancellationKey &&
      !aiReplyCancellation.safeToSend(aiCancellationKey, aiCancellationToken)
    ) {
      console.log(
        `Skipping AI reply for ${channel}:${from} — WhatsApp Business App staff activity is pending or confirmed.`
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
        `Skipping AI reply for ${channel}:${from} — WhatsApp Business App staff activity reached the final send boundary.`
      );
      return { wasFirstMessage, keywordReason };
    }

    // Apply conversion-ready state only after this AI turn was not suppressed
    // by a staff phone reply. Provider rejection still keeps the existing
    // behavior of surfacing Booking Ready for staff follow-up.
    if (bookingReady) {
      try {
        await markBookingReadyForContact(contact.id, savedInbound.id, {
          details,
        });
      } catch (bookingOutcomeErr) {
        console.error(
          `Failed to apply booking-ready outcome for contact ${contact.id}:`,
          bookingOutcomeErr
        );
      }
    }

    // Never follow a sensitive handoff, deterministic safety match, Booking
    // Ready outcome, unresolved staff-attention state, or failed text delivery
    // with a sales graphic. A first-time complaint/medical issue should not be
    // answered with a HIFU promo immediately after the handoff message.
    if (
      isFirstMessage &&
      !flagged &&
      !bookingReady &&
      !keywordReason &&
      !contact.needs_attention &&
      sendOutcome.sendResult.success
    ) {
      const promo = getActivePromotion(clinicConfig.promotions);
      if (promo) {
        const promoContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "automatic promo image",
        });
        // Re-check both ownership and attention immediately before the promo.
        if (!promoContact || promoContact.needs_attention) {
          return { wasFirstMessage, keywordReason };
        }
        contact = promoContact;

        if (canSendAutomatedReply && canSendAutomatedReply() !== true) {
          return { wasFirstMessage, keywordReason };
        }

        const guardedPromo = typeof canSendAutomatedReply === "function";
        const savedPromo = await conversationStore.appendMessageForContact(
          contact.id,
          "assistant",
          promo.caption || "",
          null,
          null,
          promo.imageUrl,
          null,
          guardedPromo ? { publish: false } : undefined
        );
        const promoProviderRecorder = messagesRepo.socialProviderAliasRecorder(
          savedPromo.id,
          contact.channel
        );
        const promoResult = await channelMessaging.sendImageByUrl(
          contact,
          promo.imageUrl,
          promo.caption,
          {
            ...(guardedPromo
              ? { preSendCheck: canSendAutomatedReply }
              : {}),
            ...(promoProviderRecorder
              ? { onProviderMessageId: promoProviderRecorder }
              : {}),
          }
        );

        if (promoResult.cancelled) {
          await messagesRepo.deleteUnsentAssistantMessage(savedPromo.id);
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
          console.warn(`Promo image failed to send to ${channel}:${from}, continuing without it.`);
          await contactsRepo.setDeliveryAttention(
            contact.id,
            `Delivery failed: ${publicDeliveryError(promoError)}`
          );
        }
      }
    }

    return { wasFirstMessage, keywordReason };
  } catch (err) {
    console.error(`Error handling incoming ${channel} message ${id || "without id"}:`, err);

    if (suppressAutoReply) {
      if (contact && savedInbound) {
        try {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
        } catch (attentionErr) {
          console.error("Failed to flag the suppressed burst message after an error:", attentionErr);
        }
      }
      return { wasFirstMessage, keywordReason };
    }

    if (contact && savedInbound) {
      try {
        if (!automatedRepliesEnabled()) {
          await pauseAiForHumanHandoff(
            contact.id,
            "Message processing failed. A staff reply is needed."
          );
          return { wasFirstMessage, keywordReason };
        }

        const fallbackContact = await getAiOwnedContact(contact, {
          channel,
          from,
          reason: "processing-error fallback",
        });

        if (!fallbackContact) {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
          return { wasFirstMessage, keywordReason };
        }

        const pausedContact = await pauseAiForHumanHandoff(
          fallbackContact.id,
          "Message processing failed. A staff reply is needed."
        );
        if (!pausedContact) return { wasFirstMessage, keywordReason };

        const pendingHandoff = await getPendingAiHandoffContact(pausedContact.id);
        if (!pendingHandoff) return { wasFirstMessage, keywordReason };

        if (!responseAttempted) {
          responseAttempted = true;
          await sendTrackedText(
            pendingHandoff,
            "Sorry, something went wrong on our end — a team member will follow up with you shortly!",
            "system_fallback",
            { canSend: canSendAutomatedReply, processingJobId }
          );
        }
      } catch (fallbackErr) {
        console.error("Failed to save or send the fallback message:", fallbackErr);
        try {
          await contactsRepo.setAttention(
            contact.id,
            true,
            "Message processing failed. A staff reply is needed."
          );
        } catch (attentionErr) {
          console.error("Failed to flag the conversation after fallback failure:", attentionErr);
        }
      }
    }

    return { wasFirstMessage, keywordReason };
  }
}

// Runtime secret checks stay in the entry point so a misconfigured production
// deployment still fails before the Express application is constructed.
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
