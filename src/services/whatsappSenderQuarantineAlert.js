"use strict";

// Operator alerts deliberately exclude customer data, raw Meta webhook bodies
// and tokens. Every isolated callback is still recorded by the caller.
const { isTelegramEnabled, postTelegramMessage } = require("./telegramAlertService");

const ROUTING_REPEAT_MS = 24 * 60 * 60 * 1000;
const DELIVERY_SUMMARY_MS = 10 * 60 * 1000;
const AUDIT_FAILURE_REPEAT_MS = 10 * 60 * 1000;
const MAX_ALERT_KEYS = 1000;
const recentlySent = new Map();
const pending = new Set();

function isVerifiedSecondaryStatus(item, env) {
  return item.reason === "unsupported_whatsapp_event" &&
    item.field === "messages" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED !== "true" &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID || "")) &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "")) &&
    item.accountId === env.WHATSAPP_SECONDARY_WABA_ID &&
    item.phoneNumberId === env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
}

function eventKey(item, category) {
  // A genuine second routing incident must not be hidden merely because its
  // reason matches a preceding incident. An unknown fingerprint fails open:
  // it is reported rather than silently grouped by an imprecise reason.
  if (typeof item.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.fingerprint)) return null;
  return [
    category, item.fingerprint, item.reason,
    item.field, item.accountId || "", item.phoneNumberId || "",
  ].join(":");
}

function pruneSent(now) {
  for (const [key, expiresAt] of recentlySent) {
    if (expiresAt <= now) recentlySent.delete(key);
  }
  while (recentlySent.size > MAX_ALERT_KEYS) {
    recentlySent.delete(recentlySent.keys().next().value);
  }
}

async function postNotice(items, {
  category, now, env, post, logger, message,
}) {
  if (!items.length || !isTelegramEnabled(env)) return false;
  pruneSent(now);
  const selected = [];
  const keys = new Set();
  for (const item of items) {
    const key = category === "delivery"
      ? ["delivery", item.accountId || "", item.phoneNumberId || ""].join(":")
      : eventKey(item, category);
    if (key && (pending.has(key) || (recentlySent.get(key) || 0) > now ||
                (category !== "delivery" && keys.has(key)))) continue;
    selected.push(item);
    if (key) keys.add(key);
  }
  if (!selected.length) return false;
  for (const key of keys) pending.add(key);
  try {
    await post({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      text: message(selected),
    });
    const ttl = category === "routing" ? ROUTING_REPEAT_MS
      : category === "delivery" ? DELIVERY_SUMMARY_MS : AUDIT_FAILURE_REPEAT_MS;
    for (const key of keys) recentlySent.set(key, now + ttl);
    pruneSent(now);
    return true;
  } catch (error) {
    // Failed Telegram sends should be retried on another callback, rather
    // than hiding failures under an already-set cooldown.
    logger.error("[WhatsApp sender quarantine] Telegram alert failed:", error);
    return false;
  } finally {
    for (const key of keys) pending.delete(key);
  }
}

async function notifyWhatsAppSenderQuarantine(quarantined, {
  env = process.env,
  now = Date.now(),
  post = postTelegramMessage,
  logger = console,
  auditFailed = false,
} = {}) {
  if (!Array.isArray(quarantined) || !quarantined.length) return false;

  if (auditFailed) {
    const reasons = [...new Set(quarantined.map(item => item.reason))].sort();
    logger.warn("[WhatsApp sender quarantine] Database audit write failed; reasons=" +
      reasons.join(","));
    return postNotice(quarantined, {
      category: "audit", now, env, post, logger,
      message: (events) =>
        "⚠️ WhatsApp webhook quarantine audit failed\n" +
        events.length + " callback event(s) were not recorded successfully.\n" +
        "Reasons: " + [...new Set(events.map(item => item.reason))].sort().join(", ") + "\n" +
        "Review Render errors and the callback response. Do not automatically resend customer messages.",
    });
  }

  const routing = [];
  const deliveryIssues = [];
  for (const item of quarantined) {
    if (isVerifiedSecondaryStatus(item, env)) {
      if (item.expectedSecondaryStatus === true &&
          item.secondaryStatusRequiresReview !== true) {
        // Only known, routine status receipts are quiet. Audit stays intact.
        continue;
      }
      if (item.secondaryStatusRequiresReview === true) {
        deliveryIssues.push(item);
        continue;
      }
    }
    routing.push(item);
  }

  if (routing.length) {
    logger.warn("[WhatsApp sender quarantine] " + routing.length +
      " routing event(s) isolated; reasons=" +
      [...new Set(routing.map(item => item.reason))].sort().join(","));
  }
  if (deliveryIssues.length) {
    // No patient phone, message content or provider receipt ID in logs.
    const refs = deliveryIssues.map(item =>
      typeof item.fingerprint === "string" ? item.fingerprint.slice(0, 12) : "unidentified");
    logger.warn("[WhatsApp secondary delivery status] " + deliveryIssues.length +
      " failed/unrecognized receipt event(s) retained for review; audit refs=" + refs.join(","));
  }

  // Genuine routing events are deduplicated by fingerprint, NOT by reason:
  // independent callback mistakes can both trigger within ten minutes.
  const routingSent = await postNotice(routing, {
    category: "routing", now, env, post, logger,
    message: (events) =>
      "⚠️ WhatsApp business-number routing alert\n" +
      events.length + " callback event(s) were isolated.\n" +
      "Reasons: " + [...new Set(events.map(item => item.reason))].sort().join(", ") + "\n" +
      "Review Meta's account-specific webhook override and the quarantined-event audit. " +
      "These events were NOT delivered to an Inbox; check the original customer message if needed.",
  });

  // Separate, limited notice for failed or unfamiliar secondary delivery
  // statuses. Every instance is still visible in the audit and Render logs.
  // Delivery summaries never suppress genuine routing notifications.
  const deliverySent = await postNotice(deliveryIssues, {
    category: "delivery", now, env, post, logger,
    message: (events) =>
      "⚠️ Secondary WhatsApp delivery status needs review\n" +
      events.length + " failed or unrecognized delivery-status event(s) were isolated.\n" +
      "Review Render's secondary delivery-status logs and the quarantine audit. " +
      "This is not evidence of a missing incoming customer message. Do not resend automatically.",
  });
  return routingSent || deliverySent;
}

module.exports = { notifyWhatsAppSenderQuarantine };