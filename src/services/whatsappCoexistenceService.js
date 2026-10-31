const contactsRepo = require("../db/contactsRepo");
const senderConversations = require("../db/whatsappSenderConversationRepo");
const whatsappCoexistenceRepo = require("../db/whatsappCoexistenceRepo");
const inboundProcessingRepo = require("../db/inboundProcessingRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const { recordStaffConfirmedBooking } = require("./staffBookingConfirmationService");
const realtimeEvents = require("../utils/realtimeEvents");
const aiReplyCancellation = require("./aiReplyCancellationService");
const { AI_HANDOFF_OWNER } = require("./aiHandoffService");
const echoMedia = require("./whatsappCoexistenceMediaService");
const echoMutations = require("./whatsappCoexistenceMutationService");

const BUSINESS_APP_ACTOR = "WhatsApp Business App";

function renderEchoContent(echo) {
  if (echo.type === "text") return echo.text || "";
  if (echo.type === "image") return echo.text ? `📷 ${echo.text}` : "📷 [Photo sent from WhatsApp Business App]";
  if (echo.type === "audio") return "🎤 [Voice message sent from WhatsApp Business App]";
  if (echo.type === "video") return echo.text ? `🎥 ${echo.text}` : "🎥 [Video sent from WhatsApp Business App]";
  if (echo.type === "document") return "📄 [Document sent from WhatsApp Business App]";
  if (echo.type === "sticker") return "🙂 [Sticker sent from WhatsApp Business App]";
  if (echo.type === "revoke") return "🗑️ [Message deleted from WhatsApp Business App]";
  if (echo.type === "edit") return "✏️ [Message edited from WhatsApp Business App]";
  return `[${echo.type || "Message"} sent from WhatsApp Business App]`;
}

function senderAwareEchoesEnabled() {
  return process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true";
}

function verifiedPrimaryEchoIdentity(echo) {
  const phone = String(echo?.businessPhoneNumberId || "").trim();
  const account = String(echo?.businessAccountId || "").trim();
  if (!/^\d+$/.test(phone) || !/^\d+$/.test(account) ||
      phone !== String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim() ||
      account !== String(process.env.WHATSAPP_WABA_ID || "").trim()) {
    throw new Error("Business App echo does not identify the verified primary sender.");
  }
  return { accountId: account, phoneNumberId: phone, customerPhone: echo.to };
}

function verifiedEchoIdentity(echo) {
  try { return {...verifiedPrimaryEchoIdentity(echo),
    senderKey:String(process.env.WHATSAPP_PRIMARY_SENDER_KEY||"").trim()}; }
  catch(primaryError) {
    const phone=String(echo?.businessPhoneNumberId||"").trim();
    const account=String(echo?.businessAccountId||"").trim();
    if(process.env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true" ||
       !/^[0-9]+$/.test(phone) || !/^[0-9]+$/.test(account) ||
       phone!==String(process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"").trim() ||
       account!==String(process.env.WHATSAPP_SECONDARY_WABA_ID||"").trim()) {
      throw primaryError;
    }
    return {accountId:account,phoneNumberId:phone,customerPhone:echo.to,
      senderKey:String(process.env.WHATSAPP_SECONDARY_SENDER_KEY||"").trim()};
  }
}

function cancellationKeyForEcho(echo) {
  if (!senderAwareEchoesEnabled()) {
    return aiReplyCancellation.keyForWhatsAppNumber(echo?.to);
  }
  // An unverified foreign echo must NEVER cancel the primary AI turn.
  try {
    const key = verifiedEchoIdentity(echo).senderKey;
    return key ? aiReplyCancellation.keyForWhatsAppNumber(echo?.to, key) : null;
  } catch {
    return null;
  }
}

function beginPendingAiForEcho(echo) {
  // Edits/deletions of old staff messages are not new staff replies.
  // Never stall or cancel an unrelated in-flight AI response for them.
  if (echo?.type==="edit" || echo?.type==="revoke") return false;
  return aiReplyCancellation.beginPendingEcho(
    cancellationKeyForEcho(echo),
    echo?.id
  );
}

function releasePendingAiForEcho(echo) {
  aiReplyCancellation.endPendingEcho(
    cancellationKeyForEcho(echo),
    echo?.id
  );
}

function confirmPendingAiForEcho(echo) {
  const key = cancellationKeyForEcho(echo);
  aiReplyCancellation.cancel(key);
  aiReplyCancellation.endPendingEcho(key, echo?.id);
}

function cancelPendingAiForEcho(echo) {
  return aiReplyCancellation.cancel(cancellationKeyForEcho(echo));
}

async function persistBusinessAppEcho(echo, { pendingStarted = false } = {}) {
  if (!echo?.id || !echo?.to) return null;
  if (!pendingStarted) beginPendingAiForEcho(echo);

  try {
    if (await inboundProcessingRepo.isDeletedProviderMessageId(echo.id)) {
      releasePendingAiForEcho(echo);
      return null;
    }

    const isSecondaryMutation=senderAwareEchoesEnabled() &&
      echo.businessPhoneNumberId===process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
      echo.businessAccountId===process.env.WHATSAPP_SECONDARY_WABA_ID &&
      ["edit","revoke"].includes(echo.type);
    // Verify the signed sender before looking anything up. Mutations can only
    // affect an already-bound sender-owned contact, never create a new lead.
    const identity=senderAwareEchoesEnabled()?verifiedEchoIdentity(echo):null;
    const contact=isSecondaryMutation
      ? await senderConversations.findBoundContactForSender(identity)
      : senderAwareEchoesEnabled()
        ? await senderConversations.claimSenderContact(identity)
        : await contactsRepo.getOrCreateContact(echo.to);
    if (!contact) {
      releasePendingAiForEcho(echo);
      return null;
    }

    if (isSecondaryMutation) {
      const changed=await echoMutations.record(echo,contact);
      // An old edit/revoke is never a new staff reply. Whether it applies,
      // remains pending, or replays, it must not cancel an AI response.
      releasePendingAiForEcho(echo);
      // Only an actual update to the original message notifies the Inbox.
      return changed?.messageId
        ? {contact,message:{id:changed.messageId},isNew:false,isMutation:true}
        : null;
    }

    // Insert the provider message and apply Staff Assist ownership rules in one
    // DB transaction. Ordinary AI-owned chats remain AI-owned; a synthetic AI
    // handoff is claimed as real Staff ownership. A retried echo is a true no-op.
    const persisted = await whatsappCoexistenceRepo.persistStaffEchoIfNew(
      contact.id,
      renderEchoContent(echo),
      echo.id,
      BUSINESS_APP_ACTOR,
      AI_HANDOFF_OWNER,
      null,
      senderAwareEchoesEnabled() ? contact.whatsapp_sender_conversation_id : null
    );

    if (!persisted) {
      releasePendingAiForEcho(echo);
      return null;
    }

    // Provider-authenticated media echoes are durably queued for FETCH ONLY,
    // never re-sent by the Cloud API. On failure Meta retries safely because
    // the existing WAMID and queue job are both idempotent.
    if (echo.mediaId && ["image","video","audio","document","sticker"].includes(echo.type) &&
        echoMedia.enabled(process.env) &&
        echo.businessPhoneNumberId === process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
        echo.businessAccountId === process.env.WHATSAPP_SECONDARY_WABA_ID) {
      const queued=await echoMedia.enqueue({
        contactId:contact.id,messageId:persisted.message.id,
        wamid:echo.id,mediaId:echo.mediaId,type:echo.type,
      });
      if (!queued)throw new Error("Could not durably queue verified Business App echo media.");
    }

    if (persisted.isNew) {
      // Only a genuinely new app-originated staff action invalidates the
      // current AI turn. The pending flag was set synchronously before DB work
      // so an in-flight AI can fail closed while this transaction resolves.
      confirmPendingAiForEcho(echo);
    } else {
      // A Meta retry may still need post-ACK bookkeeping to run again, but it
      // must not cancel a later AI turn or alter ownership.
      releasePendingAiForEcho(echo);
    }

    // Business App echoes insert their provider WAMID directly instead of
    // calling messagesRepo.setWhatsappMessageId(). Reconcile any reaction that
    // arrived first so coexistence messages get the same reaction guarantees as
    // API-sent messages. A reconciliation error is non-fatal to the staff send.
    let reactionUpdate = null;
    try {
      reactionUpdate = await messagesRepo.reconcilePendingWhatsappReactionsForMessage(
        persisted.message.id,
        persisted.message.whatsapp_message_id || echo.id
      );
    } catch (err) {
      console.error(
        `Failed to reconcile pending WhatsApp reaction for Business App echo ${echo.id}:`,
        err
      );
    }

    return reactionUpdate ? { ...persisted, reactionUpdate } : persisted;
  } catch (err) {
    releasePendingAiForEcho(echo);
    throw err;
  }
}

async function finalizeBusinessAppEcho(persisted) {
  if (!persisted?.contact?.id || !persisted?.message?.id) return;
  if(persisted.isMutation){
    realtimeEvents.publish("conversation_changed",{
      contactId:persisted.contact.id,
      messageId:persisted.message.id,reason:"message",
    });
    return;
  }

  realtimeEvents.publish("conversation_changed", {
    contactId: persisted.contact.id,
    reason: "contact_state",
  });
  realtimeEvents.publish("conversation_changed", {
    contactId: persisted.contact.id,
    messageId: persisted.message.id,
    reason: "message",
  });
  if (persisted.reactionUpdate?.changed) {
    realtimeEvents.publish("conversation_changed", {
      contactId: persisted.reactionUpdate.contactId,
      messageId: persisted.reactionUpdate.messageId,
      reactions: persisted.reactionUpdate.reactions,
      reason: "reaction",
    });
  }

  // The provider-authenticated staff echo is a real accepted reply. Reconcile
  // only a delivery-only or routine staff-waiting attention reason, using the
  // same latest-inbound and failed-media guards as the Inbox send route.
  // This is idempotent for webhook replays; pending clinical and booking
  // reviews cannot be dismissed by an unrelated staff message.
  try {
    await contactsRepo.clearDeliveryAttentionIfNoFailedMessages(persisted.contact.id);
  } catch (attentionError) {
    console.error("Could not reconcile staff-echo delivery attention:", attentionError);
  }

  try {
    // A Business App message can be the first message our system has ever seen
    // for this contact, so make sure the existing pipeline has a journey before
    // applying the normal "staff sent a message" Contacted transition.
    await pipelineRepo.ensureLeadForContact(
      persisted.contact.id,
      BUSINESS_APP_ACTOR,
      persisted.message.id
    );
    await pipelineRepo.markContactedForContact(
      persisted.contact.id,
      BUSINESS_APP_ACTOR
    );
  } catch (err) {
    // Pipeline bookkeeping must never make Meta retry an already-persisted
    // staff message or alter the Inbox/ownership state.
    console.error(
      `Failed to align Business App pipeline state for contact ${persisted.contact.id}:`,
      err
    );
  }
  // Only fresh authenticated staff echoes may confirm a full, explicit slot.
  // Provider echo already proves Meta accepted this outbound message.
  if (persisted.isNew && !persisted.message.is_forwarded) {
    try {
      await recordStaffConfirmedBooking(
        persisted.contact.id,
        persisted.message.content,
        { providerAccepted: true }
      );
    } catch (bookingError) {
      console.error("Failed to sync staff echo booking confirmation:", bookingError);
    }
  }

}

function summarizePassiveSync(body) {
  let historyChunks = 0;
  let appStateItems = 0;
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field === "history") {
        historyChunks += Array.isArray(change?.value?.history) ? change.value.history.length : 0;
      } else if (change?.field === "smb_app_state_sync") {
        appStateItems += Array.isArray(change?.value?.state_sync) ? change.value.state_sync.length : 0;
      }
    }
  }
  return { historyChunks, appStateItems };
}

module.exports = {
  BUSINESS_APP_ACTOR,
  renderEchoContent,
  beginPendingAiForEcho,
  releasePendingAiForEcho,
  confirmPendingAiForEcho,
  cancelPendingAiForEcho,
  persistBusinessAppEcho,
  finalizeBusinessAppEcho,
  summarizePassiveSync,
  verifiedPrimaryEchoIdentity,
};
