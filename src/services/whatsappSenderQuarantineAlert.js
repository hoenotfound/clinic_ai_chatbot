"use strict";

// Operator notification for misrouted WhatsApp events. Deliberately excludes
// customer phone numbers, message content, Meta tokens, and raw webhooks.
// Throttling is per process; the durable quarantine table is the audit source.
const { isTelegramEnabled, postTelegramMessage } = require("./telegramAlertService");

const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const lastNotified = new Map();
const MAX_ALERT_KEYS = 100;

async function notifyWhatsAppSenderQuarantine(quarantined, {
  env = process.env,
  now = Date.now(),
  post = postTelegramMessage,
  logger = console,
} = {}) {
  if (!Array.isArray(quarantined) || !quarantined.length) return false;

  // The secondary Inbox-only boundary temporarily audits signed delivery
  // statuses as unsupported while its separate receipt handler is OFF.
  // Those expected receipts must not generate a customer-routing alarm.
  // Require an internal marker AND exact sender identity; an unsupported
  // event with only matching metadata is never enough to suppress an alert.
  const reportable = quarantined.filter(item => !(
    item.expectedSecondaryStatus === true &&
    item.reason === "unsupported_whatsapp_event" &&
    item.field === "messages" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED !== "true" &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID || "")) &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "")) &&
    item.accountId === env.WHATSAPP_SECONDARY_WABA_ID &&
    item.phoneNumberId === env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID
  ));
  // The caller has already recorded every quarantined event in the durable
  // audit; filtering here only affects operator warnings and Telegram.
  if (!reportable.length) return false;
  const reasons = [...new Set(reportable.map(item => item.reason))].sort();
  const key = reasons.join(",");
  logger.warn(
    `[WhatsApp sender quarantine] ${reportable.length} event(s) isolated; reasons=${key}. `
    + "Investigate account callback overrides; affected events did not enter the Inbox."
  );
  if (!isTelegramEnabled(env)) return false;
  if ((lastNotified.get(key) || 0) + NOTIFY_COOLDOWN_MS > now) return false;
  if (lastNotified.size >= MAX_ALERT_KEYS) lastNotified.clear();
  lastNotified.set(key, now);
  try {
    await post({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      text: `⚠️ WhatsApp business-number routing alert\n`
        + `${reportable.length} callback event(s) were isolated.\n`
        + `Reasons: ${reasons.join(", ")}\n`
        + "Review Meta's account-specific webhook override and the quarantined-event audit. "
        + "The events were NOT delivered to an Inbox; after correcting the route, "
        + "ask the customer to send a new message if needed.",
    });
    return true;
  } catch (error) {
    logger.error("[WhatsApp sender quarantine] Telegram operational alert failed:", error);
    return false;
  }
}

module.exports = { notifyWhatsAppSenderQuarantine };
