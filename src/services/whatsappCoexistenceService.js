const contactsRepo = require("../db/contactsRepo");
const whatsappCoexistenceRepo = require("../db/whatsappCoexistenceRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const aiReplyCancellation = require("./aiReplyCancellationService");
const { AI_HANDOFF_OWNER } = require("./aiHandoffService");

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

function cancellationKeyForEcho(echo) {
  return aiReplyCancellation.keyForWhatsAppNumber(echo?.to);
}

function beginPendingAiForEcho(echo) {
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
    const contact = await contactsRepo.getOrCreateContact(echo.to);

    // Insert the provider message and apply Staff Assist ownership rules in one
    // DB transaction. Ordinary AI-owned chats remain AI-owned; a synthetic AI
    // handoff is claimed as real Staff ownership. A retried echo is a true no-op.
    const persisted = await whatsappCoexistenceRepo.persistStaffEchoIfNew(
      contact.id,
      renderEchoContent(echo),
      echo.id,
      BUSINESS_APP_ACTOR,
      AI_HANDOFF_OWNER
    );

    if (!persisted) {
      releasePendingAiForEcho(echo);
      return null;
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
};
