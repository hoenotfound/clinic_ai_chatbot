const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const scheduledRepo = require("../db/scheduledMessageRepo");
const conversationStore = require("../utils/conversationStore");
const realtimeEvents = require("../utils/realtimeEvents");
const channelMessaging = require("./channelMessagingService");
const { validateScheduledTime, getServiceWindowEndsAt } = require("./scheduledMessageRules");

const CHECK_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 25;
let sweepRunning = false;

function publishConversationChange(message, reason = "message") {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason,
  });
}

function publishScheduleChange(contactId) {
  realtimeEvents.publish("conversation_changed", {
    contactId,
    reason: "scheduled_message",
  });
}

async function processScheduledMessage(item) {
  const contact = await contactsRepo.getContactById(item.contact_id);
  if (!contact) {
    await scheduledRepo.markFailed(item.id, "Contact no longer exists.");
    return;
  }

  const latestInboundAt = await scheduledRepo.getLatestInboundAt(contact.id);
  const windowEndsAt = getServiceWindowEndsAt(latestInboundAt);
  if (!latestInboundAt || !windowEndsAt || Date.now() >= windowEndsAt.getTime()) {
    await scheduledRepo.markExpired(
      item.id,
      "The customer-service reply window closed before this scheduled message could be sent."
    );
    await contactsRepo.setDeliveryAttention(
      contact.id,
      "A scheduled message expired because the customer-service reply window closed."
    );
    publishScheduleChange(contact.id);
    return;
  }

  const saved = await conversationStore.appendMessageForContact(
    contact.id,
    "assistant",
    item.content,
    null,
    item.scheduled_by_username || "Scheduled message"
  );
  await scheduledRepo.attachMessage(item.id, saved.id);
  publishConversationChange(saved, "message");

  let sendResult;
  try {
    sendResult = await channelMessaging.sendText(contact, item.content);
  } catch (err) {
    console.error(`Scheduled message ${item.id} send failed:`, err);
    sendResult = { success: false, wamid: null, error: err?.message || "Send failed." };
  }

  const errorText = sendResult.error || channelMessaging.rejectedError(contact.channel);
  let finalMessage = saved;
  if (sendResult.wamid) {
    finalMessage = (await messagesRepo.setWhatsappMessageId(saved.id, sendResult.wamid)) || saved;
  } else if (!sendResult.success) {
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(saved.id, "failed", errorText)) || saved;
  } else {
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(saved.id, "sent", null)) || saved;
  }
  publishConversationChange(finalMessage, "delivery_status");

  if (!sendResult.success) {
    await scheduledRepo.markFailed(item.id, errorText);
    await contactsRepo.setDeliveryAttention(contact.id, `Delivery failed: ${errorText}`);
    publishScheduleChange(contact.id);
    return;
  }

  await scheduledRepo.markSent(item.id);
  try {
    await pipelineRepo.markContactedForContact(
      contact.id,
      item.scheduled_by_username || "Scheduled message"
    );
  } catch (err) {
    console.error(`Failed to mark scheduled-message contact ${contact.id} as contacted:`, err);
  }
  publishScheduleChange(contact.id);
}

async function runScheduledMessages() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const recovered = await scheduledRepo.recoverStaleProcessing();
    for (const item of recovered) {
      if (item.message_id) {
        const message = await messagesRepo.setDeliveryStatusById(
          item.message_id,
          "unknown",
          item.failure_reason
        );
        publishConversationChange(message, "delivery_status");
      }
      await contactsRepo.setDeliveryAttention(item.contact_id, item.failure_reason);
      publishScheduleChange(item.contact_id);
    }

    const due = await scheduledRepo.claimDue(BATCH_SIZE);
    for (const item of due) {
      try {
        await processScheduledMessage(item);
      } catch (err) {
        console.error(`Failed to process scheduled message ${item.id}:`, err);
        await scheduledRepo.markFailed(item.id, "Unexpected scheduler error. Review before retrying.");
        await contactsRepo.setDeliveryAttention(
          item.contact_id,
          "A scheduled message failed unexpectedly and needs review."
        ).catch(() => {});
        publishScheduleChange(item.contact_id);
      }
    }
  } catch (err) {
    console.error("Scheduled-message sweep failed:", err);
  } finally {
    sweepRunning = false;
  }
}

function startScheduledMessages() {
  runScheduledMessages();
  const timer = setInterval(runScheduledMessages, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function scheduleValidation({ scheduledFor, lastInboundAt, now = new Date() }) {
  return validateScheduledTime({ scheduledFor, lastInboundAt, now });
}

module.exports = {
  CHECK_INTERVAL_MS,
  runScheduledMessages,
  startScheduledMessages,
  scheduleValidation,
};
