const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const messagesRepo = require("../src/db/messagesRepo");
const followUpRepo = require("../src/db/followUpRepo");
const contactsRepo = require("../src/db/contactsRepo");
const pipelineRepo = require("../src/db/pipelineRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const channelMessaging = require("../src/services/channelMessagingService");
const { runAutomatedFollowUps } = require("../src/services/followUpService");

const originals = {
  findCandidates: followUpRepo.findCandidates,
  saveIfStillEligible: followUpRepo.saveIfStillEligible,
  markStaleClaimsUnconfirmed: followUpRepo.markStaleClaimsUnconfirmed,
  setWhatsappMessageId: messagesRepo.setWhatsappMessageId,
  setDeliveryStatusById: messagesRepo.setDeliveryStatusById,
  setDeliveryAttention: contactsRepo.setDeliveryAttention,
  markContactedForContact: pipelineRepo.markContactedForContact,
  publish: realtimeEvents.publish,
  sendText: channelMessaging.sendText,
  sendImageByUrl: channelMessaging.sendImageByUrl,
};

test.after(() => {
  Object.assign(followUpRepo, {
    findCandidates: originals.findCandidates,
    saveIfStillEligible: originals.saveIfStillEligible,
    markStaleClaimsUnconfirmed: originals.markStaleClaimsUnconfirmed,
  });
  Object.assign(messagesRepo, {
    setWhatsappMessageId: originals.setWhatsappMessageId,
    setDeliveryStatusById: originals.setDeliveryStatusById,
  });
  contactsRepo.setDeliveryAttention = originals.setDeliveryAttention;
  pipelineRepo.markContactedForContact = originals.markContactedForContact;
  realtimeEvents.publish = originals.publish;
  channelMessaging.sendText = originals.sendText;
  channelMessaging.sendImageByUrl = originals.sendImageByUrl;
});

function enableTool({ imageUrl = "" } = {}) {
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
    imageUrl,
    activatedAt: "2026-08-27T00:00:00.000Z",
  };
}

test.beforeEach(() => {
  enableTool();
  followUpRepo.markStaleClaimsUnconfirmed = async () => [];
  contactsRepo.setDeliveryAttention = async () => {};
  pipelineRepo.markContactedForContact = async () => false;
  realtimeEvents.publish = () => {};
  messagesRepo.setWhatsappMessageId = async () => {
    throw new Error("A social follow-up must not enter the WhatsApp WAMID pipeline.");
  };
});

test("Facebook Messenger follow-up uses the scoped recipient and records an accepted social send", async () => {
  let sent = null;
  let persisted = null;
  let contacted = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 101,
      channel: "facebook",
      whatsapp_number: "+facebook:101",
      channel_user_id: "psid-101",
      trigger_message_id: 500,
      recent_inbound_messages: ["Hi, how much is HIFU?"],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => ({
    id: 501,
    contact_id: 101,
    content: input.content,
    delivery_status: null,
  });
  channelMessaging.sendText = async (contact, text) => {
    sent = { contact, text };
    return { success: true, wamid: null, externalMessageId: "mid-facebook-501" };
  };
  messagesRepo.setDeliveryStatusById = async (id, status, error) => {
    persisted = { id, status, error };
    return { id, contact_id: 101, delivery_status: status, delivery_error: error };
  };
  pipelineRepo.markContactedForContact = async (contactId, actor) => {
    contacted = { contactId, actor };
    return true;
  };

  await runAutomatedFollowUps();

  assert.deepEqual(sent, {
    contact: {
      channel: "facebook",
      whatsapp_number: "+facebook:101",
      channel_user_id: "psid-101",
    },
    text: "Checking in",
  });
  assert.deepEqual(persisted, { id: 501, status: "sent", error: null });
  assert.deepEqual(contacted, { contactId: 101, actor: "Automated follow-up" });
});

test("Instagram follow-up sends the configured graphic and localized caption", async () => {
  enableTool({ imageUrl: "https://example.com/follow-up.jpg" });
  let claimed = null;
  let sent = null;
  let persisted = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 102,
      channel: "instagram",
      whatsapp_number: "+instagram:102",
      channel_user_id: "igsid-102",
      trigger_message_id: 510,
      recent_inbound_messages: ["请问这个疗程多少钱？"],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimed = input;
    return { id: 511, contact_id: 102, delivery_status: null };
  };
  channelMessaging.sendImageByUrl = async (contact, imageUrl, caption) => {
    sent = { contact, imageUrl, caption };
    return { success: true, wamid: null, externalMessageId: "mid-instagram-511" };
  };
  messagesRepo.setDeliveryStatusById = async (id, status, error) => {
    persisted = { id, status, error };
    return { id, contact_id: 102, delivery_status: status, delivery_error: error };
  };

  await runAutomatedFollowUps();

  assert.equal(claimed.content, "您好，请问还需要帮助吗？");
  assert.equal(claimed.mediaUrl, "https://example.com/follow-up.jpg");
  assert.deepEqual(sent, {
    contact: {
      channel: "instagram",
      whatsapp_number: "+instagram:102",
      channel_user_id: "igsid-102",
    },
    imageUrl: "https://example.com/follow-up.jpg",
    caption: "您好，请问还需要帮助吗？",
  });
  assert.deepEqual(persisted, { id: 511, status: "sent", error: null });
});

test("social follow-up rejection is failed with the correct channel name and human attention", async () => {
  let persisted = null;
  let attention = null;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 103,
      channel: "instagram",
      whatsapp_number: "+instagram:103",
      channel_user_id: "igsid-103",
      trigger_message_id: 520,
    },
  ];
  followUpRepo.saveIfStillEligible = async () => ({
    id: 521,
    contact_id: 103,
    delivery_status: null,
  });
  channelMessaging.sendText = async () => ({
    success: false,
    wamid: null,
    externalMessageId: null,
    error: "Outside messaging window",
  });
  messagesRepo.setDeliveryStatusById = async (id, status, error) => {
    persisted = { id, status, error };
    return { id, contact_id: 103, delivery_status: status, delivery_error: error };
  };
  contactsRepo.setDeliveryAttention = async (contactId, reason) => {
    attention = { contactId, reason };
  };

  await runAutomatedFollowUps();

  assert.equal(persisted.id, 521);
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /Instagram did not accept this automated follow-up/);
  assert.equal(attention.contactId, 103);
  assert.match(attention.reason, /Instagram did not accept this automated follow-up/);
});
