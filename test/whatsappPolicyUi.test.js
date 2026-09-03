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

  const instagram = messagingPolicyStatus({
    channel: "instagram",
    latest_inbound_at: "2026-09-02T10:30:00.000Z",
  }, now);
  assert.equal(instagram.applies, true);
  assert.equal(instagram.freeformAllowed, false);
  assert.equal(instagram.channelLabel, "Instagram");

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
  const tools = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Tools.jsx"), "utf8");
  const leadDrawer = fs.readFileSync(path.join(root, "portal-frontend/src/components/pipeline/LeadDrawer.jsx"), "utf8");

  assert.doesNotMatch(inbox, /Sending unavailable\./);
  assert.match(inbox, /quietReplyAvailable/);
  assert.match(inbox, /Cannot retry/);
  assert.match(inbox, /must message the business before staff can send a normal reply/);
  assert.match(details, /policy\.channelLabel} reply window/);
  assert.match(details, /Standard 24-hour reply-window status/);
  assert.match(details, /Opt-in date \/ source/);
  assert.match(details, /Opt-out date \/ source/);
  assert.match(tools, /Messenger, and Instagram follow-ups/);
  assert.match(tools, /WhatsApp opt-outs remain a hard stop/);
  assert.match(leadDrawer, /CRM marketing consent/);
  assert.match(leadDrawer, /does not record the dedicated WhatsApp opt-in/);
});

test("staff send routes check channel policy before automatic takeover", () => {
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

  assert.ok(textRoute.indexOf("requireFreeformPolicy") < textRoute.indexOf("contactsRepo.takeOver"));
  assert.ok(imageRoute.indexOf("requireFreeformPolicy") < imageRoute.indexOf("contactsRepo.takeOver"));
  assert.match(source, /channelMessaging\.sendText/);
  assert.match(source, /channelMessaging\.sendImageBuffer/);
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
