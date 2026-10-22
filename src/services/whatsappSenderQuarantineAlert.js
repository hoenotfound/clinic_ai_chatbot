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
  const reasons = [...new Set(quarantined.map(item => item.reason))].sort();
  const key = reasons.join(",");
  logger.warn(
    `[WhatsApp sender quarantine] ${quarantined.length} event(s) isolated; reasons=${key}. `
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
        + `${quarantined.length} callback event(s) were isolated.\n`
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
