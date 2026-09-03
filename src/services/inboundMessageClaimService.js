const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const leadAttributionService = require("./leadAttributionService");
const conversationStore = require("../utils/conversationStore");
const whatsappPolicy = require("./whatsappPolicyService");

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
  attribution = leadAttributionService,
  store = conversationStore,
  policy = whatsappPolicy,
} = {}) {
  return async function claimIncomingMessage(incoming) {
    // Messenger/Instagram may send OPEN_THREAD attribution as its own event
    // before the customer types. Remember it without creating a fake contact,
    // lead or message; the next real inbound message consumes it.
    if (incoming?.attributionOnly) {
      try {
        await attribution.rememberPendingReferral(incoming);
      } catch (err) {
        console.error(
          `Failed to remember pending ${incoming.channel || "Meta"} attribution for ${incoming.from}:`,
          err
        );
      }
      return null;
    }

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

    const isWhatsappOptOut =
      channel === "whatsapp" &&
      incoming.mediaType == null &&
      policy.isOptOutText(incoming.text);

    // A clear stop/unsubscribe request is terminal for this inbound turn. Keep
    // the customer's message durable and visible, mark it unread/attention,
    // then return without lead scoring, AI generation, promo delivery or an
    // automated acknowledgement. A later genuine customer-initiated message
    // can start a new service conversation without restoring marketing consent.
    if (isWhatsappOptOut) {
      try {
        await policy.recordOptOut(contact.id, "customer_message");
      } catch (err) {
        // Even when the consent-state write has a transient failure, fail
        // closed for this turn and never continue into an outbound AI reply.
        console.error(`Failed to record WhatsApp opt-out for contact ${contact.id}:`, err);
      }

      try {
        await contacts.setAttention(
          contact.id,
          true,
          "Customer opted out of WhatsApp messages. Do not send proactive messages without a new explicit opt-in."
        );
      } catch (err) {
        console.error(`Failed to flag WhatsApp opt-out for contact ${contact.id}:`, err);
      }

      try {
        await contacts.setUnread(contact.id, true);
      } catch (err) {
        console.error(`Failed to mark opt-out message unread for contact ${contact.id}:`, err);
      }

      return null;
    }

    // Operational bookkeeping is best-effort after the durable message claim.
    // A transient failure here must not turn a successfully stored customer
    // message into an unhandled webhook failure.
    try {
      await contacts.setUnread(contact.id, true);
    } catch (err) {
      console.error(`Failed to mark contact ${contact.id} unread after inbound claim:`, err);
    }

    let lead = null;
    let leadOutcome = null;
    try {
      leadOutcome = await pipeline.ensureLeadForContact(
        contact.id,
        "Automation",
        savedInbound.id
      );
      lead = leadOutcome?.lead || null;
    } catch (err) {
      console.error(`Failed to create or locate lead for contact ${contact.id}:`, err);
    }

    // First-touch attribution belongs to the start of a lead journey. Do not
    // retrofit an old open lead with a new ad click after this feature is
    // deployed. A concurrently-created lead is still safe because its stable
    // journey boundary equals this first inbound message.
    const startsThisJourney = Boolean(
      lead &&
      (
        leadOutcome?.created === true ||
        Number(lead.started_message_id) === Number(savedInbound.id)
      )
    );

    if (startsThisJourney) {
      try {
        await attribution.captureForInbound({
          lead,
          incoming,
          firstMessageId: savedInbound.id,
        });
      } catch (err) {
        // Attribution must never block the patient conversation. The raw
        // message is already durable and can still be handled normally.
        console.error(`Failed to capture lead attribution for lead ${lead.id}:`, err);
      }
    } else {
      // A pending social OPEN_THREAD referral belongs to the next actual
      // message, even when that message is part of an older open journey. Eat
      // it here so it cannot leak into a future lead after this one is closed.
      try {
        await attribution.consumePendingForInbound?.(incoming);
      } catch (err) {
        console.error(
          `Failed to clear unused pending attribution for ${channel}:${incoming.from}:`,
          err
        );
      }
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
