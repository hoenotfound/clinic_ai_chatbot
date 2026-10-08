const test = require("node:test");
const assert = require("node:assert/strict");
const { canSendAfterFinal, statusForPricingSend } = require("../src/services/pricingReminderService");
const { eligibleSql, MINUTES_AFTER_TESTIMONIAL } = require("../src/db/pricingReminderRepo");

test("pricing cannot run until five minutes AFTER a sent testimonial", () => {
  const candidate = {
    third_accepted_at: "2026-10-08T10:00:00Z",
    inbound_at: "2026-10-08T00:00:00Z",
  };
  assert.equal(MINUTES_AFTER_TESTIMONIAL, 5);
  assert.equal(canSendAfterFinal(candidate, new Date("2026-10-08T10:04:59Z")), false);
  assert.equal(canSendAfterFinal(candidate, new Date("2026-10-08T10:05:00Z")), true);
  assert.equal(canSendAfterFinal(candidate, new Date("2026-10-08T10:35:00Z")), true);
  assert.equal(canSendAfterFinal({ ...candidate, third_accepted_at:null }), false);
  assert.equal(canSendAfterFinal({ ...candidate, inbound_at:null }), false);
});

test("pricing never starts at or after the 23h50 window-safety deadline", () => {
  const inbound_at="2026-10-08T00:00:00Z";
  assert.equal(canSendAfterFinal({
    inbound_at, third_accepted_at:"2026-10-08T23:35:00Z",
  },new Date("2026-10-08T23:40:00Z")),true);
  assert.equal(canSendAfterFinal({
    inbound_at, third_accepted_at:"2026-10-08T23:45:00Z",
  },new Date("2026-10-08T23:50:00Z")),false);
  assert.equal(canSendAfterFinal({
    inbound_at, third_accepted_at:"2026-10-08T23:49:00Z",
  },new Date("2026-10-08T23:54:00Z")),false);
});

test("pricing eligibility is tied to the ACTUAL accepted Follow-up 3, never the scheduled estimate", () => {
  const expr=eligibleSql();
  assert.match(expr,/automated_follow_up_step = 3/);
  assert.match(expr,/delivery_status IN \('sent', 'delivered', 'read'\)/);
  assert.match(expr,/pending.*whatsapp_message_id IS NOT NULL/);
  assert.match(expr,/whatsapp_accepted_at IS NOT NULL/);
  assert.match(expr,/third\.whatsapp_accepted_at \+ interval '5 minutes' AS due_at/);
  assert.doesNotMatch(expr,/final_due_at|second\.created_at|third\.id IS NULL/);
  assert.match(expr,/inbound_at \+ interval '23 hours 50 minutes'/);
});

test("ambiguous provider timeouts remain unconfirmed, not failed", () => {
  assert.equal(statusForPricingSend({success:false,unknown:true,ambiguous:true}),"unknown");
  assert.equal(statusForPricingSend({success:false,ambiguous:true}),"unknown");
  assert.equal(statusForPricingSend({success:false,error:"WhatsApp rejected"}),"failed");
  assert.equal(statusForPricingSend({success:true}),"sent");
});
