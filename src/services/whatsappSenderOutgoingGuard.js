"use strict";

// Fail-closed bridge while the production sender remains single-number.
// An explicitly tagged second-number conversation must never be transmitted
// from the legacy WHATSAPP_PHONE_NUMBER_ID or share its billing reservation.
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function senderMismatchResult() {
  return {
    success: false,
    wamid: null,
    policyBlocked: true,
    retryable: false,
    code: "whatsapp_sender_not_ready",
    error: "Sending is disabled for this WhatsApp business number until sender-specific credentials, billing and routing are verified.",
  };
}

function blockUnverifiedOutgoingSender(contact, options = {}, env = process.env) {
  if (contact?.channel && contact.channel !== "whatsapp") return null;
  const senderKeys = [contact?.whatsapp_sender_key, contact?.sender_key, options?.senderKey]
    .map(clean).filter(Boolean);
  const phones = [
    contact?.whatsapp_sender_phone_number_id,
    contact?.businessPhoneNumberId,
    options?.businessPhoneNumberId,
    options?.senderPhoneNumberId,
  ].map(clean).filter(Boolean);
  const accounts = [contact?.businessAccountId, options?.businessAccountId]
    .map(clean).filter(Boolean);

  if (!senderKeys.length && !phones.length && !accounts.length) return null;
  const primaryPhone = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  const primaryKey = clean(env.WHATSAPP_PRIMARY_SENDER_KEY);
  const primaryAccount = clean(env.WHATSAPP_WABA_ID);

  // Require matching explicit identity. An account ID alone never selects a
  // sender, and a phone mismatch must be rejected BEFORE policy and Meta sends.
  if (!primaryPhone || !phones.length || phones.some(id => id !== primaryPhone)) {
    return senderMismatchResult();
  }
  if (senderKeys.length && (!primaryKey || senderKeys.some(key => key !== primaryKey))) {
    return senderMismatchResult();
  }
  if (accounts.length && (!primaryAccount || accounts.some(id => id !== primaryAccount))) {
    return senderMismatchResult();
  }
  return null;
}

module.exports = { blockUnverifiedOutgoingSender, senderMismatchResult };
