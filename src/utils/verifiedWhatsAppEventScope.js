"use strict";

// Only label events with a sender after existing authoritative verification.
// Never infer ownership from a contact ID, message ID, recipient number,
// WAMID prefix or default primary routing. Unknown ownership remains unscoped.
function configuredVerifiedScope(phone, account, env = process.env) {
  const receivedPhone = String(phone || "").trim();
  const receivedAccount = String(account || "").trim();
  if (!/^[0-9]+$/.test(receivedPhone) || !/^[0-9]+$/.test(receivedAccount)) return null;

  const primaryPhone = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const primaryAccount = String(env.WHATSAPP_WABA_ID || "").trim();
  const secondaryPhone = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim();
  const secondaryAccount = String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim();
  if (primaryPhone && primaryAccount &&
      receivedPhone === primaryPhone && receivedAccount === primaryAccount &&
      receivedPhone !== secondaryPhone) {
    return { channel: "whatsapp", businessPhoneNumberId: primaryPhone };
  }
  if (secondaryPhone && secondaryAccount &&
      receivedPhone === secondaryPhone && receivedAccount === secondaryAccount &&
      receivedPhone !== primaryPhone) {
    return { channel: "whatsapp", businessPhoneNumberId: secondaryPhone };
  }
  return null;
}

// Contact rows already carrying a persisted sender account and phone can be
// scoped without an additional database query. Legacy rows remain unknown.
function scopeForPersistedContact(contact, env = process.env) {
  const channel = contact?.channel;
  if (channel === "facebook" || channel === "instagram") return { channel };
  if (channel !== "whatsapp") return {};
  return configuredVerifiedScope(
    contact.whatsapp_sender_phone_number_id,
    contact.whatsapp_sender_account_id,
    env
  ) || { channel: "whatsapp" };
}

// Durable Meta status jobs have been checked against their saved WAMID's
// persisted sender by verifyJobSender BEFORE the status is applied. Never
// trust the raw webhook field when that check is absent or inconclusive.
function scopeForVerifiedDeliveryJob(job, verification, env = process.env) {
  if (env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      verification?.matched !== true) return { channel: "whatsapp" };
  return configuredVerifiedScope(
    job?.business_phone_number_id,
    job?.business_account_id,
    env
  ) || { channel: "whatsapp" };
}

module.exports = {
  configuredVerifiedScope,
  scopeForPersistedContact,
  scopeForVerifiedDeliveryJob,
};
