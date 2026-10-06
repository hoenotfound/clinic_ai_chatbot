const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("portal policy state distinguishes open, closed, never-contacted and opted-out WhatsApp chats", async () => {
  const { messagingPolicyStatus } = await import(
    "../portal-frontend/src/utils/whatsappPolicy.js"
  );
  const now = Date.parse("2026-09-03T12:00:00.000Z");

  const open = messagingPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-03T10:30:00.000Z",
  }, now);
  assert.equal(open.freeformAllowed, true);
  assert.match(open.label, /Reply available/);
  assert.equal(open.explanation, null);

  const closed = messagingPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-02T10:30:00.000Z",
  }, now);
  assert.equal(closed.code, "outside_customer_service_window");

  const neverMessaged = messagingPolicyStatus({ channel: "whatsapp" }, now);
  assert.equal(neverMessaged.code, "no_customer_message");

  const optedOut = messagingPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-03T11:00:00.000Z",
    whatsapp_opt_out_at: "2026-09-03T11:00:00.000Z",
  }, now);
  assert.equal(optedOut.code, "opted_out");
  assert.equal(optedOut.automatedAllowed, false);

  const marketingOptedOut = messagingPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-03T11:00:00.000Z",
    whatsapp_marketing_opt_out_at: "2026-09-03T10:30:00.000Z",
  }, now);
  assert.equal(marketingOptedOut.freeformAllowed, true);
  assert.equal(marketingOptedOut.marketingOptedOut, true);
  assert.equal(
    marketingOptedOut.marketingOptedOutAt,
    "2026-09-03T10:30:00.000Z"
  );

  const instagram = messagingPolicyStatus({
    channel: "instagram",
    human_agent_enabled: true,
    latest_inbound_at: "2026-09-02T10:30:00.000Z",
  }, now);
  assert.equal(instagram.applies, true);
  assert.equal(instagram.freeformAllowed, false);
  assert.equal(instagram.humanAgentAllowed, true);
  assert.equal(instagram.manualReplyAllowed, true);
  assert.equal(instagram.automatedAllowed, false);
  assert.equal(instagram.code, "human_agent_only");
  assert.match(instagram.label, /Staff reply only/);
  assert.equal(instagram.channelLabel, "Instagram");

  const instagramExpired = messagingPolicyStatus({
    channel: "instagram",
    human_agent_enabled: true,
    latest_inbound_at: "2026-08-20T10:30:00.000Z",
  }, now);
  assert.equal(instagramExpired.code, "outside_human_agent_window");
  assert.equal(instagramExpired.manualReplyAllowed, false);

  const facebookWithoutHumanAgent = messagingPolicyStatus({
    channel: "facebook",
    human_agent_enabled: false,
    latest_inbound_at: "2026-09-02T10:30:00.000Z",
  }, now);
  assert.equal(facebookWithoutHumanAgent.code, "outside_customer_service_window");
  assert.equal(facebookWithoutHumanAgent.humanAgentAllowed, false);
  assert.equal(facebookWithoutHumanAgent.manualReplyAllowed, false);

  const facebook = messagingPolicyStatus({
    channel: "facebook",
    latest_inbound_at: "2026-09-03T11:30:00.000Z",
  }, now);
  assert.equal(facebook.applies, true);
  assert.equal(facebook.freeformAllowed, true);
  assert.equal(facebook.channelLabel, "Facebook Messenger");

  const unsupported = messagingPolicyStatus({ channel: "telegram" }, now);
  assert.equal(unsupported.applies, false);
  assert.equal(unsupported.freeformAllowed, true);
  assert.equal(unsupported.manualReplyAllowed, true);
});

test("portal hides retry for policy failures but keeps ordinary delivery failures retryable", async () => {
  const { policyFailureExplanation } = await import(
    "../portal-frontend/src/utils/whatsappPolicy.js"
  );

  assert.match(
    policyFailureExplanation({ delivery_error: "WhatsApp send blocked because this customer opted out." }),
    /opted out/i
  );
  assert.match(
    policyFailureExplanation({ policy_code: "marketing_opted_out" }),
    /utility templates/i
  );
  assert.match(
    policyFailureExplanation({ delivery_error: "The 24-hour customer-service window has closed." }),
    /message again/i
  );
  const instagramFailure = policyFailureExplanation(
    { delivery_error: "Instagram send blocked because the 24-hour standard messaging window has closed." },
    "instagram"
  );
  assert.match(instagramFailure, /message again/i);
  assert.match(instagramFailure, /Instagram/);
  assert.doesNotMatch(instagramFailure, /WhatsApp/);
  assert.equal(
    policyFailureExplanation({ delivery_error: "Meta temporarily rejected the request." }),
    null
  );
});

test("Inbox and contact details expose policy guidance for standard-window channels", () => {
  const root = path.join(__dirname, "..");
  const inbox = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Inbox.jsx"), "utf8");
  const details = fs.readFileSync(path.join(root, "portal-frontend/src/components/WhatsAppMessagingDetails.jsx"), "utf8");
  const contactsRepo = fs.readFileSync(path.join(root, "src/db/contactsRepo.js"), "utf8");
  const tools = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Tools.jsx"), "utf8");
  const leadDrawer = fs.readFileSync(path.join(root, "portal-frontend/src/components/pipeline/LeadDrawer.jsx"), "utf8");

  assert.doesNotMatch(inbox, /Sending unavailable\./);
  assert.match(inbox, /quietReplyAvailable/);
  assert.match(inbox, /manualReplyAllowed/);
  assert.match(contactsRepo, /human_agent_enabled: humanAgentChannelEnabled\(row\.channel\)/);
  assert.match(inbox, /Cannot retry/);
  assert.match(inbox, /must message the business before staff can send a normal reply/);
  assert.match(inbox, /whatsappTemplateNeedsOptIn/);
  assert.match(inbox, /WhatsApp opt-in is not recorded/);
  assert.match(inbox, /Record opt-in & choose template/);
  assert.match(details, /policy\.channelLabel} reply window/);
  assert.match(details, /Standard 24-hour reply-window status/);
  assert.match(details, /Opt-in date \/ source/);
  assert.match(details, /Opt-out date \/ source/);
  assert.match(tools, /Messenger, and Instagram follow-ups/);
  assert.match(tools, /WhatsApp opt-outs remain a hard stop/);
  assert.match(leadDrawer, /CRM marketing consent/);
  assert.match(leadDrawer, /does not record the dedicated WhatsApp opt-in/);
});

test("staff send routes check channel policy before Staff Assist", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const textRoute = source.slice(
    source.indexOf('router.post("/:contactId/messages",'),
    source.indexOf("function handleImageUpload")
  );
  const imageRoute = source.slice(
    source.indexOf('router.post("/:contactId/media",'),
    source.indexOf('router.post("/:contactId/voice",')
  );

  assert.ok(textRoute.indexOf("requireFreeformPolicy") < textRoute.indexOf("prepareStaffSend"));
  assert.ok(imageRoute.indexOf("requireFreeformPolicy") < imageRoute.indexOf("prepareStaffSend"));
  const helperStart = source.indexOf("async function prepareStaffSend");
  const helperEnd = source.indexOf("async function persistSendOutcome", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /aiReplyCancellation\.cancelForContact\(contact\)/);
  assert.doesNotMatch(helper, /contactsRepo\.takeOver/);
  assert.match(
    textRoute,
    /telegramImmediateAlertRepo\.withContactAlertLock\(\s*contact\.id,[\s\S]*prepareStaffSend\(\s*contact,\s*req\.session\.username\s*\)[\s\S]*appendMessageForContact/
  );
  assert.match(
    imageRoute,
    /telegramImmediateAlertRepo\.withContactAlertLock\(\s*contact\.id,[\s\S]*prepareStaffSend\(\s*contact,\s*req\.session\.username\s*\)[\s\S]*appendMessageForContact/
  );
  assert.match(
    textRoute,
    /requireFreeformPolicy\(contact, res, whatsappPolicy\.manualStaffPurpose\(contact\)\)/
  );
  assert.match(
    imageRoute,
    /requireFreeformPolicy\(contact, res, whatsappPolicy\.manualStaffPurpose\(contact\)\)/
  );
  assert.match(source, /message\.is_automated_follow_up !== true/);
  assert.match(source, /message\.is_scheduled_message !== true/);
  assert.match(source, /\? whatsappPolicy\.manualStaffPurpose\(contact\)/);
  assert.match(
    source,
    /socialProviderSendOptions\(message, contact, \{ \.\.\.options, skipCaption \}\)/
  );
  assert.match(source, /channelMessaging\.sendText/);
  assert.match(source, /channelMessaging\.sendImageBuffer/);
});
test("Inbox WhatsApp reply and image routes fail closed on invalid provider media state", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const imageRoute = source.slice(
    source.indexOf('router.post("/:contactId/media",'),
    source.indexOf('router.post("/:contactId/voice",')
  );
  const replyHelper = source.slice(
    source.indexOf("async function resolveReplyTarget"),
    source.indexOf("function normalizeSingleByteRange")
  );

  assert.match(imageRoute, /WHATSAPP_IMAGE_MIME_TYPES/);
  assert.match(imageRoute, /WHATSAPP_IMAGE_MAX_BYTES/);
  assert.match(imageRoute, /unsupported_whatsapp_image_type/);
  assert.match(imageRoute, /whatsapp_image_too_large/);
  assert.match(imageRoute, /getMessageMediaReferenceForContact/);
  assert.match(imageRoute, /copyStoredMediaToTemporary/);
  assert.match(imageRoute, /scheduleTemporaryMediaDelete/);
  assert.match(imageRoute, /channelMessaging\.sendImageByUrl/);
  assert.match(
    imageRoute,
    /try \{[\s\S]*getMessageMediaReferenceForContact[\s\S]*copyStoredMediaToTemporary[\s\S]*\} catch \(copyErr\) \{[\s\S]*channelMessaging\.sendImageBuffer/
  );
  assert.match(replyHelper, /target\.role !== "user"/);
  assert.match(replyHelper, /\["failed", "unknown"\]\.includes\(targetDeliveryStatus\)/);
});

test("staff voice sends keep Staff Waiting blocked until the voice reply is persisted", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const voiceRoute = source.slice(
    source.indexOf('router.post("/:contactId/voice",'),
    source.indexOf("module.exports = router;")
  );

  const policyIndex = voiceRoute.indexOf("requireFreeformPolicy");
  const lockIndex = voiceRoute.indexOf("telegramImmediateAlertRepo.withContactAlertLock");
  const prepareIndex = voiceRoute.indexOf("prepareStaffSend");
  const persistIndex = voiceRoute.indexOf("conversationStore.appendMessageForContact");

  assert.ok(policyIndex >= 0 && lockIndex > policyIndex);
  assert.ok(prepareIndex > lockIndex && persistIndex > prepareIndex);
  assert.match(voiceRoute, /transcribeStaffAudio[\s\S]*prepareStaffSend[\s\S]*appendMessageForContact/);
  assert.match(voiceRoute, /voicePreparation\.status === "conversion_failed"/);
  assert.match(voiceRoute, /voicePreparation\.status === "contact_missing"/);
  assert.match(voiceRoute, /requireStaffMode: currentContact\.mode === "human"/);
  assert.doesNotMatch(voiceRoute, /Take over this conversation before sending a voice message/);
});

test("manual WhatsApp templates use Staff Assist without automatic takeover", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const templateRoute = source.slice(
    source.indexOf('router.post("/:contactId/whatsapp-templates/send",'),
    source.indexOf('router.post("/:contactId/messages/:messageId/retry",')
  );

  assert.match(
    templateRoute,
    /telegramImmediateAlertRepo\.withContactAlertLock\(\s*contact\.id,[\s\S]*prepareStaffSend\(\s*contact,[\s\S]*appendMessageForContact/
  );
  assert.doesNotMatch(templateRoute, /contactsRepo\.takeOver/);
  assert.match(
    templateRoute,
    /whatsappTemplate\.sendApprovedTemplate\(preparedContact/
  );
});

test("manual failed-message retry participates in Staff Assist race protection", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const retryRoute = source.slice(
    source.indexOf('router.post("/:contactId/messages/:messageId/retry",'),
    source.indexOf('router.post("/:contactId/messages",')
  );

  assert.match(retryRoute, /isManualStaffRetry/);
  assert.match(
    retryRoute,
    /telegramImmediateAlertRepo\.withContactAlertLock\([\s\S]*prepareStaffSend\([\s\S]*setDeliveryStatusById\([\s\S]*"unknown"/
  );
  assert.match(retryRoute, /finalizeStaffSendState/);
  assert.match(retryRoute, /requireStaffMode: activeContact\.mode === "human"/);
  assert.match(retryRoute, /markLeadContacted\(sendContact\.id/);
});

test("Staff Assist cancellation epochs are bounded in memory", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/aiReplyCancellationService.js"),
    "utf8"
  );
  assert.match(source, /EPOCH_TTL_MS/);
  assert.match(source, /MAX_EPOCH_KEYS/);
  assert.match(source, /function pruneEpochs/);
  assert.match(source, /!pendingEchoes\.has\(key\)/);
});

test("messaging-policy surfaces keep responsive mobile affordances", () => {
  const root = path.join(__dirname, "..");
  const inbox = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Inbox.jsx"), "utf8");
  const details = fs.readFileSync(path.join(root, "portal-frontend/src/components/WhatsAppMessagingDetails.jsx"), "utf8");
  const scheduler = fs.readFileSync(path.join(root, "portal-frontend/src/components/ScheduledInboxMessages.jsx"), "utf8");

  assert.match(inbox, /safe-area-inset-bottom/);
  assert.match(inbox, /min-\[430px\]:inline/);
  assert.match(inbox, /touch-manipulation/);
  assert.match(details, /min-\[400px\]:flex-row/);
  assert.match(details, /grid grid-cols-2/);
  assert.match(scheduler, /max-h-\[92dvh\]/);
  assert.match(scheduler, /pb-\[env\(safe-area-inset-bottom\)\]/);
});
