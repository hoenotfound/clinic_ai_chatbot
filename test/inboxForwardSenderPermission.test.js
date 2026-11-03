"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canForwardBetweenInboxContacts: allowed } = require("../src/utils/inboxForwardSenderPermission");

const env = {
  WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED: "true",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_WABA_ID: "1593376338308612",
  WHATSAPP_SECONDARY_SENDER_KEY: "neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID: "1852014482431209",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE: "primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED: "true",
};
const primary = { id: 1, channel: "whatsapp", whatsapp_sender_id: 1, whatsapp_sender_key: env.WHATSAPP_PRIMARY_SENDER_KEY,
  whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID, whatsapp_sender_account_id: env.WHATSAPP_WABA_ID };
const secondary = { id: 2, channel: "whatsapp", whatsapp_sender_id: 2, whatsapp_sender_key: env.WHATSAPP_SECONDARY_SENDER_KEY,
  whatsapp_sender_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, whatsapp_sender_account_id: env.WHATSAPP_SECONDARY_WABA_ID };
const legacy = { id: 3, channel: "whatsapp", whatsapp_sender_id: null };
const outsider = { id: 4, channel: "whatsapp", whatsapp_sender_id: 3, whatsapp_sender_key: "other",
  whatsapp_sender_phone_number_id: "999", whatsapp_sender_account_id: "888" };
test("Neutro primary to secondary and secondary to primary require explicit approval", () => {
  assert.equal(allowed(primary, secondary, env), true);
  assert.equal(allowed(secondary, primary, env), true);
  assert.equal(allowed(legacy, secondary, env), true);
  assert.equal(allowed(secondary, legacy, env), true);
  assert.equal(allowed(primary, secondary, { ...env, WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED: "false" }), false);
  assert.equal(allowed(primary, secondary, { ...env, WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED: "false" }), false);
});
test("same sender still works; other channels and senders remain isolated", () => {
  assert.equal(allowed(primary, { ...primary, id: 5 }, { ...env, WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED: "false" }), true);
  assert.equal(allowed(legacy, { ...legacy, id: 6 }, env), true);
  assert.equal(allowed(primary, outsider, env), false);
  assert.equal(allowed(outsider, secondary, env), false);
  assert.equal(allowed(primary, { ...secondary, channel: "facebook" }, env), false);
  assert.equal(allowed({ id: 1, channel: "facebook" }, { id: 2, channel: "facebook" }, env), true);
});
test("rejects incomplete, mismatched, spoofed or disabled cross-number identity", () => {
  assert.equal(allowed(primary, { ...secondary, whatsapp_sender_account_id: "mismatch" }, env), false);
  assert.equal(allowed(primary, { ...secondary, whatsapp_sender_phone_number_id: "" }, env), false);
  assert.equal(allowed(primary, { ...secondary, whatsapp_sender_id: null }, env), false);
  assert.equal(allowed({ ...legacy, whatsapp_sender_key: "spoof" }, secondary, env), false);
  assert.equal(allowed(primary, secondary, { ...env, WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "false" }), false);
  assert.equal(allowed(primary, secondary, { ...env, WHATSAPP_SECONDARY_SENDER_KEY: "another_client" }), false);
  assert.equal(allowed(primary, secondary, { ...env, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID }), false);
});
