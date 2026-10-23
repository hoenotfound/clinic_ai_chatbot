"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const cancellation = require("../src/services/aiReplyCancellationService");

test("unchanged legacy WhatsApp cancellation identity", () => {
  assert.equal(cancellation.keyForWhatsAppNumber("60123001234"), "whatsapp:60123001234");
  assert.equal(cancellation.keyForContact({ channel: "whatsapp", whatsapp_number: "60123001234" }),
    "whatsapp:60123001234");
});

test("same customer on two senders has isolated AI cancellation and Business App echoes", () => {
  const first = cancellation.keyForWhatsAppNumber("60123001234", "neutro");
  const second = cancellation.keyForWhatsAppNumber("+60 12 300 1234", "ariel");
  const beforeFirst = cancellation.snapshot(first);
  const beforeSecond = cancellation.snapshot(second);
  cancellation.cancel(first);
  assert.equal(cancellation.cancelledSince(first, beforeFirst), true);
  assert.equal(cancellation.cancelledSince(second, beforeSecond), false);
  cancellation.beginPendingEcho(first, "echo-1");
  assert.equal(cancellation.hasPendingEcho(second), false);
  cancellation.endPendingEcho(first, "echo-1");
  assert.equal(cancellation.keyForContact({
    channel: "whatsapp", whatsapp_number: "60123001234", whatsapp_sender_key: "ariel",
  }), second);
});

test("malformed sender keys cannot silently cancel a legacy customer", () => {
  assert.throws(() => cancellation.keyForWhatsAppNumber("60123001234", "bad sender"));
});
