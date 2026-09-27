const contactsRepo = require("../db/contactsRepo");
const metaStaffEchoRepo = require("../db/metaStaffEchoRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const aiReplyCancellation = require("./aiReplyCancellationService");
const { AI_HANDOFF_OWNER } = require("./aiHandoffService");

function actorForChannel(channel) {
  if (channel === "facebook") return "Facebook";
  if (channel === "instagram") return "Instagram";
  return "Meta";
}

function renderEchoContent(echo) {
  const actor = actorForChannel(echo?.channel);
  if (echo?.isDeleted) return `🗑️ [Message deleted from ${actor}]`;
  if (!echo?.mediaType) return echo?.text || "";
  if (echo.mediaType === "image") {
    return echo.text ? `📷 ${echo.text}` : `📷 [Photo sent from ${actor}]`;
  }
  if (echo.mediaType === "audio") return `🎤 [Voice message sent from ${actor}]`;
  if (echo.mediaType === "video") {
    return echo.text ? `🎥 ${echo.text}` : `🎥 [Video sent from ${actor}]`;
  }
  if (echo.mediaType === "file") return `📄 [File sent from ${actor}]`;
  if (echo.mediaType === "share") return `🔗 [Shared content sent from ${actor}]`;
  return echo.text || `[${echo.mediaType} sent from ${actor}]`;
}

function cancellationKeyForEcho(echo) {
  return aiReplyCancellation.keyForChannelContact(echo?.channel, echo?.to);
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

async function persistStaffEcho(echo, { pendingStarted = false } = {}) {
  if (!echo?.id || !echo?.channel || !echo?.to) return null;
  if (!pendingStarted) beginPendingAiForEcho(echo);

  try {
    const contact = await contactsRepo.getOrCreateChannelContact(
      echo.channel,
      echo.to
    );
    const providerMessageId = `${echo.channel}:${echo.id}`;

    // An echo can reach the webhook a few milliseconds before the outbound
    // request finishes attaching Meta's message id to its Inbox row. Give that
    // write a short grace period so our own send cannot become a fake staff
    // takeover merely because webhook delivery won the race.
    for (const delayMs of [0, 75, 175]) {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const existing = await messagesRepo.getMessageByAnyProviderIdForContact(
        contact.id,
        providerMessageId
      );
      if (existing) {
        releasePendingAiForEcho(echo);
        return null;
      }
    }

    const persisted = await metaStaffEchoRepo.persistStaffEchoIfNew(
      contact.id,
      renderEchoContent(echo),
      providerMessageId,
      actorForChannel(echo.channel),
      AI_HANDOFF_OWNER
    );

    if (!persisted) {
      releasePendingAiForEcho(echo);
      return null;
    }

    if (persisted.isNew) {
      confirmPendingAiForEcho(echo);
      return persisted;
    }

    releasePendingAiForEcho(echo);
    return null;
  } catch (err) {
    releasePendingAiForEcho(echo);
    throw err;
  }
}

async function finalizeStaffEcho(persisted) {
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

  try {
    const actor = persisted.message.sent_by_username || "Meta";
    await pipelineRepo.ensureLeadForContact(
      persisted.contact.id,
      actor,
      persisted.message.id
    );
    await pipelineRepo.markContactedForContact(
      persisted.contact.id,
      actor
    );
  } catch (err) {
    console.error(
      `Failed to align Meta staff-reply pipeline state for contact ${persisted.contact.id}:`,
      err
    );
  }
}

module.exports = {
  actorForChannel,
  renderEchoContent,
  beginPendingAiForEcho,
  releasePendingAiForEcho,
  persistStaffEcho,
  finalizeStaffEcho,
};