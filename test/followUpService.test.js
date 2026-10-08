const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clinicConfig = require("../src/config/clinicConfig");
const messagesRepo = require("../src/db/messagesRepo");
const followUpRepo = require("../src/db/followUpRepo");
const followUpAiLeaseRepo = require("../src/db/followUpAiLeaseRepo");
const contactsRepo = require("../src/db/contactsRepo");
const pipelineRepo = require("../src/db/pipelineRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const whatsapp = require("../src/services/whatsappService");
const channelMessaging = require("../src/services/channelMessagingService");
const mediaStorage = require("../src/services/mediaStorageService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");
const followUpAiService = require("../src/services/followUpAiService");
const {
  STALE_CLAIM_GRACE_MINUTES,
  runAutomatedFollowUps,
} = require("../src/services/followUpService");

const originalPolicyCheck = whatsappPolicy.checkFreeformAllowed;
const originalWhatsappSendImage = whatsapp.sendImage;
const originalSendVideoByStoredKey = channelMessaging.sendVideoByStoredKey;
const originalCopyStoredMediaToMessage = mediaStorage.copyStoredMediaToMessage;
const originalDeleteMedia = mediaStorage.deleteMedia;
const originalGeneratePersonalizedFollowUp =
  followUpAiService.generatePersonalizedFollowUp;
const originalSelectPromotionPackageForFollowUp =
  followUpAiService.selectPromotionPackageForFollowUp;

test.beforeEach(() => {
  whatsapp.sendImage = originalWhatsappSendImage;
  channelMessaging.sendVideoByStoredKey = originalSendVideoByStoredKey;
  mediaStorage.copyStoredMediaToMessage = originalCopyStoredMediaToMessage;
  mediaStorage.deleteMedia = originalDeleteMedia;
  followUpAiService.generatePersonalizedFollowUp =
    originalGeneratePersonalizedFollowUp;
  followUpAiService.selectPromotionPackageForFollowUp =
    originalSelectPromotionPackageForFollowUp;
  followUpRepo.markStaleClaimsUnconfirmed = async () => [];
  followUpRepo.getNextCandidateDueAt = async () => null;
  followUpRepo.getNextStaleClaimDueAt = async () => null;
  followUpRepo.isClaimStillEligible = async () => true;
  followUpRepo.discardUnsentClaim = async () => null;
  followUpRepo.discardUnsentSocialImageCompanion = async () => null;
  followUpRepo.saveSocialVideoCompanion = async () => null;
  followUpRepo.discardUnsentSocialVideoCompanion = async () => null;
  followUpRepo.getAiFollowUpContext = async () => ({ messages: [], lead: null });
  followUpRepo.recordAiDecisionIfStillEligible = async () => null;
  followUpAiLeaseRepo.claimIfStillEligible = async (input) => ({ id: 1, ...input });
  followUpAiLeaseRepo.release = async () => ({ id: 1 });
  pipelineRepo.markContactedForContact = async () => false;
  // These tests exercise follow-up timing/language/delivery behavior, not the
  // policy service's database lookup. Policy behavior has dedicated tests.
  whatsappPolicy.checkFreeformAllowed = async () => ({ allowed: true });
});

test.after(() => {
  whatsappPolicy.checkFreeformAllowed = originalPolicyCheck;
});

function enableTool() {
  clinicConfig.services = [
    { name: "Pelvic Care" },
    { name: "Uterus Care" },
    { name: "3D 小颜术" },
  ];
  clinicConfig.serviceAliases = [];
  clinicConfig.promotions = [];
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
    quietHours: {
      enabled: false,
      start: "00:00",
      end: "07:00",
    },
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


test("targeted message falls back to the general video when the service has no media", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.videoKey =
    "clients/neutro/messages/follow-up-config/general.mp4";
  clinicConfig.automatedFollowUp.videoFilename = "general.mp4";
  clinicConfig.automatedFollowUp.serviceOverrides = [
    {
      serviceName: "Pelvic Care",
      message: "Pelvic Care follow-up",
      translations: {
        en: "Pelvic Care follow-up",
        ms: "Susulan Pelvic Care",
        zh: "骨盆调理跟进",
      },
      imageUrl: "",
      videoKey: "",
      videoFilename: "",
    },
  ];

  let claimInput = null;
  let videoSend = null;
  mediaStorage.copyStoredMediaToMessage = async (key, mimeType, options) => {
    assert.equal(
      key,
      "clients/neutro/messages/follow-up-config/general.mp4"
    );
    assert.equal(mimeType, "video/mp4");
    assert.deepEqual(options, { contactId: 81 });
    return "clients/neutro/messages/81/general.mp4";
  };
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 81,
      channel: "whatsapp",
      whatsapp_number: "60120000081",
      trigger_message_id: 80,
      next_follow_up_step: 1,
      recent_inbound_messages: ["I want Pelvic Care"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "Here are the Pelvic Care details",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 82, contact_id: 81, delivery_status: null };
  };
  channelMessaging.sendVideoByStoredKey = async (
    contact,
    key,
    caption,
    filename
  ) => {
    videoSend = { contact, key, caption, filename };
    return { success: true, wamid: "wamid-general-video-82" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 81,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "Pelvic Care follow-up");
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.mediaKey, "clients/neutro/messages/81/general.mp4");
  assert.equal(claimInput.mediaMimeType, "video/mp4");
  assert.equal(claimInput.mediaUrl, null);
  assert.deepEqual(videoSend, {
    contact: {
      id: 81,
      channel: "whatsapp",
      whatsapp_number: "60120000081",
      channel_user_id: undefined,
    },
    key: "clients/neutro/messages/81/general.mp4",
    caption: "Pelvic Care follow-up",
    filename: "general.mp4",
  });
});

test("service image overrides a general video for the matched service", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.videoKey =
    "clients/neutro/messages/follow-up-config/general.mp4";
  clinicConfig.automatedFollowUp.videoFilename = "general.mp4";
  clinicConfig.automatedFollowUp.serviceOverrides = [
    {
      serviceName: "Pelvic Care",
      message: "See this Pelvic Care result.",
      translations: {
        en: "See this Pelvic Care result.",
        ms: "Lihat hasil Pelvic Care ini.",
        zh: "看看这个骨盆调理案例。",
      },
      imageUrl: "https://example.com/pelvic-care.jpg",
      videoKey: "",
      videoFilename: "",
    },
  ];

  let copyCalls = 0;
  let imageSend = null;
  let claimInput = null;
  mediaStorage.copyStoredMediaToMessage = async () => {
    copyCalls += 1;
    throw new Error("general video must not be copied when service image wins");
  };
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 83,
      channel: "whatsapp",
      whatsapp_number: "60120000083",
      trigger_message_id: 82,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care please"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "Pelvic Care details",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 84, contact_id: 83, delivery_status: null };
  };
  whatsapp.sendImage = async (number, imageUrl, caption) => {
    imageSend = { number, imageUrl, caption };
    return { success: true, wamid: "wamid-service-image-84" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 83,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(copyCalls, 0);
  assert.equal(claimInput.mediaKey, null);
  assert.equal(claimInput.mediaMimeType, null);
  assert.equal(claimInput.mediaUrl, "https://example.com/pelvic-care.jpg");
  assert.deepEqual(imageSend, {
    number: "60120000083",
    imageUrl: "https://example.com/pelvic-care.jpg",
    caption: "See this Pelvic Care result.",
  });
});

test("pre-expiry follow-up sends the video mapped to the customer's current service", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.delayMinutes = 1320;
  clinicConfig.automatedFollowUp.timingMode = "before_window_expiry";
  clinicConfig.automatedFollowUp.beforeWindowExpiryMinutes = 120;
  clinicConfig.automatedFollowUp.serviceOverrides = [
    {
      serviceName: "Pelvic Care",
      message: "Here is a short Pelvic Care video.",
      translations: {
        en: "Here is a short Pelvic Care video.",
        ms: "Ini video ringkas Pelvic Care.",
        zh: "给您看看骨盆调理的简短视频。",
      },
      videoKey: "clients/neutro/messages/follow-up-config/pelvis.mp4",
      videoFilename: "pelvis-care.mp4",
    },
  ];

  let candidateQuery = null;
  let claimInput = null;
  let videoSend = null;
  mediaStorage.copyStoredMediaToMessage = async (key, mimeType, options) => {
    assert.equal(key, "clients/neutro/messages/follow-up-config/pelvis.mp4");
    assert.equal(mimeType, "video/mp4");
    assert.deepEqual(options, { contactId: 77 });
    return "clients/neutro/messages/77/durable-pelvis.mp4";
  };
  followUpRepo.findCandidates = async (input) => {
    candidateQuery = input;
    return [
      {
        contact_id: 77,
        channel: "whatsapp",
        whatsapp_number: "60122223333",
        trigger_message_id: 76,
        next_follow_up_step: 1,
        recent_inbound_messages: ["I want to know more about Pelvic Care"],
        treatment_interest: "Pelvic Care",
        trigger_message_content: "Sure, here are the Pelvic Care details.",
      },
    ];
  };
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 78, contact_id: 77, delivery_status: null };
  };
  channelMessaging.sendVideoByStoredKey = async (
    contact,
    key,
    caption,
    filename
  ) => {
    videoSend = { contact, key, caption, filename };
    return { success: true, wamid: "wamid-video-78" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 77,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(candidateQuery.timingModes, ["before_window_expiry"]);
  assert.deepEqual(candidateQuery.beforeWindowExpiryMinutes, [120]);
  assert.deepEqual(candidateQuery.delayMinutes, [1320]);
  assert.equal(claimInput.timingMode, "before_window_expiry");
  assert.equal(claimInput.beforeWindowExpiryMinutes, 120);
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.mediaKey, "clients/neutro/messages/77/durable-pelvis.mp4");
  assert.equal(claimInput.mediaMimeType, "video/mp4");
  assert.deepEqual(videoSend, {
    contact: {
      id: 77,
      channel: "whatsapp",
      whatsapp_number: "60122223333",
      channel_user_id: undefined,
    },
    key: "clients/neutro/messages/77/durable-pelvis.mp4",
    caption: "Here is a short Pelvic Care video.",
    filename: "pelvis-care.mp4",
  });
});

test("first follow-up uses hidden active-promotion copy and does not let AI rewrite it", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "3D October offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      caption: "✨ 3D 小颜术 First Trial: RM488（Normal Price RM888）",
      followUpMessage: "🎁 Free 1-hour 全身通淋巴按摩 + 脸部提升刮痧",
      followUpImageUrl: "https://example.com/3d-follow-up.jpg",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Write a personalized follow-up.";
  clinicConfig.automatedFollowUp.imageUrl = "https://example.com/generic-follow-up.jpg";

  let aiCalls = 0;
  let imageCalls = 0;
  let sentPromotionImage = null;
  whatsapp.sendImage = async (number, imageUrl, caption) => {
    imageCalls += 1;
    sentPromotionImage = { number, imageUrl, caption };
    return { success: true, wamid: "wamid-702" };
  };
  let claimInput = null;
  followUpAiService.generatePersonalizedFollowUp = async () => {
    aiCalls += 1;
    return { action: "send", message: "AI changed the offer" };
  };
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 701,
      whatsapp_number: "60111111111",
      trigger_message_id: 700,
      next_follow_up_step: 1,
      recent_inbound_messages: ["3D 小颜术多少钱？"],
      trigger_message_content: "✨ 3D 小颜术 First Trial: RM488（Normal Price RM888）",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 702, contact_id: 701, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-702" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 701,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(aiCalls, 0);
  assert.equal(
    claimInput.content,
    "🎁 Free 1-hour 全身通淋巴按摩 + 脸部提升刮痧"
  );
  assert.equal(claimInput.targetedService, "3D 小颜术");
  assert.equal(claimInput.messageMode, "fixed");
  assert.equal(claimInput.mediaUrl, "https://example.com/3d-follow-up.jpg");
  assert.equal(imageCalls, 1);
  assert.deepEqual(sentPromotionImage, {
    number: "60111111111",
    imageUrl: "https://example.com/3d-follow-up.jpg",
    caption: "🎁 Free 1-hour 全身通淋巴按摩 + 脸部提升刮痧",
  });
});

test("promotion follow-up without its own graphic does not reuse the generic follow-up image", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "3D text-only delayed offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      caption: "",
      followUpMessage: "Text-only promotion follow-up",
      followUpImageUrl: "",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];
  clinicConfig.automatedFollowUp.imageUrl =
    "https://example.com/generic-follow-up.jpg";

  let claimInput = null;
  let imageCalls = 0;
  let sentText = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 703,
      whatsapp_number: "60111111113",
      trigger_message_id: 702,
      next_follow_up_step: 1,
      recent_inbound_messages: ["3D 小颜术多少钱？"],
      trigger_message_content: "3D 小颜术 First Trial RM488",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 704, contact_id: 703, delivery_status: null };
  };
  whatsapp.sendImage = async () => {
    imageCalls += 1;
    return { success: true, wamid: "unexpected-image" };
  };
  whatsapp.sendMessage = async (number, message) => {
    sentText = { number, message };
    return { success: true, wamid: "wamid-704" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 703,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "Text-only promotion follow-up");
  assert.equal(claimInput.mediaUrl, null);
  assert.equal(imageCalls, 0);
  assert.deepEqual(sentText, {
    number: "60111111113",
    message: "Text-only promotion follow-up",
  });
});

test("promotion follow-up ignores overlapping active promos that have no delayed follow-up copy", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "3D image promo",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: true,
      imageUrl: "https://example.com/3d.jpg",
      caption: "3D promo image",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
    {
      name: "3D delayed offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      imageUrl: "",
      caption: "",
      followUpMessage: "🎁 Free 1-hour 全身通淋巴按摩 + 脸部提升刮痧",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [{
    contact_id: 705,
    whatsapp_number: "60111111115",
    trigger_message_id: 704,
    next_follow_up_step: 1,
    recent_inbound_messages: ["3D 小颜术多少钱？"],
    trigger_message_content: "3D 小颜术 First Trial RM488",
  }];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 706, contact_id: 705, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-706" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 705,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(
    claimInput.content,
    "🎁 Free 1-hour 全身通淋巴按摩 + 脸部提升刮痧"
  );
});

test("promotion follow-up uses the configured customer-language version when available", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "3D localized offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      imageUrl: "",
      caption: "",
      followUpMessage: "Free lymphatic massage add-on",
      followUpTranslations: {
        en: "Free lymphatic massage add-on",
        zh: "🎁 免费1小时全身通淋巴按摩 + 脸部提升刮痧",
      },
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [{
    contact_id: 707,
    whatsapp_number: "60111111117",
    trigger_message_id: 708,
    next_follow_up_step: 1,
    recent_inbound_messages: ["3D 小颜术多少钱？"],
    trigger_message_content: "3D 小颜术体验价 RM488",
  }];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 709, contact_id: 707, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-709" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 707,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(
    claimInput.content,
    "🎁 免费1小时全身通淋巴按摩 + 脸部提升刮痧"
  );
});

test("first follow-up selects the exact configured package offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套", "RM388配套"],
          imageUrl: "",
          caption: "优惠价 RM488",
          followUpMessage: "10月限时优惠价 RM388",
          followUpImageUrl: "https://example.com/package-a-follow-up.jpg",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套", "RM288配套"],
          imageUrl: "",
          caption: "优惠价 RM388",
          followUpMessage: "10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  let claimInput = null;
  let sentPackageImage = null;
  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package B";
  };
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 711,
      whatsapp_number: "60122222222",
      trigger_message_id: 710,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care Package A price?"],
      trigger_message_content: "Package A 优惠价 RM488",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 712, contact_id: 711, delivery_status: null };
  };
  whatsapp.sendImage = async (number, imageUrl, caption) => {
    sentPackageImage = { number, imageUrl, caption };
    return { success: true, wamid: "wamid-712" };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-712" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 711,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "10月限时优惠价 RM388");
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.mediaUrl, "https://example.com/package-a-follow-up.jpg");
  assert.equal(selectorCalls, 0);
  assert.deepEqual(sentPackageImage, {
    number: "60122222222",
    imageUrl: "https://example.com/package-a-follow-up.jpg",
    caption: "10月限时优惠价 RM388",
  });
});

test("generic package price enquiry uses one AI-selected configured offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
          followUpImageUrl: "https://example.com/package-a-ai-selected.jpg",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
          followUpImageUrl: "https://example.com/package-b-ai-selected.jpg",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { role: "user", content: "骨盆调理有什么配套？" },
      { role: "assistant", content: "我们有 Package A 和 Package B。" },
      { role: "user", content: "我比较想要有经络按摩的" },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorInput = null;
  followUpAiService.selectPromotionPackageForFollowUp = async (input) => {
    selectorInput = input;
    return "Package A";
  };

  let claimInput = null;
  let sentSelectedPackageImage = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 721,
      whatsapp_number: "60133333334",
      trigger_message_id: 720,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care price?"],
      // The outbound anchor may be the last package caption. It must not decide
      // which hidden follow-up offer is sent.
      trigger_message_content: "Package B 优惠价 RM388，Includes Uterus Care",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 722, contact_id: 721, delivery_status: null };
  };
  whatsapp.sendImage = async (number, imageUrl, caption) => {
    sentSelectedPackageImage = { number, imageUrl, caption };
    return { success: true, wamid: "wamid-722" };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-722" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 721,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorInput.serviceName, "Pelvic Care");
  assert.equal(selectorInput.packages.length, 2);
  assert.equal(claimInput.content, "Package A｜10月限时优惠价 RM388");
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.messageMode, "fixed");
  assert.equal(
    claimInput.mediaUrl,
    "https://example.com/package-a-ai-selected.jpg"
  );
  assert.deepEqual(sentSelectedPackageImage, {
    number: "60133333334",
    imageUrl: "https://example.com/package-a-ai-selected.jpg",
    caption: "Package A｜10月限时优惠价 RM388",
  });
});

test("generic package price enquiry falls back to the normal first follow-up when AI cannot identify one package", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "A",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "B",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return null;
  };
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [{ role: "user", content: "Pelvic Care price?" }],
    lead: null,
  });

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 731,
      whatsapp_number: "60133333335",
      trigger_message_id: 730,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care price?"],
      trigger_message_content: "Package B 优惠价 RM388",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 732, contact_id: 731, delivery_status: null };
  };
  whatsapp.sendMessage = async (_number, message) => {
    assert.equal(message, "Checking in");
    return { success: true, wamid: "wamid-732" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 731,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 1);
  assert.equal(claimInput.content, "Checking in");
  assert.equal(claimInput.targetedService, null);
});

test("vague price enquiry prefers current CRM service over service words in the outbound package caption", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes Uterus Care",
          followUpMessage: "Package A hidden offer",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes Uterus Care",
          followUpMessage: "Package B hidden offer",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
    {
      name: "Uterus offer",
      linkedService: "Uterus Care",
      sendOnPriceQuery: false,
      caption: "Uterus Care promo",
      followUpMessage: "Wrong uterus follow-up",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [{ id: 790, role: "user", content: "price?" }],
    lead: { treatment_interest: "Pelvic Care" },
  });
  followUpAiService.selectPromotionPackageForFollowUp = async () => null;

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 790,
      whatsapp_number: "60133333342",
      trigger_message_id: 789,
      next_follow_up_step: 1,
      recent_inbound_messages: ["price?"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "Package B｜Includes Uterus Care",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 791, contact_id: 790, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-791" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 790,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "Checking in");
  assert.notEqual(claimInput.content, "Wrong uterus follow-up");
});

test("recent promotion enquiry for a different service does not unlock a hidden package offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes meridian massage",
          followUpMessage: "Package A hidden offer",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes uterus care",
          followUpMessage: "Package B hidden offer",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 820,
        role: "user",
        content: "3D 小颜术 price?",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 821,
        role: "assistant",
        content: "3D price reply",
        created_at: "2026-10-05T01:01:00.000Z",
      },
      {
        id: 822,
        role: "user",
        content: "我现在比较想要骨盆有经络按摩的",
        created_at: "2026-10-05T01:05:00.000Z",
      },
      {
        id: 823,
        role: "assistant",
        content: "Pelvic Care package reply",
        created_at: "2026-10-05T01:06:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 823,
      whatsapp_number: "60133333343",
      trigger_message_id: 823,
      next_follow_up_step: 1,
      recent_inbound_messages: ["我现在比较想要骨盆有经络按摩的"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "Pelvic Care package reply",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 824, contact_id: 823, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-824" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 823,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 0);
  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
});

test("single-package promotion remains locked for an ordinary non-price service chat", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "3D offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      caption: "3D trial",
      imageUrl: "",
      packages: [
        {
          name: "Main package",
          title: "3D trial",
          aliases: [],
          imageUrl: "",
          caption: "3D trial",
          followUpMessage: "Hidden 3D gift",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 795,
      whatsapp_number: "60133333339",
      trigger_message_id: 794,
      next_follow_up_step: 1,
      recent_inbound_messages: ["3D 小颜术会痛吗？"],
      trigger_message_content: "3D 小颜术是徒手调理，会先评估。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 796, contact_id: 795, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-796" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 795,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
  assert.notEqual(claimInput.content, "Hidden 3D gift");
});

test("package preference after an earlier price enquiry can still receive one relevant hidden offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 800,
        role: "user",
        content: "Pelvic Care price?",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 801,
        role: "assistant",
        content: "Package A and Package B",
        created_at: "2026-10-05T01:01:00.000Z",
      },
      {
        id: 802,
        role: "user",
        content: "我比较想要有经络按摩的",
        created_at: "2026-10-05T01:05:00.000Z",
      },
      {
        id: 803,
        role: "assistant",
        content: "Pelvic Care 的两个配套可以按你的需要比较。",
        created_at: "2026-10-05T01:06:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 803,
      whatsapp_number: "60133333340",
      trigger_message_id: 803,
      next_follow_up_step: 1,
      recent_inbound_messages: ["我比较想要有经络按摩的"],
      trigger_message_content: "Pelvic Care 的两个配套可以按你的需要比较。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 804, contact_id: 803, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-804" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 803,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 1);
  assert.equal(claimInput.content, "Package A｜10月限时优惠价 RM388");
  assert.equal(claimInput.targetedService, "Pelvic Care");
});

test("generic price question inherits the customer's earlier service context for a later package preference", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 830,
        role: "user",
        content: "Pelvic Care",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 831,
        role: "assistant",
        content: "Pelvic Care explanation",
        created_at: "2026-10-05T01:01:00.000Z",
      },
      {
        id: 832,
        role: "user",
        content: "多少钱？",
        created_at: "2026-10-05T01:05:00.000Z",
      },
      {
        id: 833,
        role: "assistant",
        content: "Package A and Package B",
        created_at: "2026-10-05T01:06:00.000Z",
      },
      {
        id: 834,
        role: "user",
        content: "我比较想要有经络按摩的",
        created_at: "2026-10-05T01:10:00.000Z",
      },
      {
        id: 835,
        role: "assistant",
        content: "可以按你的主要需求来比较。",
        created_at: "2026-10-05T01:11:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 835,
      whatsapp_number: "60133333345",
      trigger_message_id: 835,
      next_follow_up_step: 1,
      recent_inbound_messages: ["我比较想要有经络按摩的"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "可以按你的主要需求来比较。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 836, contact_id: 835, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-836" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 835,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 1);
  assert.equal(claimInput.content, "Package A｜10月限时优惠价 RM388");
  assert.equal(claimInput.targetedService, "Pelvic Care");
});

test("generic price question with no explicit customer service can use the current structured treatment context", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 840,
        role: "user",
        content: "多少钱？",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 841,
        role: "assistant",
        content: "Package A and Package B",
        created_at: "2026-10-05T01:01:00.000Z",
      },
      {
        id: 842,
        role: "user",
        content: "我想要有经络按摩的",
        created_at: "2026-10-05T01:05:00.000Z",
      },
      {
        id: 843,
        role: "assistant",
        content: "可以按你的主要需求来比较。",
        created_at: "2026-10-05T01:06:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 843,
      whatsapp_number: "60133333346",
      trigger_message_id: 843,
      next_follow_up_step: 1,
      recent_inbound_messages: ["我想要有经络按摩的"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "可以按你的主要需求来比较。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 844, contact_id: 843, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-844" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 843,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 1);
  assert.equal(claimInput.content, "Package A｜10月限时优惠价 RM388");
});

test("a later explicit service switch blocks a stale hidden package offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 850,
        role: "user",
        content: "Pelvic Care",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 851,
        role: "assistant",
        content: "Pelvic Care explanation",
        created_at: "2026-10-05T01:01:00.000Z",
      },
      {
        id: 852,
        role: "user",
        content: "多少钱？",
        created_at: "2026-10-05T01:05:00.000Z",
      },
      {
        id: 853,
        role: "assistant",
        content: "Package A and Package B",
        created_at: "2026-10-05T01:06:00.000Z",
      },
      {
        id: 854,
        role: "user",
        content: "其实我现在想问 3D 小颜术",
        created_at: "2026-10-05T01:10:00.000Z",
      },
      {
        id: 855,
        role: "assistant",
        content: "3D explanation",
        created_at: "2026-10-05T01:11:00.000Z",
      },
      {
        id: 856,
        role: "user",
        content: "我想要有经络按摩的",
        created_at: "2026-10-05T01:15:00.000Z",
      },
      {
        id: 857,
        role: "assistant",
        content: "可以继续了解。",
        created_at: "2026-10-05T01:16:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 857,
      whatsapp_number: "60133333347",
      trigger_message_id: 857,
      next_follow_up_step: 1,
      recent_inbound_messages: ["我想要有经络按摩的"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "可以继续了解。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 858, contact_id: 857, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-858" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 857,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 0);
  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
  assert.doesNotMatch(claimInput.content, /RM388|RM288/);
});

test("ordinary multi-package service chat without recent price or package intent does not unlock a hidden offer", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "Includes 经络穴位按摩",
          followUpMessage: "Package A｜10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "Includes 子宫护理",
          followUpMessage: "Package B｜10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      {
        id: 810,
        role: "user",
        content: "Pelvic Care 会痛吗？",
        created_at: "2026-10-05T01:00:00.000Z",
      },
      {
        id: 811,
        role: "assistant",
        content: "Pelvic Care 会先由中医师评估。",
        created_at: "2026-10-05T01:01:00.000Z",
      },
    ],
    lead: { treatment_interest: "Pelvic Care" },
  });

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 811,
      whatsapp_number: "60133333341",
      trigger_message_id: 811,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care 会痛吗？"],
      trigger_message_content: "Pelvic Care 会先由中医师评估。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 812, contact_id: 811, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-812" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 811,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 0);
  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
  assert.doesNotMatch(claimInput.content, /RM388|RM288/);
});

test("a comparison naming multiple packages does not send both hidden discounts", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "A",
          followUpMessage: "10月限时优惠价 RM388",
        },
        {
          name: "Package B",
          title: "",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "B",
          followUpMessage: "10月限时优惠价 RM288",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpAiService.selectPromotionPackageForFollowUp = async () => null;
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [{ role: "user", content: "Package A 跟 Package B 有什么分别？" }],
    lead: null,
  });

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 741,
      whatsapp_number: "60133333337",
      trigger_message_id: 740,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care Package A 跟 Package B price?"],
      trigger_message_content: "Package A 和 Package B 都有不同配套。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 742, contact_id: 741, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-742" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 741,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
  assert.doesNotMatch(claimInput.content, /RM388|RM288/);
});

test("ambiguous package aliases fail closed at runtime even if stale config bypassed Settings validation", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "",
          aliases: ["RM388配套"],
          imageUrl: "",
          caption: "A",
          followUpMessage: "A hidden offer",
        },
        {
          name: "Package B",
          title: "",
          aliases: ["RM388配套"],
          imageUrl: "",
          caption: "B",
          followUpMessage: "B hidden offer",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  let selectorCalls = 0;
  followUpAiService.selectPromotionPackageForFollowUp = async () => {
    selectorCalls += 1;
    return "Package A";
  };

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 751,
      whatsapp_number: "60133333338",
      trigger_message_id: 750,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care RM388配套还有吗？"],
      trigger_message_content: "我们有两个配套。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 752, contact_id: 751, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-752" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 751,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(selectorCalls, 0);
  assert.equal(claimInput.content, "您好，请问还需要帮助吗？");
});

test("compound 9D + 3D service wins over its component services for the delayed offer", async () => {
  enableTool();
  clinicConfig.services = [
    { name: "3D 小颜术" },
    { name: "9D 逆龄抗衰" },
    { name: "3D + 9D 组合" },
  ];
  clinicConfig.serviceAliases = [
    { alias: "9D + 3D 组合", officialService: "3D + 9D 组合" },
    { alias: "9D+3D", officialService: "3D + 9D 组合" },
  ];
  clinicConfig.promotions = [
    {
      name: "3D offer",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: false,
      caption: "3D RM488",
      followUpMessage: "3D gift",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
    {
      name: "9D offer",
      linkedService: "9D 逆龄抗衰",
      sendOnPriceQuery: false,
      caption: "9D RM488",
      followUpMessage: "9D gift",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
    {
      name: "9D + 3D combo",
      linkedService: "3D + 9D 组合",
      sendOnPriceQuery: false,
      caption: "9D + 3D RM688",
      followUpMessage: "🎁 Includes 经络按摩",
      imageUrl: "",
      packages: [],
      validFrom: null,
      validUntil: null,
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 741,
      whatsapp_number: "60133333336",
      trigger_message_id: 740,
      next_follow_up_step: 1,
      recent_inbound_messages: ["9D + 3D 组合多少钱？"],
      trigger_message_content: "✨ 9D + 3D 组合限时优惠: RM688",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 742, contact_id: 741, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-742" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 741,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "🎁 Includes 经络按摩");
  assert.equal(claimInput.targetedService, "3D + 9D 组合");
});

test("final pre-send check cancels a package follow-up if that exact package offer changed after claim", async () => {
  enableTool();
  clinicConfig.promotions = [
    {
      name: "Pelvic packages",
      linkedService: "Pelvic Care",
      sendOnPriceQuery: false,
      caption: "",
      imageUrl: "",
      packages: [
        {
          name: "Package A",
          title: "Premium package",
          aliases: ["A配套"],
          imageUrl: "",
          caption: "A",
          followUpMessage: "Package A hidden offer",
        },
        {
          name: "Package B",
          title: "Women's package",
          aliases: ["B配套"],
          imageUrl: "",
          caption: "B",
          followUpMessage: "Package B hidden offer",
        },
      ],
      validFrom: null,
      validUntil: null,
    },
  ];

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 760,
      whatsapp_number: "60133333344",
      trigger_message_id: 759,
      next_follow_up_step: 1,
      recent_inbound_messages: ["Pelvic Care Package A price?"],
      treatment_interest: "Pelvic Care",
      trigger_message_content: "Package A current price",
    },
  ];

  let discarded = false;
  followUpRepo.saveIfStillEligible = async () => {
    // Simulate staff editing Package A after the DB claim but before the
    // provider-level final pre-send check.
    clinicConfig.promotions[0].packages[0].followUpMessage =
      "Package A updated offer";
    return { id: 761, contact_id: 760, delivery_status: null };
  };
  followUpRepo.discardUnsentClaim = async () => {
    discarded = true;
    return { id: 761, contact_id: 760, delivery_status: "cancelled" };
  };

  let sendCalls = 0;
  whatsapp.sendMessage = async () => {
    sendCalls += 1;
    return { success: true, wamid: "should-not-send" };
  };
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(sendCalls, 0);
  assert.equal(discarded, true);
});

test("quiet hours defer due follow-ups until the configured clinic-local end time", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.quietHours.enabled = true;
  let candidateQueries = 0;
  followUpRepo.findCandidates = async () => {
    candidateQueries += 1;
    return [];
  };

  const result = await runAutomatedFollowUps({
    now: new Date("2026-10-04T17:00:00.000Z"),
  });

  assert.equal(candidateQueries, 0);
  assert.equal(result.enabled, true);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.nextDueAt, "2026-10-04T23:00:00.000Z");
});

test("follow-up discovery resumes exactly when quiet hours end", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.quietHours.enabled = true;
  let candidateQueries = 0;
  followUpRepo.findCandidates = async () => {
    candidateQueries += 1;
    return [];
  };

  await runAutomatedFollowUps({
    now: new Date("2026-10-04T23:00:00.000Z"),
  });

  assert.equal(candidateQueries, 1);
});

test("final pre-send guard rechecks quiet hours before provider delivery", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/followUpService.js"),
    "utf8"
  );
  assert.match(
    source,
    /quietHoursStatus\(new Date\(\), liveSettings\.quietHours\)\.active/
  );
  assert.match(
    source,
    /sendSocialImageCompanion\([\s\S]*quietHoursStatus\(new Date\(\), quietHours\)\.active/
  );
  assert.match(
    source,
    /discardUnsentSocialImageCompanion/
  );
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

test("sends the matching service-specific message for a later sequence step", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "Second follow-up",
      translations: {
        en: "Second follow-up",
        ms: "Susulan kedua",
        zh: "第二次跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Pelvic Care",
          message: "Pelvic care follow-up",
          translations: {
            en: "Pelvic care follow-up",
            ms: "Susulan penjagaan pelvis",
            zh: "骨盆调理跟进",
          },
        },
      ],
    },
  ];

  let discoveryInput = null;
  let claimInput = null;
  let sentMessage = null;
  followUpRepo.findCandidates = async (input) => {
    discoveryInput = input;
    return [
      {
        contact_id: 16,
        whatsapp_number: "60166666666",
        trigger_message_id: 90,
        next_follow_up_step: 2,
        treatment_interest: "  Pelvic Care  ",
        recent_inbound_messages: ["请问骨盆调理适合我吗？"],
      },
    ];
  };
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 91, contact_id: 16, delivery_status: null };
  };
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-91" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 16,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(discoveryInput.delayMinutes, [120, 480]);
  assert.equal(claimInput.stepIndex, 2);
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.delayMinutes, 480);
  assert.equal(claimInput.previousDelayMinutes, 120);
  assert.equal(claimInput.content, "骨盆调理跟进");
  assert.deepEqual(sentMessage, {
    number: "60166666666",
    message: "骨盆调理跟进",
  });
});

test("current configured service without an override beats stale CRM interest", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Pelvic Care",
          message: "Pelvic care follow-up",
          translations: {
            en: "Pelvic care follow-up",
            ms: "Susulan penjagaan pelvis",
            zh: "骨盆调理跟进",
          },
        },
      ],
    },
  ];

  let claimInput = null;
  let sentMessage = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 20,
      whatsapp_number: "60120000000",
      trigger_message_id: 100,
      next_follow_up_step: 2,
      treatment_interest: "Pelvic Care",
      recent_inbound_messages: ["I want to know more about Uterus Care."],
      trigger_message_content: "Sure, I can explain Uterus Care.",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 101, contact_id: 20, delivery_status: null };
  };
  followUpRepo.isClaimStillEligible = async () => true;
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-101" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 20,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.targetedService, null);
  assert.equal(claimInput.content, "General second follow-up");
  assert.deepEqual(sentMessage, {
    number: "60120000000",
    message: "General second follow-up",
  });
});

test("customer service history beats a multi-service package anchor for targeted follow-ups", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Pelvic Care",
          message: "Pelvic care video follow-up",
          translations: {
            en: "Pelvic care video follow-up",
            ms: "Susulan video Pelvic Care",
            zh: "骨盆调理视频跟进",
          },
        },
        {
          serviceName: "Uterus Care",
          message: "Uterus care follow-up",
          translations: {
            en: "Uterus care follow-up",
            ms: "Susulan Uterus Care",
            zh: "子宫调理跟进",
          },
        },
      ],
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 201,
      whatsapp_number: "60120000201",
      trigger_message_id: 200,
      next_follow_up_step: 2,
      treatment_interest: null,
      recent_inbound_messages: ["How much is it?"],
      recent_service_messages: [
        "How much is it?",
        "I want to know more about Pelvic Care",
      ],
      trigger_message_content:
        "Package includes Pelvic Care, Uterus Care and other wellness items.",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 202, contact_id: 201, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-202" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 201,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.content, "Pelvic care video follow-up");
});

test("a single current anchor service beats older customer service history", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Pelvic Care",
          message: "Pelvic follow-up",
          translations: {
            en: "Pelvic follow-up",
            ms: "Susulan Pelvic",
            zh: "骨盆跟进",
          },
        },
        {
          serviceName: "3D 小颜术",
          message: "3D follow-up",
          translations: {
            en: "3D follow-up",
            ms: "Susulan 3D",
            zh: "3D小颜术跟进",
          },
        },
      ],
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 203,
      whatsapp_number: "60120000203",
      trigger_message_id: 202,
      next_follow_up_step: 2,
      treatment_interest: "Pelvic Care",
      recent_inbound_messages: ["Hello, can I get more info?"],
      recent_service_messages: [
        "Hello, can I get more info?",
        "I asked about Pelvic Care yesterday",
      ],
      trigger_message_content:
        "Here is a Before & After from one 3D 小颜术 session.",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 204, contact_id: 203, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-204" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 203,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.targetedService, "3D 小颜术");
  assert.equal(claimInput.content, "3D follow-up");
});

test("plain 3D alias targets 3D 小颜术 without stealing 3D+9D", async (t) => {
  enableTool();
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.serviceAliases = originalAliases;
  });
  clinicConfig.services.push({ name: "9D 逆龄抗衰" });
  clinicConfig.services.push({ name: "3D + 9D 组合" });
  clinicConfig.serviceAliases = [
    { alias: "3D", officialService: "3D 小颜术" },
    { alias: "9D", officialService: "9D 逆龄抗衰" },
    { alias: "3D+9D", officialService: "3D + 9D 组合" },
    { alias: "9D+3D", officialService: "3D + 9D 组合" },
  ];
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "3D 小颜术",
          message: "3D targeted follow-up",
          translations: {
            en: "3D targeted follow-up",
            ms: "Susulan 3D",
            zh: "3D小颜术跟进",
          },
        },
        {
          serviceName: "3D + 9D 组合",
          message: "3D+9D combo follow-up",
          translations: {
            en: "3D+9D combo follow-up",
            ms: "Susulan kombinasi 3D+9D",
            zh: "3D+9D组合跟进",
          },
        },
      ],
    },
  ];

  const candidates = [
    {
      contact_id: 205,
      whatsapp_number: "60120000205",
      trigger_message_id: 204,
      next_follow_up_step: 2,
      treatment_interest: null,
      recent_inbound_messages: ["3D price?"],
      trigger_message_content: "Here are the details.",
    },
    {
      contact_id: 207,
      whatsapp_number: "60120000207",
      trigger_message_id: 206,
      next_follow_up_step: 2,
      treatment_interest: null,
      recent_inbound_messages: ["3D+9D price?"],
      trigger_message_content: "Here are the combo details.",
    },
    {
      contact_id: 209,
      whatsapp_number: "60120000209",
      trigger_message_id: 208,
      next_follow_up_step: 2,
      treatment_interest: "3D + 9D 组合",
      recent_inbound_messages: ["3D 小颜术 / 9D 逆龄抗衰 price?"],
      trigger_message_content: "Here are the combo details.",
    },
  ];
  followUpRepo.findCandidates = async () => candidates;

  const claims = [];
  followUpRepo.saveIfStillEligible = async (input) => {
    claims.push(input);
    return {
      id: 300 + claims.length,
      contact_id: input.contactId,
      delivery_status: null,
    };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-target" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: id,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claims.length, 3);
  assert.equal(claims[0].targetedService, "3D 小颜术");
  assert.equal(claims[0].content, "3D targeted follow-up");
  assert.equal(claims[1].targetedService, "3D + 9D 组合");
  assert.equal(claims[1].content, "3D+9D combo follow-up");
  assert.equal(claims[2].targetedService, "3D + 9D 组合");
  assert.equal(claims[2].content, "3D+9D combo follow-up");
});

test("explicit 3D and 9D comparison stays ambiguous instead of choosing the combo", async (t) => {
  enableTool();
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.serviceAliases = originalAliases;
  });
  clinicConfig.services.push({ name: "9D 逆龄抗衰" });
  clinicConfig.services.push({ name: "3D + 9D 组合" });
  clinicConfig.serviceAliases = [
    { alias: "3D", officialService: "3D 小颜术" },
    { alias: "9D", officialService: "9D 逆龄抗衰" },
    { alias: "3D+9D", officialService: "3D + 9D 组合" },
  ];
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "3D 小颜术",
          message: "3D targeted follow-up",
          translations: {
            en: "3D targeted follow-up",
            ms: "Susulan 3D",
            zh: "3D小颜术跟进",
          },
        },
        {
          serviceName: "9D 逆龄抗衰",
          message: "9D targeted follow-up",
          translations: {
            en: "9D targeted follow-up",
            ms: "Susulan 9D",
            zh: "9D跟进",
          },
        },
        {
          serviceName: "3D + 9D 组合",
          message: "Combo targeted follow-up",
          translations: {
            en: "Combo targeted follow-up",
            ms: "Susulan kombinasi",
            zh: "组合跟进",
          },
        },
      ],
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [{
    contact_id: 209,
    whatsapp_number: "60120000209",
    trigger_message_id: 208,
    next_follow_up_step: 2,
    treatment_interest: "3D + 9D 组合",
    recent_inbound_messages: ["3D or 9D, which one suits me?"],
    trigger_message_content: "I can explain both.",
  }];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 210, contact_id: 209, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-210" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 209,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.targetedService, null);
  assert.equal(claimInput.content, "General second follow-up");
});

test("can infer one targeted service from a configured alias in recent conversation", async (t) => {
  enableTool();
  const originalAliases = clinicConfig.serviceAliases;
  t.after(() => {
    clinicConfig.serviceAliases = originalAliases;
  });
  clinicConfig.serviceAliases = [
    { alias: "3D", officialService: "3D 小颜术" },
  ];
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "Second follow-up",
      translations: {
        en: "Second follow-up",
        ms: "Susulan kedua",
        zh: "第二次跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "3D 小颜术",
          message: "3D follow-up",
          translations: {
            en: "3D follow-up",
            ms: "Susulan 3D",
            zh: "想跟进一下刚才你了解的3D小颜术。",
          },
        },
      ],
    },
  ];

  let sentMessage = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 18,
      whatsapp_number: "60188888888",
      trigger_message_id: 94,
      next_follow_up_step: 2,
      treatment_interest: null,
      recent_inbound_messages: ["3D适合双下巴吗？"],
      trigger_message_content: "3D小颜术主要是针对脸部线条做调整。",
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => ({
    id: 95,
    contact_id: 18,
    content: input.content,
    delivery_status: null,
  });
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-95" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 18,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(sentMessage, {
    number: "60188888888",
    message: "想跟进一下刚才你了解的3D小颜术。",
  });
});

test("falls back to the step default when service interest is not an exact match", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "Second follow-up",
      translations: {
        en: "Second follow-up",
        ms: "Susulan kedua",
        zh: "第二次跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Pelvic Care",
          message: "Pelvic care follow-up",
          translations: {
            en: "Pelvic care follow-up",
            ms: "Susulan penjagaan pelvis",
            zh: "骨盆调理跟进",
          },
        },
        {
          serviceName: "Uterus Care",
          message: "Uterus care follow-up",
          translations: {
            en: "Uterus care follow-up",
            ms: "Susulan penjagaan rahim",
            zh: "子宫调理跟进",
          },
        },
      ],
    },
  ];

  let sentMessage = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 17,
      whatsapp_number: "60177777777",
      trigger_message_id: 92,
      next_follow_up_step: 2,
      treatment_interest: "Pelvic Care",
      recent_inbound_messages: ["I'm comparing Pelvic Care and Uterus Care."],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => ({
    id: 93,
    contact_id: 17,
    content: input.content,
    delivery_status: null,
  });
  whatsapp.sendMessage = async (number, message) => {
    sentMessage = { number, message };
    return { success: true, wamid: "wamid-93" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 17,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(sentMessage, {
    number: "60177777777",
    message: "Second follow-up",
  });
});

test("stale service overrides fail safe to the general message", async () => {
  enableTool();
  clinicConfig.services = [{ name: "Current Service" }];
  clinicConfig.automatedFollowUp.additionalSteps = [
    {
      delayMinutes: 480,
      message: "General second follow-up",
      translations: {
        en: "General second follow-up",
        ms: "Susulan umum kedua",
        zh: "第二次一般跟进",
      },
      imageUrl: "",
      serviceOverrides: [
        {
          serviceName: "Removed Service",
          message: "Stale targeted message",
          translations: {
            en: "Stale targeted message",
            ms: "Mesej lama",
            zh: "旧的针对信息",
          },
        },
      ],
    },
  ];

  let claimInput = null;
  followUpRepo.findCandidates = async () => [
    {
      contact_id: 19,
      whatsapp_number: "60199999999",
      trigger_message_id: 96,
      next_follow_up_step: 2,
      treatment_interest: "Removed Service",
      recent_inbound_messages: ["Removed Service"],
    },
  ];
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 97, contact_id: 19, delivery_status: null };
  };
  whatsapp.sendMessage = async () => ({ success: true, wamid: "wamid-97" });
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 19,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimInput.content, "General second follow-up");
  assert.equal(claimInput.targetedService, null);
});

test("cancels and removes a claimed follow-up when final pre-send eligibility changes", async () => {
  enableTool();
  let providerCalls = 0;
  let finalCheck = null;
  let discarded = null;
  let attentionCalls = 0;

  followUpRepo.findCandidates = async () => [
    {
      contact_id: 21,
      whatsapp_number: "60121111111",
      trigger_message_id: 110,
      recent_inbound_messages: ["Still considering"],
    },
  ];
  followUpRepo.saveIfStillEligible = async () => ({
    id: 111,
    contact_id: 21,
    delivery_status: null,
    whatsapp_message_id: null,
  });
  followUpRepo.isClaimStillEligible = async (input) => {
    finalCheck = input;
    return false;
  };
  followUpRepo.discardUnsentClaim = async (input) => {
    discarded = input;
    return {
      id: 111,
      contact_id: 21,
      delivery_status: null,
      whatsapp_message_id: null,
    };
  };
  whatsapp.sendMessage = async () => {
    providerCalls += 1;
    return { success: true, wamid: "must-not-send" };
  };
  contactsRepo.setDeliveryAttention = async () => {
    attentionCalls += 1;
  };
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.deepEqual(finalCheck, {
    messageId: 111,
    contactId: 21,
  });
  assert.deepEqual(discarded, {
    messageId: 111,
    contactId: 21,
  });
  assert.equal(providerCalls, 0);
  assert.equal(attentionCalls, 0);
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

test("global reply pause prevents automated follow-up candidate sends", async (t) => {
  enableTool();
  const originalFlag = process.env.AUTOMATED_REPLIES_ENABLED;
  let candidateQueries = 0;
  let sendCount = 0;

  t.after(() => {
    if (originalFlag === undefined) delete process.env.AUTOMATED_REPLIES_ENABLED;
    else process.env.AUTOMATED_REPLIES_ENABLED = originalFlag;
  });

  process.env.AUTOMATED_REPLIES_ENABLED = "false";
  followUpRepo.findCandidates = async () => {
    candidateQueries += 1;
    return [{ contact_id: 15, whatsapp_number: "60155555555", trigger_message_id: 80 }];
  };
  whatsapp.sendMessage = async () => {
    sendCount += 1;
    return { success: true, wamid: "unexpected" };
  };

  const result = await runAutomatedFollowUps();

  assert.equal(result.enabled, false);
  assert.equal(candidateQueries, 0);
  assert.equal(sendCount, 0);
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

test("keeps a fresh interrupted follow-up recovery scheduled even while the tool is disabled", async () => {
  clinicConfig.automatedFollowUp = {
    ...clinicConfig.automatedFollowUp,
    enabled: false,
    activatedAt: null,
  };
  const recoveryDueAt = new Date(Date.now() + 7 * 60 * 1000).toISOString();
  let candidateQueries = 0;
  let recoveryScheduleInput = null;

  followUpRepo.findCandidates = async () => {
    candidateQueries += 1;
    return [];
  };
  followUpRepo.getNextStaleClaimDueAt = async (input) => {
    recoveryScheduleInput = input;
    return recoveryDueAt;
  };

  const result = await runAutomatedFollowUps();

  assert.equal(candidateQueries, 0);
  assert.deepEqual(recoveryScheduleInput, {
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
  });
  assert.equal(result.nextRecoveryAt, recoveryDueAt);
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


test("follow-up worker wakes when pipeline eligibility changes", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/followUpService.js"),
    "utf8"
  );
  assert.match(
    source,
    /realtimeEvents\.subscribe\("pipeline_changed",[\s\S]*wakeAutomatedFollowUps\(0\)/
  );
});


test("AI mode sends the personalized message instead of the fixed fallback", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Continue the unresolved concern naturally.";

  followUpRepo.findCandidates = async () => [{
    contact_id: 31,
    channel: "whatsapp",
    whatsapp_number: "60111111111",
    trigger_message_id: 301,
    trigger_message_content: "First Trial is RM488.",
    recent_inbound_messages: ["做一次就可以看到效果？"],
    treatment_interest: "3D 小颜术",
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { role: "user", content: "做一次就可以看到效果？" },
      { role: "assistant", content: "第一次可以先体验看看自己的变化。" },
    ],
    lead: { treatment_interest: "3D 小颜术", stage_name: "Warm" },
  });
  followUpAiService.generatePersonalizedFollowUp = async (input) => {
    assert.equal(input.stepNumber, 1);
    assert.equal(input.treatmentInterest, "3D 小颜术");
    return {
      action: "send",
      message: "如果你想先看看自己的变化，可以先体验一次，再根据体验后的情况决定后续 😊",
      reason: "The customer is interested but still considering.",
      topic: "3D 小颜术",
    };
  };

  let claimedInput = null;
  followUpRepo.saveIfStillEligible = async (input) => {
    claimedInput = input;
    return { id: 302, contact_id: 31, delivery_status: null };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 31,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  whatsapp.sendMessage = async (_number, message) => {
    assert.equal(message, claimedInput.content);
    return { success: true, wamid: "wamid-ai-302" };
  };
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(
    claimedInput.content,
    "如果你想先看看自己的变化，可以先体验一次，再根据体验后的情况决定后续 😊"
  );
  assert.equal(claimedInput.messageMode, "ai_personalized");
  assert.equal(claimedInput.targetedService, null);
});

test("AI-mode targeted media keeps the configured caption after AI safety review", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Continue naturally.";
  clinicConfig.automatedFollowUp.serviceOverrides = [
    {
      serviceName: "Pelvic Care",
      message: "Pelvic Care configured video caption",
      translations: {
        en: "Pelvic Care configured video caption",
        ms: "Kapsyen video Pelvic Care yang ditetapkan",
        zh: "骨盆调理已设定的视频文案",
      },
      imageUrl: "",
      videoKey: "clients/neutro/messages/follow-up-config/pelvis-ai.mp4",
      videoFilename: "pelvis-ai.mp4",
    },
  ];

  followUpRepo.findCandidates = async () => [{
    contact_id: 321,
    channel: "whatsapp",
    whatsapp_number: "60120000321",
    trigger_message_id: 320,
    trigger_message_content: "Here are the package details.",
    recent_inbound_messages: ["How much is it?"],
    recent_service_messages: ["How much is it?", "Tell me about Pelvic Care"],
    treatment_interest: null,
    next_follow_up_step: 1,
  }];

  let aiCalls = 0;
  followUpAiService.generatePersonalizedFollowUp = async () => {
    aiCalls += 1;
    return {
      action: "send",
      message: "This AI text must not replace the configured media caption.",
      reason: "The follow-up is still appropriate to send.",
      topic: "Pelvic Care",
    };
  };

  let claimInput = null;
  let videoSend = null;
  mediaStorage.copyStoredMediaToMessage = async (key, mimeType, options) => {
    assert.equal(
      key,
      "clients/neutro/messages/follow-up-config/pelvis-ai.mp4"
    );
    assert.equal(mimeType, "video/mp4");
    assert.deepEqual(options, { contactId: 321 });
    return "clients/neutro/messages/321/pelvis-ai.mp4";
  };
  followUpRepo.saveIfStillEligible = async (input) => {
    claimInput = input;
    return { id: 322, contact_id: 321, delivery_status: null };
  };
  channelMessaging.sendVideoByStoredKey = async (
    contact,
    key,
    caption,
    filename
  ) => {
    videoSend = { contact, key, caption, filename };
    return { success: true, wamid: "wamid-ai-video-322" };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 321,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(aiCalls, 1);
  assert.equal(claimInput.messageMode, "fixed");
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.content, "Pelvic Care configured video caption");
  assert.equal(
    claimInput.mediaKey,
    "clients/neutro/messages/321/pelvis-ai.mp4"
  );
  assert.deepEqual(videoSend, {
    contact: {
      id: 321,
      channel: "whatsapp",
      whatsapp_number: "60120000321",
      channel_user_id: undefined,
    },
    key: "clients/neutro/messages/321/pelvis-ai.mp4",
    caption: "Pelvic Care configured video caption",
    filename: "pelvis-ai.mp4",
  });
});

test("AI-mode targeted media still honors human-review decisions before sending", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Continue naturally.";
  clinicConfig.automatedFollowUp.serviceOverrides = [
    {
      serviceName: "Pelvic Care",
      message: "Pelvic Care configured video caption",
      translations: {
        en: "Pelvic Care configured video caption",
        ms: "Kapsyen video Pelvic Care yang ditetapkan",
        zh: "骨盆调理已设定的视频文案",
      },
      imageUrl: "",
      videoKey: "clients/neutro/messages/follow-up-config/pelvis-safety.mp4",
      videoFilename: "pelvis-safety.mp4",
    },
  ];

  followUpRepo.findCandidates = async () => [{
    contact_id: 323,
    channel: "whatsapp",
    whatsapp_number: "60120000323",
    trigger_message_id: 322,
    trigger_message_content: "Here are the Pelvic Care details.",
    recent_inbound_messages: ["I am pregnant, can I do this?"],
    recent_service_messages: ["I am pregnant, can I do this?", "Pelvic Care"],
    treatment_interest: "Pelvic Care",
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { id: 321, role: "user", content: "I am pregnant, can I do this?" },
      { id: 322, role: "assistant", content: "Here are the Pelvic Care details." },
    ],
    lead: { treatment_interest: "Pelvic Care", stage_name: "Warm" },
  });
  followUpAiService.generatePersonalizedFollowUp = async () => ({
    action: "human_review",
    message: "",
    reason: "Pregnancy suitability requires staff review.",
    topic: "Pelvic Care",
  });

  let decision = null;
  let attention = null;
  let saveCount = 0;
  let videoSendCount = 0;
  const originalSetAttention = contactsRepo.setAttention;
  followUpRepo.recordAiDecisionIfStillEligible = async (input) => {
    decision = input;
    return { id: 323, ...input };
  };
  followUpRepo.saveIfStillEligible = async () => {
    saveCount += 1;
    return null;
  };
  contactsRepo.setAttention = async (contactId, enabled, reason) => {
    attention = { contactId, enabled, reason };
    return null;
  };
  channelMessaging.sendVideoByStoredKey = async () => {
    videoSendCount += 1;
    return { success: true, wamid: "unexpected" };
  };
  realtimeEvents.publish = () => {};

  try {
    await runAutomatedFollowUps();
  } finally {
    contactsRepo.setAttention = originalSetAttention;
  }

  assert.equal(decision.action, "human_review");
  assert.equal(saveCount, 0);
  assert.equal(videoSendCount, 0);
  assert.equal(attention.contactId, 323);
  assert.equal(attention.enabled, true);
  assert.match(attention.reason, /pregnancy/i);
});

test("promotion-config-only human review after a staff promo falls back without attention", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Follow up naturally.";
  clinicConfig.automatedFollowUp.message = "Safe fallback";
  clinicConfig.automatedFollowUp.translations = {
    en: "Safe fallback",
    ms: "Safe fallback",
    zh: "Safe fallback",
  };

  followUpRepo.findCandidates = async () => [{
    contact_id: 315,
    channel: "whatsapp",
    whatsapp_number: "60155555555",
    trigger_message_id: 314,
    trigger_message_content:
      "本月限时优惠 - 骨盆护理 🔥 RM100 优惠券限时领取（只限100位）",
    recent_inbound_messages: ["骨盆调理多少钱？"],
    treatment_interest: "Pelvic Care",
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { id: 313, role: "user", content: "骨盆调理多少钱？" },
      {
        id: 314,
        role: "assistant",
        content:
          "本月限时优惠 - 骨盆护理 🔥 RM100 优惠券限时领取（只限100位）",
        sent_by_username: "admin",
        is_automated_follow_up: false,
      },
    ],
    lead: { treatment_interest: "Pelvic Care", stage_name: "Warm" },
  });
  followUpAiService.generatePersonalizedFollowUp = async () => ({
    action: "human_review",
    message: "",
    reason:
      "Staff sent an unconfigured promotional voucher (RM100 优惠券) not found in active promotions, requiring staff review.",
    topic: "Pelvic Care",
  });

  let decisionCount = 0;
  let attentionCount = 0;
  let claimedInput = null;
  const originalSetAttention = contactsRepo.setAttention;
  followUpRepo.recordAiDecisionIfStillEligible = async () => {
    decisionCount += 1;
    return { id: 1 };
  };
  followUpRepo.saveIfStillEligible = async (input) => {
    claimedInput = input;
    return { id: 316, contact_id: 315, delivery_status: null };
  };
  contactsRepo.setAttention = async () => {
    attentionCount += 1;
    return null;
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 315,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  whatsapp.sendMessage = async (_number, message) => {
    assert.equal(message, "Safe fallback");
    return { success: true, wamid: "wamid-316" };
  };
  realtimeEvents.publish = () => {};

  try {
    await runAutomatedFollowUps();
  } finally {
    contactsRepo.setAttention = originalSetAttention;
  }

  assert.equal(decisionCount, 0);
  assert.equal(attentionCount, 0);
  assert.equal(claimedInput.content, "Safe fallback");
  assert.equal(claimedInput.messageMode, "ai_fallback");
});

test("genuine medical human review after a staff promo is still persisted and flagged", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";

  followUpRepo.findCandidates = async () => [{
    contact_id: 325,
    channel: "whatsapp",
    whatsapp_number: "60166666666",
    trigger_message_id: 324,
    trigger_message_content: "RM100 优惠券限时领取",
    recent_inbound_messages: ["怀孕可以做吗？"],
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { id: 323, role: "user", content: "怀孕可以做吗？" },
      {
        id: 324,
        role: "assistant",
        content: "RM100 优惠券限时领取",
        sent_by_username: "admin",
        is_automated_follow_up: false,
      },
    ],
    lead: null,
  });
  followUpAiService.generatePersonalizedFollowUp = async () => ({
    action: "human_review",
    message: "",
    reason: "Customer mentioned pregnancy and treatment suitability requires medical review.",
    topic: "Pelvic Care",
  });

  let decision = null;
  let attention = null;
  let saveCount = 0;
  const originalSetAttention = contactsRepo.setAttention;
  followUpRepo.recordAiDecisionIfStillEligible = async (input) => {
    decision = input;
    return { id: 2, ...input };
  };
  followUpRepo.saveIfStillEligible = async () => {
    saveCount += 1;
    return null;
  };
  contactsRepo.setAttention = async (contactId, enabled, reason) => {
    attention = { contactId, enabled, reason };
    return null;
  };

  try {
    await runAutomatedFollowUps();
  } finally {
    contactsRepo.setAttention = originalSetAttention;
  }

  assert.equal(decision.action, "human_review");
  assert.equal(saveCount, 0);
  assert.equal(attention.contactId, 325);
  assert.equal(attention.enabled, true);
  assert.match(attention.reason, /pregnancy/i);
});

test("AI skip is persisted without creating or sending a follow-up message", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";

  followUpRepo.findCandidates = async () => [{
    contact_id: 32,
    channel: "whatsapp",
    whatsapp_number: "60122222222",
    trigger_message_id: 311,
    trigger_message_content: "No problem, take care.",
    recent_inbound_messages: ["不用了谢谢"],
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [
      { role: "user", content: "不用了谢谢" },
      { role: "assistant", content: "好的没问题，有需要再找我们就好 😊" },
    ],
    lead: null,
  });
  followUpAiService.generatePersonalizedFollowUp = async () => ({
    action: "skip",
    message: "",
    reason: "Customer explicitly declined.",
    topic: "",
  });

  let decision = null;
  let saveCount = 0;
  let sendCount = 0;
  followUpRepo.recordAiDecisionIfStillEligible = async (input) => {
    decision = input;
    return { id: 1, ...input };
  };
  followUpRepo.saveIfStillEligible = async () => {
    saveCount += 1;
    return null;
  };
  whatsapp.sendMessage = async () => {
    sendCount += 1;
    return { success: true, wamid: "unexpected" };
  };

  await runAutomatedFollowUps();

  assert.equal(decision.action, "skip");
  assert.equal(decision.triggerMessageId, 311);
  assert.equal(saveCount, 0);
  assert.equal(sendCount, 0);
});

test("AI generation failure falls back to the reviewed fixed message", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.message = "Safe fallback";
  clinicConfig.automatedFollowUp.translations = {
    en: "Safe fallback",
    ms: "Safe fallback",
    zh: "Safe fallback",
  };

  followUpRepo.findCandidates = async () => [{
    contact_id: 33,
    channel: "whatsapp",
    whatsapp_number: "60133333333",
    trigger_message_id: 321,
    trigger_message_content: "Here are the details.",
    recent_inbound_messages: ["Okay"],
    next_follow_up_step: 1,
  }];
  followUpRepo.getAiFollowUpContext = async () => ({
    messages: [{ role: "user", content: "Okay" }],
    lead: null,
  });
  followUpAiService.generatePersonalizedFollowUp = async () => {
    const err = new Error("Provider unavailable");
    err.code = "ALL_AI_PROVIDERS_FAILED";
    throw err;
  };

  let claimedInput = null;
  followUpRepo.saveIfStillEligible = async (input) => {
    claimedInput = input;
    return { id: 322, contact_id: 33, delivery_status: null };
  };
  messagesRepo.setWhatsappMessageId = async (id, wamid) => ({
    id,
    contact_id: 33,
    whatsapp_message_id: wamid,
    delivery_status: "pending",
  });
  whatsapp.sendMessage = async (_number, message) => {
    assert.equal(message, "Safe fallback");
    return { success: true, wamid: "wamid-fallback-322" };
  };
  realtimeEvents.publish = () => {};

  await runAutomatedFollowUps();

  assert.equal(claimedInput.content, "Safe fallback");
  assert.equal(claimedInput.messageMode, "ai_fallback");
});


test("AI mode does not generate when another worker owns the generation lease", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";

  followUpRepo.findCandidates = async () => [{
    contact_id: 34,
    channel: "whatsapp",
    whatsapp_number: "60144444444",
    trigger_message_id: 331,
    trigger_message_content: "Here are the details.",
    recent_inbound_messages: ["Okay"],
    next_follow_up_step: 1,
  }];
  followUpAiLeaseRepo.claimIfStillEligible = async () => null;

  let generationCount = 0;
  let saveCount = 0;
  followUpAiService.generatePersonalizedFollowUp = async () => {
    generationCount += 1;
    return { action: "send", message: "Should not happen", reason: "", topic: "" };
  };
  followUpRepo.saveIfStillEligible = async () => {
    saveCount += 1;
    return null;
  };

  await runAutomatedFollowUps();

  assert.equal(generationCount, 0);
  assert.equal(saveCount, 0);
});
