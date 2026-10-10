const { pool } = require("../db/db");

const ALLOWED_DAYS = new Set([7, 30]);
const ALLOWED_CHANNELS = new Set(["all", "whatsapp", "facebook", "instagram"]);
const DEFAULT_LIMIT = 20;

// This is a read-only health view of persisted evidence, not scheduler state.
// It deliberately never calls the follow-up worker or triggers a retry.
function parseHealthFilters(query = {}) {
  const days = Number(query.days ?? 7);
  const channel = String(query.channel || "all");
  if (!ALLOWED_DAYS.has(days) || !ALLOWED_CHANNELS.has(channel)) {
    const error = new Error("Invalid health filters.");
    error.status = 400;
    throw error;
  }
  return { days, channel };
}

const HEALTH_SQL = `WITH evidence AS (
  SELECT m.id, m.contact_id, c.channel, m.created_at,
    COALESCE(parent.automated_follow_up_step, m.automated_follow_up_step) AS step,
    CASE WHEN m.pricing_reminder_anchor_id IS NOT NULL THEN 'pricing'
      ELSE 'follow_up' END AS type,
    CASE WHEN parent.id IS NOT NULL THEN 'media' ELSE 'message' END AS part,
    CASE
      WHEN m.delivery_status IN ('sent', 'delivered', 'read') THEN 'sent'
      WHEN m.delivery_status = 'failed' THEN 'failed'
      WHEN m.delivery_status = 'cancelled' THEN 'skipped'
      WHEN m.delivery_status = 'unknown' THEN 'attention'
      ELSE 'pending'
    END AS status,
    COALESCE(m.delivery_error, '') AS detail
  FROM messages m
  JOIN contacts c ON c.id = m.contact_id
  LEFT JOIN messages parent ON parent.id = m.automated_follow_up_parent_message_id
    AND parent.contact_id = m.contact_id
    AND parent.is_automated_follow_up = true
    AND parent.automated_follow_up_for_message_id IS NOT NULL
  WHERE m.is_automated_follow_up = true
    AND (
      m.automated_follow_up_for_message_id IS NOT NULL
      OR m.pricing_reminder_anchor_id IS NOT NULL
      OR (parent.id IS NOT NULL AND c.channel IN ('facebook', 'instagram'))
    )
    AND m.created_at >= now() - $1::integer * interval '1 day'
    AND ($2::text = 'all' OR c.channel = $2)
    AND ($3::integer[] IS NULL OR m.contact_id = ANY($3::integer[]))
), grouped AS (
  SELECT channel, type, part, step, status, COUNT(*)::integer AS count
  FROM evidence GROUP BY channel, type, part, step, status
), attention AS (
  SELECT id, contact_id, channel, type, part, step, status,
    LEFT(detail, 200) AS detail, created_at,
    (status = 'pending' AND created_at < now() - interval '20 minutes') AS stale_pending
  FROM evidence
  WHERE status IN ('failed', 'attention')
     OR (status = 'pending' AND created_at < now() - interval '20 minutes')
  ORDER BY created_at DESC, id DESC LIMIT $4::integer
)
SELECT COALESCE((SELECT jsonb_agg(to_jsonb(grouped)) FROM grouped), '[]'::jsonb) AS breakdown,
  COALESCE((SELECT jsonb_agg(to_jsonb(attention) ORDER BY created_at DESC, id DESC)
    FROM attention), '[]'::jsonb) AS alerts,
  (SELECT COUNT(*)::integer FROM evidence WHERE status = 'pending'
    AND created_at < now() - interval '20 minutes') AS stale_pending_count,
  (SELECT COUNT(*)::integer FROM evidence WHERE status = 'failed') AS failed_count,
  (SELECT COUNT(*)::integer FROM evidence WHERE status = 'attention') AS attention_count,
  (SELECT COUNT(*)::integer FROM evidence) AS event_count`;

async function getFollowUpHealth(query = {}, allowedContactIds = null, execute = (sql, params) => pool.query(sql, params)) {
  const filters = parseHealthFilters(query);
  if (Array.isArray(allowedContactIds) && allowedContactIds.length === 0) {
    return { breakdown: [], alerts: [], stalePendingCount: 0, failedCount: 0,
      attentionCount: 0, eventCount: 0, days: filters.days, channel: filters.channel };
  }
  const result = await execute(HEALTH_SQL, [filters.days, filters.channel, allowedContactIds, DEFAULT_LIMIT]);
  const row = result.rows[0] || {};
  return {
    breakdown: row.breakdown || [],
    alerts: row.alerts || [],
    stalePendingCount: Number(row.stale_pending_count || 0),
    failedCount: Number(row.failed_count || 0),
    attentionCount: Number(row.attention_count || 0),
    eventCount: Number(row.event_count || 0),
    days: filters.days,
    channel: filters.channel,
  };
}

module.exports = { getFollowUpHealth, parseHealthFilters, HEALTH_SQL };
