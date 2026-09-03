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

test("blocks any outbound message immediately after an opt-out", () => {
  const optOutAt = new Date("2026-09-03T10:00:00.000Z");
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: optOutAt,
      latest_inbound_at: optOutAt,
    },
    new Date("2026-09-03T10:01:00.000Z")
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "opted_out");
});

test("allows service replies when the customer starts a new chat after opting out", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose: "service" }
  );

  assert.equal(result.allowed, true);
});

test("keeps automated marketing blocked after opt-out even if customer later asks for support", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose: "marketing" }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "opted_out");
});

test("still blocks service replies when the 24-hour customer window has expired", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: null,
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T10:00:00.000Z")
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_customer_service_window");
});
