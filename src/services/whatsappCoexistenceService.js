const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const whatsapp = require("./whatsappService");

const WHATSAPP_BUSINESS_APP_ACTOR = "WhatsApp Business App";

function publishMessage(savedMessage, events = realtimeEvents) {
  if (!savedMessage) return;
  events.publish("conversation_changed", {
    contactId: savedMessage.contact_id,
    messageId: savedMessage.id,
    reason: "message",
  });
}

function createWhatsAppCoexistenceService({
  contacts = contactsRepo,
  messages = messagesRepo,
  pipeline = pipelineRepo,
  events = realtimeEvents,
  whatsappTransport = whatsapp,
} = {}) {
  /**
   * Durably accepts a live WhatsApp Business App staff message.
   *
   * Ownership is changed before the message insert on purpose. If anything
   * fails after that point, the safe failure mode is a conversation that stays
   * Staff-owned rather than an AI that can race a human reply.
   */
  async function storeStaffEcho(echo) {
    if (!echo?.id || !echo?.to) return null;

    // A retry or an overlapping provider callback for a message already saved
    // by the Cloud API must not turn the conversation into Staff mode.
    const existing = await messages.findByWhatsappMessageId(echo.id);
    if (existing) {
      return { duplicate: true, savedMessage: existing, contact: null, echo };
    }

    const contact = await contacts.getOrCreateContact(echo.to);
    if (!contact) throw new Error(`Could not resolve WhatsApp contact ${echo.to} for staff echo.`);

    const staffOwned = await contacts.takeOver(contact.id, WHATSAPP_BUSINESS_APP_ACTOR);
    if (!staffOwned) {
      throw new Error(`Could not place contact ${contact.id} into Staff mode for Business App echo.`);
    }

    const savedMessage = await messages.saveExternalMessageIfNew({
      contactId: contact.id,
      role: "assistant",
      content: echo.text || "[WhatsApp Business App staff sent a message]",
      whatsappMessageId: echo.id,
      sentByUsername: WHATSAPP_BUSINESS_APP_ACTOR,
      createdAt: echo.timestamp,
      isHistoryImport: false,
    });

    if (!savedMessage) {
      const duplicate = await messages.findByWhatsappMessageId(echo.id);
      return { duplicate: true, savedMessage: duplicate, contact: staffOwned, echo };
    }

    publishMessage(savedMessage, events);

    // A real staff message is equivalent to a staff send from the DA Inbox for
    // pipeline purposes. Never pull a lead backwards: markContactedForContact()
    // already only advances the system New stage.
    try {
      await pipeline.markContactedForContact(contact.id, WHATSAPP_BUSINESS_APP_ACTOR);
    } catch (err) {
      console.error(
        `Failed to mark contact ${contact.id} as contacted after WhatsApp Business App reply:`,
        err
      );
    }

    return { duplicate: false, savedMessage, contact: staffOwned, echo };
  }

  /**
   * Media hydration is deliberately post-ACK. The staff message and takeover
   * are already durable before Meta receives HTTP 200, so a slow media download
   * can never delay webhook acknowledgement or reopen an AI race.
   */
  async function hydrateStaffEchoMedia(result) {
    const echo = result?.echo;
    const savedMessage = result?.savedMessage;
    if (!echo?.mediaId || !savedMessage?.id || result?.duplicate) return null;
    if (!["image", "audio"].includes(echo.mediaType)) return null;

    try {
      const media = await whatsappTransport.downloadMedia(echo.mediaId);
      if (!media) return null;
      const updated = await messages.updateExternalMessageMedia(
        savedMessage.id,
        savedMessage.contact_id,
        media.buffer,
        media.mimeType
      );
      publishMessage(updated, events);
      return updated;
    } catch (err) {
      console.error(
        `Failed to hydrate WhatsApp Business App media for message ${savedMessage.id}:`,
        err
      );
      return null;
    }
  }

  /**
   * Imports historical Business App messages only as historical Inbox context.
   * This path intentionally does not call takeover, lead creation, lead scoring,
   * unread/attention state, follow-up scheduling, or any automatic reply code.
   */
  async function storeHistory(records) {
    const ordered = [...(records || [])].sort((a, b) => {
      const aTime = Date.parse(a?.timestamp || "") || 0;
      const bTime = Date.parse(b?.timestamp || "") || 0;
      return aTime - bTime;
    });

    let inserted = 0;
    let duplicates = 0;
    const touchedContacts = new Set();

    for (const record of ordered) {
      if (!record?.id || !record?.peer) continue;
      const contact = await contacts.getOrCreateContact(record.peer);
      if (!contact) continue;

      const saved = await messages.saveExternalMessageIfNew({
        contactId: contact.id,
        role: record.direction === "business" ? "assistant" : "user",
        content: record.text || "[Historical WhatsApp message]",
        whatsappMessageId: record.id,
        sentByUsername:
          record.direction === "business" ? WHATSAPP_BUSINESS_APP_ACTOR : null,
        createdAt: record.timestamp,
        isHistoryImport: true,
      });

      if (saved) {
        inserted += 1;
        touchedContacts.add(contact.id);
      } else {
        duplicates += 1;
      }
    }

    for (const contactId of touchedContacts) {
      events.publish("conversation_changed", {
        contactId,
        reason: "history_import",
      });
    }

    return { inserted, duplicates, touchedContacts: touchedContacts.size };
  }

  /**
   * Meta's state sync mirrors the business owner's address book. Creating every
   * synced address-book entry as a CRM lead would pollute Contacts/Pipeline, so
   * the first coexistence implementation records no CRM side effects here.
   * Existing live/history messages still create the contacts they actually need.
   */
  async function acceptStateSync(records) {
    return { received: Array.isArray(records) ? records.length : 0, imported: 0 };
  }

  return {
    acceptStateSync,
    hydrateStaffEchoMedia,
    storeHistory,
    storeStaffEcho,
  };
}

const service = createWhatsAppCoexistenceService();

module.exports = {
  WHATSAPP_BUSINESS_APP_ACTOR,
  createWhatsAppCoexistenceService,
  acceptStateSync: service.acceptStateSync,
  hydrateStaffEchoMedia: service.hydrateStaffEchoMedia,
  storeHistory: service.storeHistory,
  storeStaffEcho: service.storeStaffEcho,
};
