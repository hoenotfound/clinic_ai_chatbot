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

test("Neutro video AI uses personalized caption with the configured video", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Continue naturally.";
  clinicConfig.automatedFollowUp.videoAiCaptionsEnabled = true;
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
      message: "Personalized advice about the pelvic concern.",
      reason: "The follow-up is still appropriate to send.",
      topic: "Pelvic Care",
    };
  };

  let claimInput = null;
  let videoSend = null;
  mediaStorage.copyStoredMediaToMessage = async () => {
    throw new Error("follow-up videos must not create permanent copies");
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
  assert.equal(claimInput.messageMode, "ai_personalized");
  assert.equal(claimInput.targetedService, "Pelvic Care");
  assert.equal(claimInput.content, "Personalized advice about the pelvic concern.");
  assert.equal(
    claimInput.mediaKey,
    "clients/neutro/messages/follow-up-config/pelvis-ai.mp4"
  );
  assert.deepEqual(videoSend, {
    contact: {
      id: 321,
      channel: "whatsapp",
      whatsapp_number: "60120000321",
      channel_user_id: undefined,
    },
    key: "clients/neutro/messages/follow-up-config/pelvis-ai.mp4",
    caption: "Personalized advice about the pelvic concern.",
    filename: "pelvis-ai.mp4",
  });
});

test("Neutro video already sent yields truthful text-only fallback", async () => {
  enableTool();
  clinicConfig.automatedFollowUp.messageMode = "ai";
  clinicConfig.automatedFollowUp.aiInstruction = "Continue naturally.";
  clinicConfig.automatedFollowUp.videoAiCaptionsEnabled = true;
  clinicConfig.automatedFollowUp.videoDuplicateProtectionEnabled = true;
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
      message: "Here is the video you asked about.",
      reason: "The follow-up is still appropriate to send.",
      topic: "Pelvic Care",
    };
  };

  let claimInput = null;
  let videoSend = null;
  const { pool } = require("../src/db/db");
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ present: true }] });
  const originalSendText = channelMessaging.sendText;
  let sentText = null;
  channelMessaging.sendText = async (_contact, text) => {
    sentText = text;
    return { success: true, wamid: "wamid-fallback-322" };
  };

  mediaStorage.copyStoredMediaToMessage = async () => {
    throw new Error("follow-up videos must not create permanent copies");
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

  try {
    await runAutomatedFollowUps();
  } finally {
    pool.query = originalQuery;
    channelMessaging.sendText = originalSendText;
  }

  assert.equal(aiCalls, 1);
  assert.equal(claimInput.messageMode, "fixed");
  assert.equal(claimInput.mediaKey, null);
  assert.ok(sentText);
  assert.match(sentText, /posture|腰|体态|pelvic|小腹/iu);
  assert.doesNotMatch(sentText, /sharing.*video|这段影片|视频发给你|watch this video/iu);
  assert.equal(videoSend, null);

});

