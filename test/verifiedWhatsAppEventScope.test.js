"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  scopeForPersistedContact,
  scopeForVerifiedDeliveryJob,
  configuredVerifiedScope,
} = require("../src/utils/verifiedWhatsAppEventScope");
const { secondaryEventRequiresWake } = require("../src/utils/secondaryDueTimeScheduler");

const env = Object.freeze({
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_WABA_ID: "1593376338308612",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID: "1852014482431209",
});

test("persisted primary and secondary sender IDs prevent unrelated secondary SQL wakeups", () => {
  const primary = scopeForPersistedContact({
    channel: "whatsapp", whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
    whatsapp_sender_account_id: env.WHATSAPP_WABA_ID,
  }, env);
  assert.deepEqual(primary, { channel: "whatsapp", businessPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID });
  assert.equal(secondaryEventRequiresWake("conversation_changed", {
    ...primary, reason: "message",
  }, env), false);
  assert.equal(secondaryEventRequiresWake("conversation_changed", {
    ...primary, reason: "delivery_status",
  }, env), false);

  const secondary = scopeForPersistedContact({
    channel: "whatsapp",
    whatsapp_sender_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    whatsapp_sender_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
  }, env);
  assert.deepEqual(secondary, { channel: "whatsapp",
    businessPhoneNumberId: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID });
  assert.equal(secondaryEventRequiresWake("conversation_changed", {
    ...secondary, reason: "message",
  }, env), true);
  assert.equal(secondaryEventRequiresWake("conversation_changed", {
    ...secondary, reason: "delivery_status",
  }, env), true);
});

test("legacy, missing or mismatched contact sender must keep conservative wake path", () => {
  for (const contact of [
    { channel: "whatsapp" },
    { channel: "whatsapp", whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
    { channel: "whatsapp", whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      whatsapp_sender_account_id: env.WHATSAPP_SECONDARY_WABA_ID },
    { channel: "whatsapp", whatsapp_sender_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      whatsapp_sender_account_id: env.WHATSAPP_WABA_ID },
  ]) {
    const scope = scopeForPersistedContact(contact, env);
    assert.deepEqual(scope, { channel: "whatsapp" });
    assert.equal(secondaryEventRequiresWake("conversation_changed",
      { ...scope, reason: "booking_confirmed" }, env), true);
  }
  assert.deepEqual(scopeForPersistedContact({ channel: "facebook" }, env),
    { channel: "facebook" });
  assert.equal(secondaryEventRequiresWake("conversation_changed",
    { ...scopeForPersistedContact({ channel: "facebook" }, env), reason: "message" }, env), false);
});

test("durable statuses are scoped only after database verified WAMID sender", () => {
  const primaryJob = {
    business_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
    business_account_id: env.WHATSAPP_WABA_ID,
  };
  assert.deepEqual(scopeForVerifiedDeliveryJob(primaryJob, { matched: true }, env),
    { channel: "whatsapp", businessPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID });
  assert.deepEqual(scopeForVerifiedDeliveryJob({
    business_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    business_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
  }, { matched: true }, env), {
    channel: "whatsapp", businessPhoneNumberId: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  });
  for (const verification of [null, {}, { matched: false }, { matched: null }]) {
    assert.deepEqual(scopeForVerifiedDeliveryJob(primaryJob, verification, env),
      { channel: "whatsapp" }, "unverified Meta webhook cannot assert sender identity");
  }
  assert.deepEqual(scopeForVerifiedDeliveryJob(primaryJob, { matched: true }, {
    ...env, WHATSAPP_MULTI_NUMBER_READ_ENABLED: "false",
  }), { channel: "whatsapp" });
  assert.deepEqual(scopeForVerifiedDeliveryJob({
    ...primaryJob, business_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
  }, { matched: true }, env), { channel: "whatsapp" });
  assert.equal(configuredVerifiedScope(null, env.WHATSAPP_WABA_ID, env), null);
});

test("missing verified sender does not suppress real opt-outs or bookings", () => {
  const unknown = scopeForVerifiedDeliveryJob({}, { matched: true }, env);
  for (const reason of ["message", "delivery_status", "whatsapp_opt_out", "booking_confirmed"]) {
    assert.equal(secondaryEventRequiresWake("conversation_changed",
      { ...unknown, reason }, env), true);
  }
});

test("contact change publishers reuse persisted sender without new SQL or inferred ownership", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/db/contactsRepo.js"), "utf8");
  const start = source.indexOf("function publishContactChange(");
  const end = source.indexOf("function notifyTelegram(", start);
  const publishBody = source.slice(start, end);
  assert.match(publishBody, /scopeForPersistedContact\(contact\)/);
  assert.doesNotMatch(publishBody, /pool\.query|SELECT|businessPhoneNumberId:.*WHATSAPP_PHONE_NUMBER_ID/);
  assert.match(source, /publishContactChange\(updated\.id, \{ contact: updated \}\)/);
  assert.match(source, /publishContactChange\(row\.contact_id \|\| row\.id, \{ profileOnly: true, contact: row \}\)/);
  const unknown = scopeForPersistedContact({ id: 42, channel: "whatsapp" }, env);
  assert.deepEqual(unknown, { channel: "whatsapp" });
  assert.equal(secondaryEventRequiresWake("conversation_changed",
    { ...unknown, reason: "booking_confirmed" }, env), true,
    "unknown sender still permits time-critical secondary follow-up checks");
});
