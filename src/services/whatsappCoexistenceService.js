const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const aiReplyCancellation = require("./aiReplyCancellationService");

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

function cancelPendingAiForEcho(echo) {
  return aiReplyCancellation.cancel(
    aiReplyCancellation.keyForWhatsAppNumber(echo?.to)
  );
}

async function persistBusinessAppEcho(echo) {
  if (!echo?.id || !echo?.to) return null;

  // The synchronous webhook parser calls cancelPendingAiForEcho before any DB
  // wait. Repeating it here protects direct callers and restart/retry paths.
  cancelPendingAiForEcho(echo);

  const contact = await contactsRepo.getOrCreateContact(echo.to);

  // A phone-app reply is an explicit human action. Keep the conversation in
  // staff mode until someone intentionally returns it to AI from the Inbox.
  const staffOwned = await contactsRepo.takeOver(contact.id, BUSINESS_APP_ACTOR);
  if (!staffOwned) throw new Error(`Could not take over contact ${contact.id} for Business App echo.`);

  const saved = await messagesRepo.saveStaffMessageIfNew(
    contact.id,
    renderEchoContent(echo),
    echo.id,
    BUSINESS_APP_ACTOR
  );

  if (!saved) return null;

  realtimeEvents.publish("conversation_changed", {
    contactId: contact.id,
    messageId: saved.id,
    reason: "message",
  });

  try {
    await pipelineRepo.markContactedForContact(contact.id, BUSINESS_APP_ACTOR);
  } catch (err) {
    // Pipeline bookkeeping must not make Meta retry an already-persisted staff
    // message. The Inbox/ownership state remains authoritative.
    console.error(
      `Failed to mark Business App contact ${contact.id} as contacted:`,
      err
    );
  }

  return { contact: staffOwned, message: saved };
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
  cancelPendingAiForEcho,
  persistBusinessAppEcho,
  summarizePassiveSync,
};
