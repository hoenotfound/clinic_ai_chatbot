const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const messagesRepo = require("../src/db/messagesRepo");
const followUpRepo = require("../src/db/followUpRepo");
const contactsRepo = require("../src/db/contactsRepo");
const pipelineRepo = require("../src/db/pipelineRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const whatsapp = require("../src/services/whatsappService");
const {
  STALE_CLAIM_GRACE_MINUTES,
  runAutomatedFollowUps,
} = require("../src/services/followUpService");

test.beforeEach(() => {
  followUpRepo.markStaleClaimsUnconfirmed = async () => [];
  pipelineRepo.markContactedForContact = async () => false;
});

function enableTool() {
  clinicConfig.automatedFollowUp = {
    enabled: true,
    delayMinutes: 120,
    triggerMode: "all",
    message: "Checking in",
    translations: {
      en: "Checking in",
      ms: "Hai, masih perlukan bantuan?",
      zh: "您好，请问还需要帮助吗？",
    },
    imageUrl: "",
    activatedAt: "2026-08-27T00:00:00.000Z",
  };
}

test("sends and records one claimed automated follow-up", async () => {
  enableTool();
  const published = [];
  let sendCount = 0;
  let contacted = null;

  followUpRepo.findCandidates = async () => [
    { contact_id: 7, whatsapp_number: "60123456789", trigger_message_id: 40 },
  ];
  followUpRepo.saveIfStillEligible = async () => ({
    id: 41,
    contact_id: 7,
    delivery_status: null,
  });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 7,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  whatsapp.sendMessage = async (number, message) => {
    sendCount += 1;
    assert.equal(number, "60123456789");
    assert.equal(message, "Checking in");
    return { success: true, wamid: "wamid-41" };
  };
  pipelineRepo.markContactedForContact = async (contactId, actor) => {
    contacted = { contactId, actor };
    return true;
  };
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  await runAutomatedFollowUps();

  assert.equal(sendCount, 1);
  assert.equal(published.length, 2);
  assert.equal(published[0].payload.reason, "message");
  assert.equal(published[1].payload.deliveryStatus, "pending");
  assert.deepEqual(contacted, { contactId: 7, actor: "Automated follow-up" });
});

test("uses the saved Bahasa Malaysia version for a Malay customer chat", async () => {
  enableTool();
  let claimedContent = null;
  let sentMessage = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 13,
      whatsapp_number: "60133333333",
      trigger_message_id: 70,
      recent_inbound_messages: ["ok", "Saya nak tanya berapa harga rawatan ini"],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimedContent = input.content;
    return { id: 71, contact_id: 13, delivery_status: null };
  };
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-71" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 13,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimedContent, "Hai, masih perlukan bantuan?");
  assert.deepEqual(sentMessage, {
    number: "60133333333",
    message: "Hai, masih perlukan bantuan?",
  });
});

test("uses the outgoing reply as a language signal when customer text is unclear", async () => {
  enableTool();
  let sentMessage = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 14,
      whatsapp_number: "60144444444",
      trigger_message_id: 72,
      recent_inbound_messages: ["Sungguh berbaloi ke?"],
      trigger_message_content: "Ya, rawatan ini sesuai untuk anda.",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => ({
    id: 73,
    contact_id: 14,
    content: input.content,
    delivery_status: null,
  });
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-73" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 14,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(sentMessage, {
    number: "60144444444",
    message: "Hai, masih perlukan bantuan?",
  });
});

test("does not send when the database no longer considers the trigger eligible", async () => {
  enableTool();
  let sendCount = 0;

  followUpRepo.findCandidates = async () => [
    { contact_id: 7, whatsapp_number: "60123456789", trigger_message_id: 40 },
  ];
  followUpRepo.saveIfStillEligible = async () => null;
  whatsapp.sendMessage = async () => {
    sendCount += 1;
    return { success: true, wamid: "unexpected" };
  };

  await runAutomatedFollowUps();

  assert.equal(sendCount, 0);
});

test("sends an optional graphic with the customer's language version as its caption", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.imageUrl = "https://example.com/promo.jpg";
  let sentImage = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 8,
      whatsapp_number: "60122222222",
      trigger_message_id: 45,
      recent_inbound_messages: ["请问这个疗程多少钱？"],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    assert.equal(input.mediaUrl, "https://example.com/promo.jpg");
    assert.equal(input.content, "您好，请问还需要帮助吗？");
    return { id: 46, contact_id: 8, delivery_status: null };
  };
  whatsapp.sendImage = async (number, imageUrl, caption) => {
    sentImage = { number, imageUrl, caption };
    return { success: true, wamid: "wamid-46" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 8,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(sentImage, {
    number: "60122222222",
    imageUrl: "https://example.com/promo.jpg",
    caption: "您好，请问还需要帮助吗？",
  });
});

test("marks a rejected follow-up as failed and needing attention", async () => {
  enableTool();
  let failedStatus = null;
  let attentionContactId = null;

  followUpRepo.findCandidates = async () => [
    { contact_id: 9, whatsapp_number: "60111111111", trigger_message_id: 50 },
  ];
  followUpRepo.saveIfStillEligible = async () => ({
    id: 51,
    contact_id: 9,
    delivery_status: null,
  });
  messagesRepo.setDeliveryStatusById = async (id, status, error) => {
    failedStatus = { id, status, error };
    return { id, contact_id: 9, delivery_status: status, delivery_error: error };
  };
  contactsRepo.setDeliveryAttention = async (contactId) => {
    attentionContactId = contactId;
  };
  whatsapp.sendMessage = async () => ({ success: false, wamid: null });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(failedStatus.id, 51);
  assert.equal(failedStatus.status, "failed");
  assert.match(failedStatus.error, /automated follow-up/i);
  assert.equal(attentionContactId, 9);
});

test("does not query conversations while the tool is disabled", async () => {
  clinicConfig.automatedFollowUp = {
    ...clinicConfig.automatedFollowUp,
    enabled: false,
    activatedAt: null,
  };
  let queryCount = 0;
  followUpRepo.findCandidates = async () => {
    queryCount += 1;
    return [];
  };

  await runAutomatedFollowUps();

  assert.equal(queryCount, 0);
});

test("recovers an interrupted follow-up even while the tool is disabled", async () => {
  clinicConfig.automatedFollowUp = {
    ...clinicConfig.automatedFollowUp,
    enabled: false,
    activatedAt: null,
  };
  const published = [];
  let recoveryInput = null;
  let attention = null;
  let candidateQueries = 0;

  followUpRepo.markStaleClaimsUnconfirmed = async (input) => {
    recoveryInput = input;
    return [
      {
        id: 61,
        contact_id: 12,
        whatsapp_message_id: null,
        delivery_status: "unknown",
        delivery_error: "Check WhatsApp before retrying.",
      },
    ];
  };
  followUpRepo.findCandidates = async () => {
    candidateQueries += 1;
    return [];
  };
  contactsRepo.setDeliveryAttention = async (contactId, reason) => {
    attention = { contactId, reason };
  };
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  await runAutomatedFollowUps();

  assert.deepEqual(recoveryInput, {
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
    limit: 25,
  });
  assert.equal(candidateQueries, 0);
  assert.deepEqual(attention, {
    contactId: 12,
    reason: "Delivery unconfirmed: Check WhatsApp before retrying.",
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.deliveryStatus, "unknown");
  assert.equal(published[0].payload.reason, "delivery_status");
});
