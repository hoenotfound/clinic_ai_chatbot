const { pool } = require("../db/db");
const {
  formatWhatsappNumber,
  isTelegramEnabled,
  postTelegramMessage,
} = require("./telegramAlertService");

const IMMEDIATE_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function temperatureLabel(value) {
  const temperature = String(value || "warm").toLowerCase();
  if (temperature === "hot") return "🔥 Hot";
  if (temperature === "cold") return "❄️ Cold";
  return "🟠 Warm";
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
       SELECT content FROM messages
       WHERE contact_id = c.id AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id = $1`,
    [contactId]
  );
  return result.rows[0] || null;
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
  sendMessage = postTelegramMessage,
} = {}) {
  async function send(type, { contactId, reason }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const context = await getContext(contactId);
    if (!context) return { status: "skipped", reason: "contact-not-found" };

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
  createTelegramImmediateAlertService,
  getImmediateAlertContext,
  sendHumanInterventionAlert: defaultService.sendHumanInterventionAlert,
  sendDeliveryFailureAlert: defaultService.sendDeliveryFailureAlert,
};
