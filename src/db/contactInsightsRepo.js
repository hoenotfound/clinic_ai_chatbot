const { pool } = require("./db");

const SUMMARY_KEYS = [
  "treatmentInterest",
  "preferredBranch",
  "preferredAppointment",
  "mainConcern",
  "chatSummary",
  "nextAction",
];

function cleanSummary(summaryData) {
  const source =
    summaryData && typeof summaryData === "object" && !Array.isArray(summaryData)
      ? summaryData
      : {};
  return Object.fromEntries(
    SUMMARY_KEYS.map((key) => [
      key,
      typeof source[key] === "string" ? source[key].trim() : "",
    ])
  );
}

function toNumberOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function mapContactInsights(row) {
  if (!row) return null;

  const latestMessageId = toNumberOrNull(row.latest_message_id);
  const throughMessageId = toNumberOrNull(row.score_through_message_id);

  return {
    contact: {
      id: row.contact_id,
      whatsappNumber: row.whatsapp_number,
      name: row.name,
      whatsappProfileName: row.whatsapp_profile_name,
      channel: row.channel,
      photoUrl: row.photo_url,
      mode: row.mode,
      takeoverBy: row.takeover_by,
      takeoverAt: row.takeover_at,
      needsAttention: row.needs_attention,
      attentionReason: row.attention_reason,
      isUnread: row.is_unread,
      needsFollowUp: row.needs_follow_up,
      createdAt: row.contact_created_at,
    },
    lead: row.lead_id
      ? {
          id: row.lead_id,
          stageId: row.stage_id,
          stageName: row.stage_name,
          temperature: row.current_temperature,
          temperatureSource: row.temperature_source,
          temperatureLocked: row.temperature_locked,
          branchName: row.branch_name,
          treatmentInterest: row.treatment_interest,
          appointmentAt: row.appointment_at,
          appointmentStatus: row.appointment_status,
          nextFollowUpAt: row.next_follow_up_at,
          isClosed: row.is_closed,
          createdAt: row.lead_created_at,
        }
      : null,
    aiInsights: row.score_id
      ? {
          scoreId: row.score_id,
          temperature: row.scored_temperature,
          confidence: row.confidence,
          reason: row.reason,
          summary: cleanSummary(row.summary_data),
          provider: row.provider,
          model: row.model,
          throughMessageId,
          updatedAt: row.score_updated_at,
          isStale:
            latestMessageId != null &&
            throughMessageId != null &&
            latestMessageId > throughMessageId,
        }
      : null,
  };
}

async function getContactInsights(contactId, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT
       c.id AS contact_id,
       c.whatsapp_number,
       c.name,
       c.whatsapp_profile_name,
       c.channel,
       c.photo_url,
       c.mode,
       c.takeover_by,
       c.takeover_at,
       c.needs_attention,
       c.attention_reason,
       c.is_unread,
       c.needs_follow_up,
       c.created_at AS contact_created_at,
       l.id AS lead_id,
       l.stage_id,
       stage.name AS stage_name,
       l.temperature AS current_temperature,
       l.temperature_source,
       l.temperature_locked,
       l.branch_name,
       l.treatment_interest,
       l.appointment_at,
       l.appointment_status,
       l.next_follow_up_at,
       l.is_closed,
       l.created_at AS lead_created_at,
       score.id AS score_id,
       score.temperature AS scored_temperature,
       score.confidence,
       score.reason,
       COALESCE(
         NULLIF(score.summary_data, '{}'::jsonb),
         telegram_score.summary_data,
         '{}'::jsonb
       ) AS summary_data,
       score.provider,
       score.model,
       score.through_message_id AS score_through_message_id,
       score.updated_at AS score_updated_at,
       latest.id AS latest_message_id
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT lead_choice.*
       FROM leads lead_choice
       WHERE lead_choice.contact_id = c.id
       ORDER BY
         (lead_choice.is_closed = false) DESC,
         lead_choice.created_at DESC,
         lead_choice.id DESC
       LIMIT 1
     ) l ON true
     LEFT JOIN pipeline_stages stage ON stage.id = l.stage_id
     LEFT JOIN LATERAL (
       SELECT score_choice.*
       FROM lead_temperature_scores score_choice
       WHERE score_choice.lead_id = l.id
         AND score_choice.status = 'completed'
       ORDER BY score_choice.through_message_id DESC, score_choice.id DESC
       LIMIT 1
     ) score ON true
     LEFT JOIN LATERAL (
       SELECT alert.score_data->'summary' AS summary_data
       FROM telegram_summary_alerts alert
       WHERE alert.lead_id = l.id
         AND alert.through_message_id = score.through_message_id
         AND jsonb_typeof(alert.score_data->'summary') = 'object'
       ORDER BY alert.id DESC
       LIMIT 1
     ) telegram_score ON true
     LEFT JOIN LATERAL (
       SELECT message.id
       FROM messages message
       WHERE message.contact_id = c.id
       ORDER BY message.id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id = $1`,
    [contactId]
  );

  return mapContactInsights(result.rows[0] || null);
}

module.exports = {
  SUMMARY_KEYS,
  cleanSummary,
  getContactInsights,
  mapContactInsights,
};
