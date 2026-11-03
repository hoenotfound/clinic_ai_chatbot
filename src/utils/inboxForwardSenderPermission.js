"use strict";

const { secondaryUsesPrimaryClinicContent } = require("../services/whatsappSenderActivationGate");

const clean = value => String(value || "").trim();
const numeric = value => /^[0-9]+$/.test(clean(value));

function configuredSender(contact, kind, env) {
  const primary = kind === "primary";
  const key = clean(env[primary ? "WHATSAPP_PRIMARY_SENDER_KEY" : "WHATSAPP_SECONDARY_SENDER_KEY"]);
  const phone = clean(env[primary ? "WHATSAPP_PHONE_NUMBER_ID" : "WHATSAPP_SECONDARY_PHONE_NUMBER_ID"]);
  const account = clean(env[primary ? "WHATSAPP_WABA_ID" : "WHATSAPP_SECONDARY_WABA_ID"]);
  if (!key || !numeric(phone) || !numeric(account)) return false;

  // Migration 080 deliberately retained historical primary WhatsApp contacts
  // with a null sender ID. They can only be the primary in a sender-scoped
  // Neutro deployment, never an arbitrary secondary or a guessed sender.
  if (primary && contact?.whatsapp_sender_id == null) {
    return !contact.whatsapp_sender_key &&
      !contact.whatsapp_sender_phone_number_id &&
      !contact.whatsapp_sender_account_id;
  }
  if (!Number.isSafeInteger(Number(contact?.whatsapp_sender_id)) ||
      Number(contact.whatsapp_sender_id) <= 0) return false;
  return clean(contact.whatsapp_sender_key) === key &&
    clean(contact.whatsapp_sender_phone_number_id) === phone &&
    clean(contact.whatsapp_sender_account_id) === account;
}

// A forwarding target is a new, sender-scoped outbound message, NOT a relay
// from the source number. All recipient policy and provider gates still apply.
function canForwardBetweenInboxContacts(source, target, env = process.env) {
  if (!source || !target) return false;
  const sourceChannel = source.channel || "whatsapp";
  const targetChannel = target.channel || "whatsapp";
  if (sourceChannel !== targetChannel) return false;
  if (sourceChannel !== "whatsapp") return true;

  // Preserve existing same-number behavior without changing legacy contacts.
  if (clean(source.whatsapp_sender_id) === clean(target.whatsapp_sender_id)) return true;

  // Explicitly opt in only the Neutro deployment. Sharing clinic content
  // alone is not permission to forward customer messages across senders.
  if (env.WHATSAPP_INBOX_CROSS_NUMBER_FORWARD_ENABLED !== "true" ||
      env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED !== "true" ||
      !secondaryUsesPrimaryClinicContent(env) ||
      env.WHATSAPP_PRIMARY_SENDER_KEY !== "neutro" ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      !numeric(env.WHATSAPP_PHONE_NUMBER_ID) ||
      !numeric(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
      clean(env.WHATSAPP_PHONE_NUMBER_ID) === clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) return false;

  return (configuredSender(source, "primary", env) && configuredSender(target, "secondary", env)) ||
    (configuredSender(source, "secondary", env) && configuredSender(target, "primary", env));
}

module.exports = { canForwardBetweenInboxContacts };
