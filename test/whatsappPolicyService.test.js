const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../src/services/whatsappPolicyService");

test("detects common WhatsApp opt-out requests in supported chat languages", () => {
  const optOuts = [
    "STOP",
    "unsubscribe",
    "don't message me",
    "Please stop messaging me",
    "不要再发消息",
    "不要联系我",
    "jangan mesej saya",
    "tak nak whatsapp",
  ];

  for (const text of optOuts) {
    assert.equal(policy.isOptOutText(text), true, text);
  }
});

test("does not treat normal customer messages as opt-out requests", () => {
  const normalMessages = [
    "what is the price?",
    "can I book Saturday?",
    "stop by at 3pm can?",
    "jangan risau",
    "可以联系我吗",
  ];

  for (const text of normalMessages) {
    assert.equal(policy.isOptOutText(text), false, text);
  }
});
