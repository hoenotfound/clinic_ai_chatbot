"use strict";

// These switches may NOT be enabled piecemeal. The existing single-number
// deployment remains unchanged when sender-scoped ingress is disabled.
function assertSenderIngressSafety(env = process.env) {
  if (env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED !== "true") return;
  if (env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_STRICT_METADATA !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED !== "true" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_PRIMARY_SENDER_KEY || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_WABA_ID || ""))) {
    throw new Error("Unsafe WhatsApp sender activation: scoped ingress requires verified " +
      "primary sender key/account/phone and strict Meta metadata/account guards.");
  }
}
module.exports = { assertSenderIngressSafety };
