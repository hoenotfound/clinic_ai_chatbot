const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("portal policy state distinguishes open, closed, never-contacted and opted-out WhatsApp chats", async () => {
  const { whatsappPolicyStatus } = await import(
    "../portal-frontend/src/utils/whatsappPolicy.js"
  );
  const now = Date.parse("2026-09-03T12:00:00.000Z");

  const open = whatsappPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-03T10:30:00.000Z",
  }, now);
  assert.equal(open.freeformAllowed, true);
  assert.match(open.label, /Reply available/);

  const closed = whatsappPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-02T10:30:00.000Z",
  }, now);
  assert.equal(closed.code, "outside_customer_service_window");

  const neverMessaged = whatsappPolicyStatus({ channel: "whatsapp" }, now);
  assert.equal(neverMessaged.code, "no_customer_message");

  const optedOut = whatsappPolicyStatus({
    channel: "whatsapp",
    latest_inbound_at: "2026-09-03T11:00:00.000Z",
    whatsapp_opt_out_at: "2026-09-03T11:00:00.000Z",
  }, now);
  assert.equal(optedOut.code, "opted_out");
  assert.equal(optedOut.automatedAllowed, false);

  const social = whatsappPolicyStatus({ channel: "instagram" }, now);
  assert.equal(social.applies, false);
  assert.equal(social.freeformAllowed, true);
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
  assert.equal(
    policyFailureExplanation({ delivery_error: "Meta temporarily rejected the request." }),
    null
  );
});

test("Inbox and contact details expose the required WhatsApp policy guidance", () => {
  const root = path.join(__dirname, "..");
  const inbox = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Inbox.jsx"), "utf8");
  const details = fs.readFileSync(path.join(root, "portal-frontend/src/components/WhatsAppMessagingDetails.jsx"), "utf8");
  const tools = fs.readFileSync(path.join(root, "portal-frontend/src/pages/Tools.jsx"), "utf8");
  const leadDrawer = fs.readFileSync(path.join(root, "portal-frontend/src/components/pipeline/LeadDrawer.jsx"), "utf8");

  assert.match(inbox, /Sending unavailable/);
  assert.match(inbox, /Cannot retry/);
  assert.match(inbox, /must message the business before staff can send a normal reply/);
  assert.match(details, /WhatsApp messaging/);
  assert.match(details, /Opt-in date \/ source/);
  assert.match(details, /Opt-out date \/ source/);
  assert.match(tools, /never after the customer opts out/);
  assert.match(leadDrawer, /CRM marketing consent/);
  assert.match(leadDrawer, /does not record the dedicated WhatsApp opt-in/);
});

test("staff send routes check WhatsApp policy before automatic takeover", () => {
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

test("WhatsApp policy surfaces keep responsive mobile affordances", () => {
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
