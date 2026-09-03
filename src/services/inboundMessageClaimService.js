const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const conversationStore = require("../utils/conversationStore");

function initialInboundText(incoming) {
  if (incoming.unsupportedType) {
    return `📎 [Patient sent an unsupported ${incoming.unsupportedType} message]`;
  }
  if (incoming.mediaType === "audio") return "🎤 [Patient sent a voice message]";
  if (incoming.mediaType === "image") {
    return incoming.text ? `📷 ${incoming.text}` : "📷 [Patient sent a photo]";
  }
  return incoming.text || "[Patient sent an empty message]";
}

function createInboundMessageClaimService({
  contacts = contactsRepo,
  messages = messagesRepo,
  pipeline = pipelineRepo,
  store = conversationStore,
} = {}) {
  return async function claimIncomingMessage(incoming) {
    const channel = incoming.channel || "whatsapp";
    const contact = channel === "whatsapp"
      ? await contacts.getOrCreateContact(incoming.from, incoming.profileName)
      : await contacts.getOrCreateChannelContact(
          channel,
          incoming.from,
          incoming.profileName,
          incoming.photoUrl || null
        );

    // Claim the webhook payload immediately, before any reply debounce, media
    // download, transcription or AI call. Meta has already received HTTP 200,
    // so this durable INSERT is what prevents a Render restart during the short
    // typing debounce from making the customer's message disappear entirely.
    const storedInboundId = channel === "whatsapp"
      ? incoming.id
      : `${channel}:${incoming.id}`;
    const savedInbound = await store.appendInboundMessageIfNew(
      contact.id,
      initialInboundText(incoming),
      storedInboundId
    );
    if (!savedInbound) return null;

    // Operational bookkeeping is best-effort after the durable message claim.
    // A transient failure here must not turn a successfully stored customer
    // message into an unhandled webhook failure.
    try {
      await contacts.setUnread(contact.id, true);
    } catch (err) {
      console.error(`Failed to mark contact ${contact.id} unread after inbound claim:`, err);
    }

    try {
      await pipeline.ensureLeadForContact(
        contact.id,
        "Automation",
        savedInbound.id
      );
    } catch (err) {
      console.error(`Failed to create or locate lead for contact ${contact.id}:`, err);
    }

    let wasFirstMessage = false;
    try {
      const firstPage = await messages.getMessagePageForContact(contact.id, {
        limit: 2,
        includeMedia: false,
      });
      wasFirstMessage = firstPage.rows.length === 1 && !firstPage.hasMore;
    } catch (err) {
      // This only affects whether a multi-bubble first burst receives the fixed
      // intro. Do not sacrifice the actual reply if this cosmetic check fails.
      console.error(`Failed to determine first-message state for contact ${contact.id}:`, err);
    }

    return {
      incoming,
      contact,
      savedInbound,
      wasFirstMessage,
    };
  };
}

const claimIncomingMessage = createInboundMessageClaimService();

module.exports = {
  createInboundMessageClaimService,
  claimIncomingMessage,
  initialInboundText,
};