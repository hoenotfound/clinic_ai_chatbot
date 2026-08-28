const https = require("https");
const { pool } = require("../db/db");

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_TIMEOUT_MS = 8000;

function isTelegramEnabled(env = process.env) {
  return (
    String(env.TELEGRAM_ALERTS_ENABLED || "").toLowerCase() === "true" &&
    Boolean(env.TELEGRAM_BOT_TOKEN) &&
    Boolean(env.TELEGRAM_CHAT_ID)
  );
}

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function formatWhatsappNumber(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "Not captured";
}

function formatAppointment(value) {
  if (!value) return "Not captured";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  try {
    return new Intl.DateTimeFormat("en-MY", {
      timeZone: "Asia/Kuala_Lumpur",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
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

function buildConversationSummaryMessage({ lead, score, env = process.env }) {
  const summary = score?.summary || {};
  const name = clean(lead.name || lead.whatsapp_profile_name, "Unknown contact");
  const treatment = clean(summary.treatmentInterest || lead.treatment_interest);
  const branch = clean(summary.preferredBranch || lead.branch_name);
  const appointment = clean(summary.preferredAppointment, formatAppointment(lead.appointment_at));
  const inboxUrl = buildInboxUrl(lead.contact_id, env);

  const lines = [
    `${temperatureLabel(score?.temperature)} Conversation Summary`,
    "",
    `${name} (${formatWhatsappNumber(lead.whatsapp_number)})`,
    "",
    `Stage: ${clean(lead.stage_name)}`,
    `AI Temperature: ${temperatureLabel(score?.temperature)} (${clean(score?.confidence, "unknown")} confidence)`,
    `Treatment: ${treatment}`,
    `Branch: ${branch}`,
    `Appointment: ${appointment}`,
    `Main concern: ${clean(summary.mainConcern)}`,
    "",
    "Chat Summary:",
    clean(summary.chatSummary, "No summary was generated."),
    "",
    "Recommended Action:",
    clean(summary.nextAction, "Review the conversation and follow up as needed."),
    "",
    `Temperature reason: ${clean(score?.reason)}`,
  ];

  if (inboxUrl) {
    lines.push("", `Inbox: ${inboxUrl}`);
  }

  const message = lines.join("\n");
  return message.length <= TELEGRAM_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, TELEGRAM_MESSAGE_LIMIT - 3)}...`;
}

function postTelegramMessage({ token, chatId, text }) {
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.telegram.org",
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: "POST",
        timeout: TELEGRAM_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = null;
          }

          if (response.statusCode >= 200 && response.statusCode < 300 && parsed?.ok) {
            return resolve(parsed.result || null);
          }

          const detail = parsed?.description || body || `HTTP ${response.statusCode}`;
          reject(new Error(`Telegram send failed: ${detail}`));
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Telegram send timed out."));
    });
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

async function getLeadAlertContext(leadId, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT
       l.id, l.contact_id, l.temperature, l.branch_name, l.treatment_interest,
       l.appointment_at, l.appointment_status,
       s.name AS stage_name,
       c.whatsapp_number, c.name, c.whatsapp_profile_name
     FROM leads l
     JOIN pipeline_stages s ON s.id = l.stage_id
     JOIN contacts c ON c.id = l.contact_id
     WHERE l.id = $1`,
    [leadId]
  );
  return result.rows[0] || null;
}

function createTelegramAlertService({
  env = process.env,
  getLeadContext = getLeadAlertContext,
  sendMessage = postTelegramMessage,
} = {}) {
  return {
    async sendConversationSummary({ leadId, score }) {
      if (!isTelegramEnabled(env)) {
        return { status: "disabled" };
      }

      const lead = await getLeadContext(leadId);
      if (!lead) {
        return { status: "skipped", reason: "lead-not-found" };
      }

      const text = buildConversationSummaryMessage({ lead, score, env });
      const result = await sendMessage({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        text,
      });
      return { status: "sent", result };
    },
  };
}

const defaultService = createTelegramAlertService();

module.exports = {
  TELEGRAM_MESSAGE_LIMIT,
  buildConversationSummaryMessage,
  createTelegramAlertService,
  formatWhatsappNumber,
  getLeadAlertContext,
  isTelegramEnabled,
  postTelegramMessage,
  sendConversationSummary: defaultService.sendConversationSummary,
};
