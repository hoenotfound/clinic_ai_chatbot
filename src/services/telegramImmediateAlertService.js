const { pool } = require("../db/db");
const {
  formatWhatsappNumber,
  isTelegramEnabled,
  postTelegramMessage,
  temperatureLabel,
} = require("./telegramAlertService");

const IMMEDIATE_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;

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
  { eventKey, type, contactId },
  query = pool.query.bind(pool)
) {
  if (!eventKey) return true;
  const result = await query(
    `INSERT INTO telegram_immediate_alerts (event_key, alert_type, contact_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [eventKey, type, contactId]
  );
  return Boolean(result.rows[0]);
}

function humanInterventionEventKey(context, reason) {
  // A staff-created manual flag is a separate action and should always alert.
  // Automated keyword, media, processing, staff-owned, and AI handoff paths all
  // refer to the latest inbound customer message, so they share one event key.
  if (String(reason || "").trim() === "Flagged by staff.") return null;
  const messageId = Number(context.latest_customer_message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  return `human:${context.contact_id}:${messageId}`;
}

function buildImmediateAlertMessage({ type, context, reason, env = process.env }) {
  const isDelivery = type === "delivery_failure";
  const title = isDelivery
    ? "⚠️ WhatsApp Delivery Failed"
    : "🚨 Human Intervention Required";
  const name = clean(context.name || context.whatsapp_profile_name, "Unknown contact");
  const lines = [
    title,
    "",
    `${name} (${formatWhatsappNumber(context.whatsapp_number)})`,
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

  lines.push(
    "",
    isDelivery
      ? "Action: Check the failed message in Inbox and retry or contact the customer manually."
      : "Action: Open the conversation and review/respond as soon as possible."
  );

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
  sendMessage = postTelegramMessage,
} = {}) {
  async function send(type, { contactId, reason }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const context = await getContext(contactId);
    if (!context) return { status: "skipped", reason: "contact-not-found" };

    if (type === "human_intervention") {
      const eventKey = humanInterventionEventKey(context, reason);
      const claimed = await claimAlert({ eventKey, type, contactId });
      if (!claimed) return { status: "duplicate" };
    }

    const text = buildImmediateAlertMessage({ type, context, reason, env });
    const result = await sendMessage({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      text,
    });
    return { status: "sent", result };
  }

  return {
    sendHumanInterventionAlert(input) {
      return send("human_intervention", input);
    },
    sendDeliveryFailureAlert(input) {
      return send("delivery_failure", input);
    },
  };
}

const defaultService = createTelegramImmediateAlertService();

module.exports = {
  buildImmediateAlertMessage,
  claimImmediateAlert,
  createTelegramImmediateAlertService,
  getImmediateAlertContext,
  humanInterventionEventKey,
  sendHumanInterventionAlert: defaultService.sendHumanInterventionAlert,
  sendDeliveryFailureAlert: defaultService.sendDeliveryFailureAlert,
};
