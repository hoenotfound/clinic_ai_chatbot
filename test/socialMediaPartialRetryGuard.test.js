const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("failed social image retries preserve a delivered caption marker and skip resending it", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"),
    "utf8"
  );
  const messagingSource = fs.readFileSync(
    path.join(__dirname, "../src/services/channelMessagingService.js"),
    "utf8"
  );

  assert.match(routeSource, /PARTIAL_CAPTION_ERROR_PREFIX/);
  assert.match(routeSource, /hasPartialCaptionMarker\(message\.delivery_error\)/);
  assert.match(routeSource, /socialProviderSendOptions\(message, contact, \{ skipCaption \}\)/);
  assert.match(routeSource, /deliveryErrorForSend\([\s\S]*message\.delivery_error/);

  assert.match(messagingSource, /options\.skipCaption !== true/);
  assert.match(messagingSource, /partialCaptionSent: true/);
  assert.match(messagingSource, /captionProviderMessageId/);
});
