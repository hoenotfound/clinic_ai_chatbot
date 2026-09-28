const clinicConfig = require("../config/clinicConfig");
const { pool } = require("../db/db");
const { getOperationalLabels } = require("../utils/businessTerminology");
const {
  formatContactIdentifier,
  isTelegramEnabled,
  temperatureLabel,
} = require("./telegramAlertService");
const {
  queuePreparedAlert,
} = require("./telegramImmediateAlertService");

const LEAD_REENGAGED_MIN_HOURS = 24;
const LEAD_REENGAGED_SUMMARY_LIMIT = 600;
const LEAD_REENGAGED_MESSAGE_LIMIT = 4000;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function buildInboxUrl(contactId, env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || !contactId) return null;
  return `${baseUrl}/inbox?contact=${encodeURIComponent(contactId)}`;
}

function leadReengagedEventKey(contactId, currentMessageId) {
  const contact = Number(contactId);
  const message = Number(currentMessageId);
  if (!Number.isSafeInteger(contact) || contact < 1) return null;
  if (!Number.isSafeInteger(message) || message < 1) return null;
  return `lead-reengaged:${contact}:${message}`;
}

function formatReturnGap(hours) {
  const value = Math.max(0, Number(hours) || 0);
  if (value >= 48) {
    const days = Math.floor(value / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.floor(value))} hour${value >= 2 ? "s" : ""}`;
}

async function getLeadReengagementContext(
  { contactId, currentMessageId, leadId = null },
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT
       c.id AS contact_id,
       c.whatsapp_number,
       c.name,
       c.whatsapp_profile_name,
       c.channel,
       c.channel_user_id,
       current_message.id AS current_message_id,
       current_message.content AS current_customer_message,
       current_message.created_at AS current_message_at,
       previous_message.id AS previous_customer_message_id,
       previous_message.created_at AS previous_customer_message_at,
       EXTRACT(EPOCH FROM (
         current_message.created_at - previous_message.created_at
       )) / 3600.0 AS gap_hours,
       current_lead.id AS lead_id,
       current_lead.temperature,
       current_lead.treatment_interest,
       current_lead.branch_name,
       stage.name AS stage_name,
       prior_score.summary_data->>'chatSummary' AS previous_ai_summary
     FROM contacts c
     JOIN messages current_message
       ON current_message.id = $2
      AND current_message.contact_id = c.id
      AND current_message.role = 'user'
     LEFT JOIN leads current_lead
       ON current_lead.id = $3
      AND current_lead.contact_id = c.id
     LEFT JOIN pipeline_stages stage
       ON stage.id = current_lead.stage_id
     LEFT JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'user'
         AND (m.created_at, m.id) <
             (current_message.created_at, current_message.id)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) previous_message ON true
     LEFT JOIN LATERAL (
       SELECT score.summary_data
       FROM lead_temperature_scores score
       JOIN leads scored_lead ON scored_lead.id = score.lead_id
       WHERE scored_lead.contact_id = c.id
         AND score.through_message_id < current_message.id
         AND score.status IN ('completed', 'superseded')
         AND NULLIF(BTRIM(COALESCE(score.summary_data->>'chatSummary', '')), '') IS NOT NULL
       ORDER BY score.through_message_id DESC, score.id DESC
       LIMIT 1
     ) prior_score ON true
     WHERE c.id = $1`,
    [Number(contactId), Number(currentMessageId), Number(leadId) || null]
  );
  return result.rows[0] || null;
}

function buildLeadReengagedMessage({
  context,
  env = process.env,
  config = clinicConfig,
}) {
  const labels = getOperationalLabels(config);
  const name = clean(
    context.name || context.whatsapp_profile_name,
    `Returning ${labels.customerSingular}`
  );
  const lines = [
    "🔄 Lead Re-engaged",
    "",
    `${name} (${formatContactIdentifier(context)})`,
    "",
    `Returned after: ${formatReturnGap(context.gap_hours)}`,
    `Temperature: ${temperatureLabel(context.temperature)}`,
    `Stage: ${clean(context.stage_name)}`,
    `${labels.serviceInterestLabel}: ${clean(context.treatment_interest)}`,
    `${labels.locationLabel}: ${clean(context.branch_name)}`,
  ];

  const priorSummary = String(context.previous_ai_summary || "").trim();
  if (priorSummary) {
    lines.push(
      "",
      "Previous AI Summary:",
      priorSummary.slice(0, LEAD_REENGAGED_SUMMARY_LIMIT)
    );
  }

  lines.push(
    "",
    `New ${labels.customerLabel} Message:`,
    clean(context.current_customer_message).slice(0, LEAD_REENGAGED_SUMMARY_LIMIT),
    "",
    `Action: This ${labels.customerSingular} has returned after being inactive. Review the new message while interest is active.`
  );

  const inboxUrl = buildInboxUrl(context.contact_id, env);
  if (inboxUrl) lines.push("", `Inbox: ${inboxUrl}`);

  const message = lines.join("\n");
  return message.length <= LEAD_REENGAGED_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, LEAD_REENGAGED_MESSAGE_LIMIT - 3)}...`;
}

function createLeadReengagementAlertService({
  env = process.env,
  getContext = getLeadReengagementContext,
  queueAlert = queuePreparedAlert,
  config = clinicConfig,
  minHours = LEAD_REENGAGED_MIN_HOURS,
} = {}) {
  return {
    async notifyIfReengaged({
      contactId,
      currentMessageId,
      leadId = null,
    }) {
      if (!isTelegramEnabled(env)) return { status: "disabled" };

      const eventKey = leadReengagedEventKey(contactId, currentMessageId);
      if (!eventKey) return { status: "skipped", reason: "invalid-message" };

      const context = await getContext({
        contactId,
        currentMessageId,
        leadId,
      });
      if (!context?.previous_customer_message_id) {
        return { status: "skipped", reason: "no-previous-customer-message" };
      }

      const gapHours = Number(context.gap_hours);
      if (!Number.isFinite(gapHours) || gapHours < minHours) {
        return { status: "skipped", reason: "recent-conversation" };
      }

      const messageText = buildLeadReengagedMessage({
        context,
        env,
        config,
      });

      return queueAlert({
        eventKey,
        type: "lead_reengaged",
        contactId,
        leadId: context.lead_id || leadId || null,
        messageText,
      });
    },
  };
}

const defaultService = createLeadReengagementAlertService();

module.exports = {
  LEAD_REENGAGED_MIN_HOURS,
  buildLeadReengagedMessage,
  createLeadReengagementAlertService,
  formatReturnGap,
  getLeadReengagementContext,
  leadReengagedEventKey,
  notifyIfReengaged: defaultService.notifyIfReengaged,
};
