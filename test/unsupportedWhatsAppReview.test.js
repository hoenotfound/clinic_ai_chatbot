"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatUnsupportedReview } = require("../src/utils/unsupportedWhatsAppReview");

test("Meta 131060 gives clear staff guidance without an automated reply", () => {
  const message = formatUnsupportedReview({
    channelLabel: "WhatsApp",
    unsupportedType: "unsupported",
    detail: { code: 131060, details: "This message is currently unavailable." },
  });
  assert.match(message, /WhatsApp message unavailable \(Meta 131060\)/);
  assert.match(message, /WhatsApp Business app/);
  assert.match(message, /check the original message in the WhatsApp Business app/);
  assert.doesNotMatch(message, /resend/i);
  assert.doesNotMatch(message, /AI is enabled|automatically send/i);
});

test("other Meta errors keep their meaning and readable whitespace", () => {
  const message = formatUnsupportedReview({
    channelLabel: "WhatsApp",
    unsupportedType: "unsupported",
    detail: { code: 131051, details: "This message is\r\ncurrently\tunavailable." },
  });
  assert.equal(message,
    "Unsupported WhatsApp message (unsupported). Meta 131051. This message is currently unavailable.");
});

test("missing errors do not manufacture a Meta code", () => {
  assert.equal(formatUnsupportedReview({
    channelLabel: "WhatsApp", unsupportedType: "unknown", detail: {},
  }), "Unsupported WhatsApp message (unknown). Meta code unavailable.");
});

test("Meta 131060 advice is not applied to other channels", () => {
  assert.match(formatUnsupportedReview({
    channelLabel: "Messenger", unsupportedType: "unsupported", detail: { code: 131060 },
  }), /^Unsupported Messenger message/);
});
