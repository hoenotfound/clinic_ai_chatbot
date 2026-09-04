const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const inboundProcessingRepo = require("../db/inboundProcessingRepo");
const leadAttributionService = require("./leadAttributionService");
const realtimeEvents = require("../utils/realtimeEvents");
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

function publishInboundMessage(events, savedInbound) {
  if (!savedInbound) return;
  events.publish("conversation_changed", {
    contactId: savedInbound.contact_id,
    messageId: savedInbound.id,
    reason: "message",
  });
}

function createInboundMessageClaimService({
  contacts = contactsRepo,
  messages = messagesRepo,
  pipeline = pipelineRepo,
  attribution = leadAttributionService,
  processing = inboundProcessingRepo,
  events = realtimeEvents,
  policy = whatsappPolicy,
} = {}) {
  async function prepareStoredInbound({
    incoming,
    contact,
    savedInbound,
    processingJob,
    derivedFirstMessage = false,
    hasDerivedFirstMessage = false,
  }) {
    const channel = incoming.channel || "whatsapp";
    const isWhatsappOptOut =
      channel === "whatsapp" &&
      incoming.mediaType == null &&
      policy.isOptOutText(incoming.text);

    // A clear stop/unsubscribe request is terminal for this inbound turn. Keep
    // the customer's message durable and visible, mark it unread/attention,
    // then complete its processing job without generating any outbound reply.
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

      await processing.markCompletedByMessageId(savedInbound.id);
      return null;
    }

    // Operational bookkeeping is best-effort after the durable message + job
    // claim. If the process dies anywhere below, prepared_at remains null and
    // the recovery worker re-runs this idempotent preparation before replying.
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
    // deployed. The first-touch repository is uniqueness-protected, so a
    // recovery pass can safely attempt this again after an interrupted prepare.
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
        // message and processing job are already durable.
        console.error(`Failed to capture lead attribution for lead ${lead.id}:`, err);
      }
    } else {
      // A pending social OPEN_THREAD referral belongs to the next actual
      // message. Clear it once the journey decision has been made so it cannot
      // leak into a future lead after this one is closed.
      try {
        await attribution.consumePendingForInbound?.(incoming);
      } catch (err) {
        console.error(
          `Failed to clear unused pending attribution for ${channel}:${incoming.from}:`,
          err
        );
      }
    }

    let wasFirstMessage = Boolean(derivedFirstMessage);
    if (!hasDerivedFirstMessage) {
      try {
        const firstPage = await messages.getMessagePageForContact(contact.id, {
          limit: 2,
          includeMedia: false,
        });
        wasFirstMessage = firstPage.rows.length === 1 && !firstPage.hasMore;
      } catch (err) {
        // This only controls the fixed intro. It must never sacrifice the real
        // customer reply if the cosmetic first-message lookup has a DB error.
        console.error(`Failed to determine first-message state for contact ${contact.id}:`, err);
      }
    }

    const preparedJob = await processing.markPrepared(
      savedInbound.id,
      wasFirstMessage
    );

    return {
      incoming,
      contact,
      savedInbound,
      wasFirstMessage,
      processingJobId: preparedJob?.id || processingJob?.id || null,
    };
  }

  async function claimIncomingMessage(incoming) {
    // Messenger/Instagram may send OPEN_THREAD attribution as its own event
    // before the customer types. Remember it without creating a fake contact,
    // lead, message or reply-processing job.
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

    const storedInboundId = channel === "whatsapp"
      ? incoming.id
      : `${channel}:${incoming.id}`;

    // This is the durability boundary: the customer message and its pending
    // processing job are one SQL statement. After this succeeds, a Render
    // restart can delay the reply but cannot make the reply work disappear.
    const durableClaim = await processing.storeInboundClaim({
      contactId: contact.id,
      content: initialInboundText(incoming),
      storedMessageId: storedInboundId,
      channel,
      incoming,
    });
    if (!durableClaim) return null;

    publishInboundMessage(events, durableClaim.savedInbound);
    return prepareStoredInbound({
      incoming,
      contact,
      savedInbound: durableClaim.savedInbound,
      processingJob: durableClaim.processingJob,
    });
  }

  async function resumeProcessingJob(job) {
    const context = await processing.getJobContext(job.id);
    if (!context) {
      throw new Error(`Inbound processing job ${job.id} no longer has its customer message.`);
    }

    const liveJob = context.job;
    const incoming = liveJob.incoming_payload;
    const contact = await contacts.getContactById(liveJob.contact_id);
    if (!contact) {
      throw new Error(`Contact ${liveJob.contact_id} no longer exists for inbound job ${job.id}.`);
    }

    if (liveJob.prepared_at) {
      return {
        incoming,
        contact,
        savedInbound: context.savedInbound,
        wasFirstMessage:
          liveJob.was_first_message == null
            ? context.derivedFirstMessage
            : Boolean(liveJob.was_first_message),
        processingJobId: liveJob.id,
      };
    }

    return prepareStoredInbound({
      incoming,
      contact,
      savedInbound: context.savedInbound,
      processingJob: liveJob,
      derivedFirstMessage: context.derivedFirstMessage,
      hasDerivedFirstMessage: true,
    });
  }

  claimIncomingMessage.resumeProcessingJob = resumeProcessingJob;
  claimIncomingMessage.prepareStoredInbound = prepareStoredInbound;
  return claimIncomingMessage;
}

const claimIncomingMessage = createInboundMessageClaimService();
const resumeIncomingProcessingJob = claimIncomingMessage.resumeProcessingJob;

module.exports = {
  createInboundMessageClaimService,
  claimIncomingMessage,
  initialInboundText,
  resumeIncomingProcessingJob,
};
