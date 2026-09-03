const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const messagesRepo = require("../src/db/messagesRepo");
const pipelineRepo = require("../src/db/pipelineRepo");
const scheduledRepo = require("../src/db/scheduledMessageRepo");
const conversationStore = require("../src/utils/conversationStore");
const realtimeEvents = require("../src/utils/realtimeEvents");
const channelMessaging = require("../src/services/channelMessagingService");
const { runScheduledMessages } = require("../src/services/scheduledMessageService");

test.beforeEach(() => {
  scheduledRepo.recoverStaleProcessing = async () => [];
  scheduledRepo.claimDue = async () => [];
  scheduledRepo.getLatestInboundAt = async () => new Date();
  scheduledRepo.attachMessage = async () => null;
  scheduledRepo.markSent = async () => null;
  scheduledRepo.markFailed = async () => null;
  scheduledRepo.markExpired = async () => null;

  contactsRepo.getContactById = async () => null;
  contactsRepo.setAttention = async () => null;
  contactsRepo.setUnread = async () => null;
  contactsRepo.setDeliveryAttention = async () => null;

  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 1,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  messagesRepo.setDeliveryStatusById = async (id, status, error) => ({
    id,
    contact_id: 1,
    delivery_status: status,
    delivery_error: error,
  });

  pipelineRepo.markContactedForContact = async () => false;
  conversationStore.appendMessageForContact = async () => ({
    id: 101,
    contact_id: 1,
    delivery_status: null,
  });
  channelMessaging.sendText = async () => ({ success: true, wamid: "wamid-101" });
  channelMessaging.rejectedError = () => "Message was rejected.";
  realtimeEvents.publish = () => {};
});

test("does not send a scheduled staff message after the conversation returns to AI", async () => {
  let failedReason = null;
  let sendCount = 0;

  scheduledRepo.claimDue = async () => [
    { id: 10, contact_id: 1, content: "Follow up", scheduled_by_username: "caden" },
  ];
  contactsRepo.getContactById = async () => ({ id: 1, channel: "whatsapp", mode: "ai" });
  scheduledRepo.markFailed = async (id, reason) => {
    failedReason = { id, reason };
  };
  channelMessaging.sendText = async () => {
    sendCount += 1;
    return { success: true, wamid: "unexpected" };
  };

  await runScheduledMessages();

  assert.equal(sendCount, 0);
  assert.equal(failedReason.id, 10);
  assert.match(failedReason.reason, /no longer in Staff mode/i);
});

test("keeps accepted Facebook scheduled sends on the existing neutral delivery status path", async () => {
  let deliveryUpdate = null;
  let markedSent = false;
  let contacted = null;

  scheduledRepo.claimDue = async () => [
    { id: 11, contact_id: 1, content: "See you later", scheduled_by_username: "staff1" },
  ];
  contactsRepo.getContactById = async () => ({ id: 1, channel: "facebook", mode: "human" });
  channelMessaging.sendText = async () => ({ success: true, wamid: null });
  messagesRepo.setDeliveryStatusById = async (id, status, error) => {
    deliveryUpdate = { id, status, error };
    return { id, contact_id: 1, delivery_status: status, delivery_error: error };
  };
  scheduledRepo.markSent = async () => {
    markedSent = true;
  };
  pipelineRepo.markContactedForContact = async (contactId, actor) => {
    contacted = { contactId, actor };
    return true;
  };

  await runScheduledMessages();

  assert.deepEqual(deliveryUpdate, { id: 101, status: null, error: null });
  assert.equal(markedSent, true);
  assert.deepEqual(contacted, { contactId: 1, actor: "staff1" });
});

test("expires a due message without saving or sending it when the 24-hour window has closed", async () => {
  let expired = null;
  let appendCount = 0;
  let sendCount = 0;

  scheduledRepo.claimDue = async () => [
    { id: 12, contact_id: 1, content: "Too late", scheduled_by_username: "staff1" },
  ];
  contactsRepo.getContactById = async () => ({ id: 1, channel: "whatsapp", mode: "human" });
  scheduledRepo.getLatestInboundAt = async () => new Date(Date.now() - 25 * 60 * 60 * 1000);
  scheduledRepo.markExpired = async (id, reason) => {
    expired = { id, reason };
  };
  conversationStore.appendMessageForContact = async () => {
    appendCount += 1;
    return { id: 102, contact_id: 1 };
  };
  channelMessaging.sendText = async () => {
    sendCount += 1;
    return { success: true, wamid: "unexpected" };
  };

  await runScheduledMessages();

  assert.equal(appendCount, 0);
  assert.equal(sendCount, 0);
  assert.equal(expired.id, 12);
  assert.match(expired.reason, /reply window closed/i);
});

test("uses the existing WhatsApp WAMID delivery pipeline for a successful scheduled send", async () => {
  let wamidUpdate = null;
  let neutralUpdateCount = 0;

  scheduledRepo.claimDue = async () => [
    { id: 13, contact_id: 1, content: "WhatsApp later", scheduled_by_username: "staff1" },
  ];
  contactsRepo.getContactById = async () => ({ id: 1, channel: "whatsapp", mode: "human" });
  channelMessaging.sendText = async () => ({ success: true, wamid: "wamid-scheduled-13" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => {
    wamidUpdate = { id, wamid };
    return { id, contact_id: 1, whatsapp_message_id: wamid, delivery_status: "pending" };
  };
  messagesRepo.setDeliveryStatusById = async () => {
    neutralUpdateCount += 1;
    return null;
  };

  await runScheduledMessages();

  assert.deepEqual(wamidUpdate, { id: 101, wamid: "wamid-scheduled-13" });
  assert.equal(neutralUpdateCount, 0);
});
