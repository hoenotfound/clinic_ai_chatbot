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
  function isWhatsappOptOut(incoming) {
    return Boolean(
      (incoming?.channel || "whatsapp") === "whatsapp" &&
      incoming?.mediaType == null &&
      policy.isOptOutText(incoming?.text)
    );
  }

  async function prepareStoredInbound({
    incoming,
    contact,
    savedInbound,
    processingJob,
    derivedFirstMessage = false,
    hasDerivedFirstMessage = false,
  }) {
    const channel = incoming.channel || "whatsapp";

    // A clear stop/unsubscribe request is terminal for this inbound turn. Keep
    // the customer's message durable and visible, mark it unread/attention,
    // then complete its processing job without generating any outbound reply.
    if (isWhatsappOptOut(incoming)) {
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

  /**
   * The lightweight webhook durability phase. This intentionally stops before
   * lead bookkeeping, media downloads, transcription or AI work so webhook
   * handlers can await it before returning HTTP 200 to Meta.
   */
  async function storeIncomingMessage(incoming) {
    // OPEN_THREAD attribution is already persisted in Postgres. Awaiting it in
    // the webhook durability phase means the referral also survives a restart.
    if (incoming?.attributionOnly) {
      await attribution.rememberPendingReferral(incoming);
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

    const durableClaim = await processing.storeInboundClaim({
      contactId: contact.id,
      content: initialInboundText(incoming),
      storedMessageId: storedInboundId,
      channel,
      incoming,
    });
    if (!durableClaim) return null;

    publishInboundMessage(events, durableClaim.savedInbound);
    return {
      incoming,
      contact,
      savedInbound: durableClaim.savedInbound,
      processingJob: durableClaim.processingJob,
    };
  }

  /**
   * Starts live processing after the webhook has been acknowledged. Claim the
   * durable row first so the periodic recovery sweep can never process the same
   * fresh message concurrently. If the process dies during preparation, the
   * stale-processing lease makes the job recoverable later.
   */
  async function prepareIncomingClaim(durableClaim) {
    if (!durableClaim) return null;
    const { incoming, savedInbound } = durableClaim;

    // Opt-outs never enter the outbound-processing lease; they are completed
    // directly by prepareStoredInbound with no automated response.
    if (isWhatsappOptOut(incoming)) {
      return prepareStoredInbound(durableClaim);
    }

    let processingJob = durableClaim.processingJob;
    if (processingJob?.status === "pending" || !processingJob?.status) {
      processingJob = await processing.claimPendingByMessageId(savedInbound.id);
      if (!processingJob) return null;
    }

    try {
      return await prepareStoredInbound({
        ...durableClaim,
        processingJob,
      });
    } catch (err) {
      await processing.markFailed(processingJob.id, err).catch((markErr) => {
        console.error(
          `Failed to persist preparation failure for inbound job ${processingJob.id}:`,
          markErr
        );
      });
      throw err;
    }
  }

  // Compatibility/direct-call helper: durable store followed by live prepare.
  async function claimIncomingMessage(incoming) {
    const durableClaim = await storeIncomingMessage(incoming);
    return prepareIncomingClaim(durableClaim);
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

  claimIncomingMessage.prepareIncomingClaim = prepareIncomingClaim;
  claimIncomingMessage.prepareStoredInbound = prepareStoredInbound;
  claimIncomingMessage.resumeProcessingJob = resumeProcessingJob;
  claimIncomingMessage.storeIncomingMessage = storeIncomingMessage;
  return claimIncomingMessage;
}

const claimIncomingMessage = createInboundMessageClaimService();
const prepareIncomingClaim = claimIncomingMessage.prepareIncomingClaim;
const resumeIncomingProcessingJob = claimIncomingMessage.resumeProcessingJob;
const storeIncomingMessage = claimIncomingMessage.storeIncomingMessage;

module.exports = {
  createInboundMessageClaimService,
  claimIncomingMessage,
  initialInboundText,
  prepareIncomingClaim,
  resumeIncomingProcessingJob,
  storeIncomingMessage,
};
