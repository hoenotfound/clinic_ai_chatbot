const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  deliveryErrorForSend,
  publicDeliveryError,
} = require("../src/utils/socialDeliveryError");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("failed social image retries preserve a delivered caption marker and skip resending it", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const messagingSource = fs.readFileSync(
    path.join(__dirname, "../src/services/channelMessagingService.js"),
    "utf8"
  );

  assert.match(routeSource, /require\("\.\.\/utils\/socialDeliveryError"\)/);
  assert.match(routeSource, /hasPartialCaptionMarker\(message\.delivery_error\)/);
  assert.match(routeSource, /socialProviderSendOptions\(message, contact, \{ skipCaption \}\)/);
  assert.match(routeSource, /deliveryErrorForSend\([\s\S]*message\.delivery_error/);

  assert.match(messagingSource, /options\.skipCaption !== true/);
  assert.match(messagingSource, /partialCaptionSent: true/);
  assert.match(messagingSource, /captionProviderMessageId/);

  const helperSource = read("src/utils/socialDeliveryError.js");
  assert.match(helperSource, /PARTIAL_CAPTION_ERROR_PREFIX/);
  assert.match(helperSource, /function publicDeliveryError/);

  const serverSource = read("src/server.js");
  assert.match(serverSource, /deliveryErrorForSend\([\s\S]*promoResult/);
  assert.match(serverSource, /publicDeliveryError\(promoError\)/);

  const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");
  assert.match(inboxSource, /function displayDeliveryError/);
  assert.match(inboxSource, /The caption was sent, but the image failed to send/);
});


test("successful sends preserve the null delivery-error API contract", () => {
  assert.equal(
    deliveryErrorForSend({ success: true }, "This fallback must be ignored."),
    null
  );
  assert.equal(publicDeliveryError(null), null);
});
