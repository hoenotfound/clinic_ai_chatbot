"use strict";

// Shared, side-effect-free customer phone canonicalization for WhatsApp.
// Keep this behavior in sync with historical contacts so new sender-specific
// identities never fork an existing Malaysian customer on input formatting.
function normalizeWhatsappNumber(input) {
  let digits = String(input || "").replace(/[^\d]/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // "+60 012..." commonly contains both Malaysia's country code and trunk 0.
  if (digits.startsWith("600")) {
    digits = `60${digits.slice(3)}`;
  }

  if (digits.startsWith("0")) {
    return `60${digits.slice(1)}`;
  }

  if (/^1\d{8,9}$/.test(digits)) {
    return `60${digits}`;
  }

  return digits;
}

module.exports = { normalizeWhatsappNumber };
