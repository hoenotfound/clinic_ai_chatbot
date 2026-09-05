const crypto = require("crypto");
const { pool } = require("../db/db");
const {
  channelLabel,
  formatContactIdentifier,
  isTelegramEnabled,
  postTelegramMessage,
  temperatureLabel,
} = require("./telegramAlertService");

const IMMEDIATE_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;
const HUMAN_ALERT_COOLDOWN_MINUTES = 30;
const HUMAN_ALERT_LOCK_NAMESPACE = 24682;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function buildInboxUrl(contactId, env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || !contactId) return null;
  return `${baseUrl}/inbox?contact=${encodeURIComponent(contactId)}`;
}

async function getImmediateAlertContext(contactId, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT
       c.id AS contact_id, c.whatsapp_number, c.name, c.whatsapp_profile_name,
       c.channel, c.channel_user_id,
       l.id AS lead_id, l.temperature, l.treatment_interest, l.branch_name,
       s.name AS stage_name,
       latest.id AS latest_customer_message_id,
       latest.content AS latest_customer_message
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT * FROM leads
       WHERE contact_id = c.id AND is_closed = false
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) l ON true
     LEFT JOIN pipeline_stages s ON s.id = l.stage_id
     LEFT JOIN LATERAL (
       SELECT id, content FROM messages
       WHERE contact_id = c.id AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id = $1`,
    [contactId]
  );
  return result.rows[0] || null;
}

async function claimImmediateAlert(
  {
    eventKey,
    type,
    contactId,
    cooldownMinutes = HUMAN_ALERT_COOLDOWN_MINUTES,
  },
  database = pool
) {
  if (!eventKey) return true;

  const client = await database.connect();
  try {
    await client.query("BEGIN");

    if (type === "human_intervention") {
      // Serialize claims for this contact. The cooldown SELECT runs only after
      // the lock is acquired, so under READ COMMITTED it sees any alert that a
      // competing app instance committed while this claim was waiting.
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [HUMAN_ALERT_LOCK_NAMESPACE, contactId]
      );

      const recent = await client.query(
        `SELECT id
         FROM telegram_immediate_alerts
         WHERE contact_id = $1
           AND alert_type = 'human_intervention'
           AND created_at > now() - ($2::integer * interval '1 minute')
         ORDER BY created_at DESC
         LIMIT 1`,
        [contactId, cooldownMinutes]
      );

      if (recent.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
    }

    const result = await client.query(
      `INSERT INTO telegram_immediate_alerts (event_key, alert_type, contact_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [eventKey, type, contactId]
    );

    await client.query("COMMIT");
    return Boolean(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function releaseImmediateAlert(eventKey, query = pool.query.bind(pool)) {
  if (!eventKey) return;
  await query("DELETE FROM telegram_immediate_alerts WHERE event_key = $1", [eventKey]);
}

function humanInterventionEventKey(context, reason, messageId = null) {
  // Automated paths tied to an inbound message use a stable key, preserving
  // exact-message dedupe in addition to the wider per-conversation cooldown.
  if (String(reason || "").trim() === "Flagged by staff.") return null;
  const capturedMessageId = Number(messageId || context.latest_customer_message_id);
  if (!Number.isSafeInteger(capturedMessageId) || capturedMessageId < 1) return null;
  return `human:${context.contact_id}:${capturedMessageId}`;
}

function bookingReadyEventKey(context, messageId = null) {
  const capturedMessageId = Number(messageId || context.latest_customer_message_id);
  if (!Number.isSafeInteger(capturedMessageId) || capturedMessageId < 1) return null;
  return `booking-ready:${context.contact_id}:${capturedMessageId}`;
}

function buildImmediateAlertMessage({ type, context, reason, env = process.env }) {
  const isDelivery = type === "delivery_failure";
  const isBookingReady = type === "booking_ready";
  const platform = channelLabel(context.channel || "whatsapp");
  const title = isDelivery
    ? `⚠️ ${platform} Delivery Failed`
    : isBookingReady
      ? "🔥 Booking Ready"
      : "🚨 Human Intervention Required";
  const name = clean(context.name || context.whatsapp_profile_name, "Unknown contact");
  const lines = [
    title,
    "",
    `${name} (${formatContactIdentifier(context)})`,
    "",
    `Reason: ${clean(reason)}`,
    `Temperature: ${temperatureLabel(context.temperature)}`,
    `Stage: ${clean(context.stage_name)}`,
    `Treatment: ${clean(context.treatment_interest)}`,
    `Branch: ${clean(context.branch_name)}`,
  ];

  if (context.latest_customer_message) {
    lines.push(
      "",
      "Latest Customer Message:",
      clean(context.latest_customer_message).slice(0, LATEST_MESSAGE_LIMIT)
    );
  }

  const action = isDelivery
    ? "Action: Check the failed message in Inbox and retry or contact the customer manually."
    : isBookingReady
      ? "Action: Open the conversation, verify the requested branch/time, and confirm the appointment availability with the customer."
      : "Action: Open the conversation and review/respond as soon as possible.";
  lines.push("", action);

  const inboxUrl = buildInboxUrl(context.contact_id, env);
  if (inboxUrl) lines.push("", `Inbox: ${inboxUrl}`);

  const message = lines.join("\n");
  return message.length <= IMMEDIATE_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, IMMEDIATE_MESSAGE_LIMIT - 3)}...`;
}

function createTelegramImmediateAlertService({
  env = process.env,
  getContext = getImmediateAlertContext,
  claimAlert = claimImmediateAlert,
  releaseAlert = releaseImmediateAlert,
  sendMessage = postTelegramMessage,
} = {}) {
  async function send(type, { contactId, reason, messageId = null }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const context = await getContext(contactId);
    if (!context) return { status: "skipped", reason: "contact-not-found" };

    let eventKey = null;
    if (type === "human_intervention") {
      eventKey = humanInterventionEventKey(context, reason, messageId);
      // Manual flags and rare attention paths without an inbound message still
      // participate in the same conversation cooldown. They just need a unique
      // event key because there is no stable inbound message id to use.
      if (!eventKey) {
        eventKey = `human:${contactId}:event:${crypto.randomUUID()}`;
      }
      const claimed = await claimAlert({
        eventKey,
        type,
        contactId,
        cooldownMinutes: HUMAN_ALERT_COOLDOWN_MINUTES,
      });
      if (!claimed) return { status: "suppressed" };
    } else if (type === "booking_ready") {
      eventKey = bookingReadyEventKey(context, messageId);
      if (!eventKey) {
        eventKey = `booking-ready:${contactId}:event:${crypto.randomUUID()}`;
      }
      const claimed = await claimAlert({ eventKey, type, contactId });
      if (!claimed) return { status: "suppressed" };
    }

    try {
      const text = buildImmediateAlertMessage({ type, context, reason, env });
      const result = await sendMessage({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        text,
      });
      return { status: "sent", result };
    } catch (err) {
      // A failed send must not consume the claim. Release the event so a later
      // attempt can retry instead of being permanently suppressed.
      if (eventKey) {
        await releaseAlert(eventKey).catch(() => {});
      }
      throw err;
    }
  }

  return {
    sendHumanInterventionAlert(input) {
      return send("human_intervention", input);
    },
    sendDeliveryFailureAlert(input) {
      return send("delivery_failure", input);
    },
    sendBookingReadyAlert(input) {
      return send("booking_ready", input);
    },
  };
}

const defaultService = createTelegramImmediateAlertService();

module.exports = {
  HUMAN_ALERT_COOLDOWN_MINUTES,
  HUMAN_ALERT_LOCK_NAMESPACE,
  buildImmediateAlertMessage,
  bookingReadyEventKey,
  claimImmediateAlert,
  createTelegramImmediateAlertService,
  getImmediateAlertContext,
  humanInterventionEventKey,
  releaseImmediateAlert,
  sendHumanInterventionAlert: defaultService.sendHumanInterventionAlert,
  sendDeliveryFailureAlert: defaultService.sendDeliveryFailureAlert,
  sendBookingReadyAlert: defaultService.sendBookingReadyAlert,
};
