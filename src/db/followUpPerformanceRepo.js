const { pool } = require("./db");
const { getAnalyticsPipelineProfile } = require("./analyticsPipelineProfile");

const PERIODS = new Set([7, 30]);
const CHANNELS = new Set(["all", "whatsapp", "facebook", "instagram"]);
const RESPONSE_HOURS = 72;
const MILESTONE_DAYS = 7;

// One accepted primary follow-up or pricing reminder is one exposure.
// Individual Messenger/IG media companion messages never inflate exposures.
// These are OBSERVED associations, not incremental causal uplift.
const PERFORMANCE_SQL = `WITH eligible AS (
  SELECT m.id, m.contact_id, c.channel, m.created_at AS sent_at,
    CASE WHEN m.pricing_reminder_anchor_id IS NOT NULL THEN 'Pricing'
      WHEN m.automated_follow_up_for_message_id IS NOT NULL
        THEN 'FU' || m.automated_follow_up_step::text
      ELSE 'Extended WA template' END AS step,
    COALESCE(NULLIF(BTRIM(m.automated_follow_up_target_service), ''), 'Unspecified (not recorded)') AS service,
    CASE
      WHEN LOWER(COALESCE(m.media_mime_type, '')) LIKE 'video/%'
        OR LOWER(COALESCE(m.media_key, '')) ~ '[.](mp4|mov)($|[?])'
        OR EXISTS (SELECT 1 FROM messages a WHERE a.automated_follow_up_parent_message_id=m.id
          AND a.contact_id=m.contact_id AND a.is_automated_follow_up=true
          AND a.delivery_status IN ('sent','delivered','read')
          AND (LOWER(COALESCE(a.media_mime_type,'')) LIKE 'video/%'
            OR LOWER(COALESCE(a.media_key,'')) ~ '[.](mp4|mov)($|[?])'))
      THEN 'Video'
      WHEN NULLIF(m.media_url,'') IS NOT NULL
        OR LOWER(COALESCE(m.media_mime_type, '')) LIKE 'image/%'
        OR EXISTS (SELECT 1 FROM messages a WHERE a.automated_follow_up_parent_message_id=m.id
          AND a.contact_id=m.contact_id AND a.is_automated_follow_up=true
          AND a.delivery_status IN ('sent','delivered','read')
          AND (NULLIF(a.media_url,'') IS NOT NULL OR LOWER(COALESCE(a.media_mime_type,'')) LIKE 'image/%'))
      THEN 'Image'
      ELSE 'Text / no accepted media'
    END AS media,
    to_char(m.created_at AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD') AS local_day,
    extract(hour FROM m.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::integer AS local_hour
  FROM messages m
  JOIN contacts c ON c.id=m.contact_id
  WHERE m.role='assistant' AND m.is_automated_follow_up=true
    AND m.delivery_status IN ('sent','delivered','read')
    AND (
      (m.automated_follow_up_for_message_id IS NOT NULL
        AND m.automated_follow_up_step BETWEEN 1 AND 3)
      OR m.pricing_reminder_anchor_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM whatsapp_free_entry_followup_attempts fep
        WHERE fep.message_id=m.id AND fep.contact_id=m.contact_id
          AND fep.status='accepted')
    )
    AND m.created_at >= now() - $1::integer * interval '1 day'
    AND ($2::text='all' OR c.channel=$2)
    AND ($3::integer[] IS NULL OR m.contact_id=ANY($3::integer[]))
), ordered AS (
  SELECT e.*,
    lead(e.sent_at) OVER (PARTITION BY e.contact_id ORDER BY e.sent_at,e.id) AS next_sent_at,
    lead(e.id) OVER (PARTITION BY e.contact_id ORDER BY e.sent_at,e.id) AS next_sent_id
  FROM eligible e
), attributed AS (
  SELECT t.*,
    reply.created_at AS reply_at,
    outcome.appointment_at,
    outcome.visit_at,
    outcome.won_at
  FROM ordered t
  LEFT JOIN LATERAL (
    SELECT r.created_at FROM messages r
    WHERE r.contact_id=t.contact_id AND r.role='user'
      AND (r.created_at,r.id)>(t.sent_at,t.id)
      AND r.created_at <= t.sent_at + interval '72 hours'
      AND (t.next_sent_at IS NULL OR (r.created_at,r.id)<(t.next_sent_at,t.next_sent_id))
    ORDER BY r.created_at,r.id LIMIT 1
  ) reply ON true
  LEFT JOIN LATERAL (
    SELECT l.id FROM leads l WHERE l.contact_id=t.contact_id AND l.created_at<=t.sent_at
    ORDER BY l.created_at DESC,l.id DESC LIMIT 1
  ) lead ON true
  LEFT JOIN LATERAL (
    SELECT
      MIN(h.created_at) FILTER (WHERE s.system_key=$4::text) AS appointment_at,
      MIN(h.created_at) FILTER (WHERE s.system_key=$5::text) AS visit_at,
      MIN(h.created_at) FILTER (WHERE s.stage_type='won') AS won_at
    FROM lead_stage_history h JOIN pipeline_stages s ON s.id=h.to_stage_id
    WHERE h.lead_id=lead.id
      AND h.created_at>t.sent_at
      AND h.created_at<=t.sent_at+interval '7 days'
      AND (t.next_sent_at IS NULL OR h.created_at<t.next_sent_at)
  ) outcome ON true
), dimensions AS (
  SELECT a.*, d.dimension, d.label FROM attributed a
  CROSS JOIN LATERAL (VALUES
    ('overall','All'),
    ('step',a.step),
    ('service',a.service),
    ('media',a.media),
    ('channel',a.channel),
    ('hour',lpad(a.local_hour::text,2,'0')),
    ('day',a.local_day)
  ) d(dimension,label)
), grouped AS (
  SELECT dimension,label,
    count(*)::integer AS sent,
    count(DISTINCT contact_id)::integer AS contacts,
    count(*) FILTER (WHERE sent_at <= now()-interval '72 hours')::integer AS reply_matured,
    count(*) FILTER (WHERE sent_at <= now()-interval '72 hours' AND reply_at IS NOT NULL)::integer AS replied_matured,
    count(*) FILTER (WHERE reply_at IS NOT NULL)::integer AS replied_observed,
    count(*) FILTER (WHERE sent_at <= now()-interval '7 days')::integer AS milestone_matured,
    count(*) FILTER (WHERE sent_at <= now()-interval '7 days' AND appointment_at IS NOT NULL)::integer AS appointments_matured,
    count(*) FILTER (WHERE appointment_at IS NOT NULL)::integer AS appointments_observed,
    count(*) FILTER (WHERE sent_at <= now()-interval '7 days' AND visit_at IS NOT NULL)::integer AS visits_matured,
    count(*) FILTER (WHERE visit_at IS NOT NULL)::integer AS visits_observed,
    count(*) FILTER (WHERE sent_at <= now()-interval '7 days' AND won_at IS NOT NULL)::integer AS won_matured,
    count(*) FILTER (WHERE won_at IS NOT NULL)::integer AS won_observed,
    ROUND(AVG((extract(epoch FROM reply_at-sent_at)/3600)::numeric)
      FILTER (WHERE reply_at IS NOT NULL AND sent_at <= now()-interval '72 hours'),1) AS avg_reply_hours
  FROM dimensions GROUP BY dimension,label
)
SELECT COALESCE((SELECT to_jsonb(g) FROM grouped g WHERE dimension='overall' LIMIT 1),'{}'::jsonb) AS summary,
  COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY dimension,label)
    FROM grouped g WHERE dimension NOT IN ('overall','day')),'[]'::jsonb) AS breakdown,
  COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY label)
    FROM grouped g WHERE dimension='day'),'[]'::jsonb) AS daily`;

function parsePerformanceFilters(query = {}) {
  const days = Number(query.days ?? 30);
  const channel = String(query.channel || "all");
  if (!PERIODS.has(days) || !CHANNELS.has(channel)) {
    const error = new Error("Invalid performance filters.");
    error.status = 400;
    throw error;
  }
  return { days, channel };
}

function normalizeRow(row = {}) {
  const keys = [
    "sent", "contacts", "reply_matured", "replied_matured", "replied_observed",
    "milestone_matured", "appointments_matured", "appointments_observed",
    "visits_matured", "visits_observed", "won_matured", "won_observed",
  ];
  const result = { ...row };
  for (const key of keys) result[key] = Number(result[key] || 0);
  result.avg_reply_hours = row.avg_reply_hours == null ? null : Number(row.avg_reply_hours);
  return result;
}

async function getFollowUpPerformance(filtersInput = {}, allowedContactIds = null,
  execute = (sql, params) => pool.query(sql, params),
  pipelineProfile = getAnalyticsPipelineProfile()) {
  const filters = parsePerformanceFilters(filtersInput);
  const empty = { summary: normalizeRow(), breakdown: [], daily: [], filters,
    methodology: { replyHours: RESPONSE_HOURS, milestoneDays: MILESTONE_DAYS, attribution: "most_recent_accepted_follow_up_before_next_touch", causal: false } };
  if (Array.isArray(allowedContactIds) && !allowedContactIds.length) return empty;
  const result = await execute(PERFORMANCE_SQL, [
    filters.days, filters.channel, allowedContactIds,
    pipelineProfile.primarySystemKey, pipelineProfile.secondarySystemKey,
  ]);
  const data = result.rows[0] || {};
  return {
    ...empty,
    summary: normalizeRow(data.summary),
    breakdown: (data.breakdown || []).map(normalizeRow),
    daily: (data.daily || []).map(normalizeRow),
  };
}

module.exports = { getFollowUpPerformance, parsePerformanceFilters,
  PERFORMANCE_SQL, normalizeRow, RESPONSE_HOURS, MILESTONE_DAYS };
