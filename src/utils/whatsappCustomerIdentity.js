"use strict";

const { normalizeWhatsappNumber } = require("./whatsappPhoneNormalization");

// An opaque Meta business-scoped user ID is NOT a username or a phone.
// Preserve the exact country prefix and case. Never strip non-digits from it.
const BSUID_RE = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
const PHONE_RE = /^[0-9]{8,15}$/;

function isBsuid(value) {
  return typeof value === "string" && BSUID_RE.test(value);
}
function normalizeCustomerAddress(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (isBsuid(input)) return input;
  if (!/^[+\d\s().-]+$/.test(input)) return null;
  const phone = normalizeWhatsappNumber(input);
  return PHONE_RE.test(phone) ? phone : null;
}
function isPhoneAddress(value) {
  return typeof value === "string" && PHONE_RE.test(value);
}
function normaliseUserId(value) {
  return isBsuid(value) ? value : null;
}
function safeUsername(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return /^@?[A-Za-z0-9._]{3,64}$/.test(candidate) ? candidate : null;
}
function whatsappRecipientFields(address) {
  const verified = normalizeCustomerAddress(address);
  if (!verified || verified !== address) throw new TypeError("Invalid WhatsApp recipient identity.");
  // Meta Cloud API: to is a telephone, recipient is a BSUID.
  return isBsuid(verified) ? { recipient: verified } : { to: verified };
}
function verifiedRecipientForContact(contact) {
  const canonical = normalizeCustomerAddress(contact?.whatsapp_number);
  const last = normalizeCustomerAddress(contact?.whatsapp_last_customer_address);
  if (last && (!isBsuid(last) || last === contact?.whatsapp_user_id)) {
    return last;
  }
  return canonical;
}
function inboundIdentityKind(value) {
  return isBsuid(value) ? "bsuid" : isPhoneAddress(value) ? "phone" : "invalid";
}

module.exports = {
  isBsuid, normalizeCustomerAddress, isPhoneAddress,
  normaliseUserId, safeUsername, whatsappRecipientFields,
  verifiedRecipientForContact, inboundIdentityKind,
};
