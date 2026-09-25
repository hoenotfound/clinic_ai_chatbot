const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const historyJobRepo = require("../db/whatsappCoexistenceHistoryRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const whatsapp = require("./whatsappService");

const WHATSAPP_BUSINESS_APP_ACTOR = "WhatsApp Business App";
const HISTORY_RECOVERY_INTERVAL_MS = 10 * 1000;
const HISTORY_IDLE_RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HISTORY_STALE_AFTER_SECONDS = 2 * 60;
const HISTORY_STALE_RECHECK_GRACE_MS = 5 * 1000;
const HISTORY_BATCH_SIZE = 10;
const HISTORY_MAX_ATTEMPTS = 5;
const HISTORY_COMPLETED_RETENTION_HOURS = 24;
const HISTORY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function historyRecordsFromJob(job) {
  const payload =
    typeof job?.payload === "string"
      ? JSON.parse(job.payload)
      : job?.payload || {};
  return Array.isArray(payload.records) ? payload.records : [];
}

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
  historyJobs = historyJobRepo,
  events = realtimeEvents,
  whatsappTransport = whatsapp,
  logger = console,
} = {}) {
  let historyRecoveryRunning = false;
  let historyRecoveryTimer = null;
  let lastHistoryPrunedAt = Date.now();

  function wakeHistoryRecovery(delayMs = 0) {
    return historyRecoveryTimer?.wake(delayMs) || false;
  }
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
   * Persist a complete history webhook chunk before HTTP 200. Importing it is
   * replayable and happens after the acknowledgement.
   */
  async function storeHistoryJob(records) {
    if (!Array.isArray(records) || records.length === 0) return null;
    return historyJobs.store(records);
  }

  async function processClaimedHistoryJob(job) {
    const result = await storeHistory(historyRecordsFromJob(job));
    const completed = await historyJobs.markCompleted(job.id, job.lease_token);
    if (!completed) {
      const err = new Error(
        "History job " + job.id + " lost its processing lease before completion."
      );
      err.code = "COEXISTENCE_HISTORY_LEASE_LOST";
      throw err;
    }
    return result;
  }

  async function processOneHistoryJob(job) {
    try {
      return await processClaimedHistoryJob(job);
    } catch (err) {
      logger.error(
        "Failed to import WhatsApp coexistence history job " + job.id + ":",
        err
      );
      try {
        await historyJobs.markFailed(job.id, job.lease_token, err);
        wakeHistoryRecovery(HISTORY_RECOVERY_INTERVAL_MS);
      } catch (markErr) {
        logger.error(
          "Failed to mark coexistence history job " + job.id + " retryable:",
          markErr
        );
        wakeHistoryRecovery(
          HISTORY_STALE_AFTER_SECONDS * 1000 + HISTORY_STALE_RECHECK_GRACE_MS
        );
      }
      return null;
    }
  }

  async function processStoredHistoryJob(storedJob) {
    if (!storedJob?.id) return null;
    const claimed = await historyJobs.claimById(storedJob.id);
    if (!claimed) return null;
    return processOneHistoryJob(claimed);
  }

  async function surfaceExhaustedHistoryJobs() {
    const exhausted = await historyJobs.listExhausted({
      limit: HISTORY_BATCH_SIZE,
      staleAfterSeconds: HISTORY_STALE_AFTER_SECONDS,
      maxAttempts: HISTORY_MAX_ATTEMPTS,
    });
    for (const job of exhausted) {
      const terminal = await historyJobs.markTerminal(job.id);
      if (!terminal) continue;
      logger.error(
        "WhatsApp coexistence history job " + job.id +
          " exhausted " + job.attempts +
          " attempts. The durable row was retained for diagnosis."
      );
    }
    return exhausted.length;
  }

  async function maybePruneCompletedHistory(now = Date.now()) {
    if (now - lastHistoryPrunedAt < HISTORY_PRUNE_INTERVAL_MS) return;
    lastHistoryPrunedAt = now;
    try {
      await historyJobs.pruneCompleted({
        olderThanHours: HISTORY_COMPLETED_RETENTION_HOURS,
      });
    } catch (err) {
      logger.error(
        "Failed to prune completed WhatsApp coexistence history jobs:",
        err
      );
    }
  }

  async function runHistoryRecovery() {
    if (historyRecoveryRunning) return { workCount: 0 };
    historyRecoveryRunning = true;
    try {
      const claimed = await historyJobs.claimRecoverable({
        limit: HISTORY_BATCH_SIZE,
        staleAfterSeconds: HISTORY_STALE_AFTER_SECONDS,
        maxAttempts: HISTORY_MAX_ATTEMPTS,
      });
      for (const job of claimed) {
        await processOneHistoryJob(job);
      }
      const exhaustedCount = await surfaceExhaustedHistoryJobs();
      await maybePruneCompletedHistory();
      return { workCount: claimed.length + exhaustedCount };
    } catch (err) {
      logger.error("WhatsApp coexistence history recovery sweep failed:", err);
      throw err;
    } finally {
      historyRecoveryRunning = false;
    }
  }

  function historyRecoveryDelayForResult(result, { runCount }) {
    if (Number(result?.workCount) > 0) return HISTORY_RECOVERY_INTERVAL_MS;
    if (runCount === 1) {
      return (
        HISTORY_STALE_AFTER_SECONDS * 1000 +
        HISTORY_STALE_RECHECK_GRACE_MS
      );
    }
    return HISTORY_IDLE_RECOVERY_INTERVAL_MS;
  }

  function startHistoryRecovery() {
    if (historyRecoveryTimer && !historyRecoveryTimer.state().stopped) {
      return () => historyRecoveryTimer.stop();
    }
    historyRecoveryTimer = createAdaptiveWorkerTimer({
      run: runHistoryRecovery,
      delayForResult: historyRecoveryDelayForResult,
      errorRetryDelayMs: HISTORY_RECOVERY_INTERVAL_MS,
      logger,
      label: "WhatsApp coexistence history recovery",
    });
    return historyRecoveryTimer.start();
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
    processClaimedHistoryJob,
    processStoredHistoryJob,
    runHistoryRecovery,
    startHistoryRecovery,
    storeHistory,
    storeHistoryJob,
    storeStaffEcho,
    wakeHistoryRecovery,
  };
}

const service = createWhatsAppCoexistenceService();

module.exports = {
  HISTORY_BATCH_SIZE,
  HISTORY_COMPLETED_RETENTION_HOURS,
  HISTORY_IDLE_RECOVERY_INTERVAL_MS,
  HISTORY_MAX_ATTEMPTS,
  HISTORY_RECOVERY_INTERVAL_MS,
  HISTORY_STALE_AFTER_SECONDS,
  WHATSAPP_BUSINESS_APP_ACTOR,
  createWhatsAppCoexistenceService,
  acceptStateSync: service.acceptStateSync,
  hydrateStaffEchoMedia: service.hydrateStaffEchoMedia,
  processStoredHistoryJob: service.processStoredHistoryJob,
  runHistoryRecovery: service.runHistoryRecovery,
  startHistoryRecovery: service.startHistoryRecovery,
  storeHistory: service.storeHistory,
  storeHistoryJob: service.storeHistoryJob,
  storeStaffEcho: service.storeStaffEcho,
};
