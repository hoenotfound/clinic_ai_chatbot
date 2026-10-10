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
  SELECT ('message:' || m.id::text) AS id, m.contact_id, c.channel, m.created_at,
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
  UNION ALL
  SELECT ('pricing_decision:' || d.id::text), d.contact_id, c.channel,
    d.created_at, 4, 'pricing', 'decision',
    CASE WHEN d.reason = 'delivery_review' THEN 'attention' ELSE 'skipped' END,
    d.reason
  FROM pricing_reminder_decisions d
  JOIN contacts c ON c.id = d.contact_id
  WHERE d.created_at >= now() - $1::integer * interval '1 day'
    AND ($2::text = 'all' OR c.channel = $2)
    AND ($3::integer[] IS NULL OR d.contact_id = ANY($3::integer[]))
  UNION ALL
  SELECT ('sequence_decision:' || d.id::text), d.contact_id, c.channel,
    d.created_at, d.follow_up_step, 'follow_up', 'decision',
    CASE WHEN d.action = 'human_review' THEN 'attention' ELSE 'skipped' END,
    COALESCE(d.reason, d.action)
  FROM follow_up_ai_decisions d
  JOIN contacts c ON c.id = d.contact_id
  WHERE d.action IN ('skip','human_review')
    AND d.created_at >= now() - $1::integer * interval '1 day'
    AND ($2::text = 'all' OR c.channel = $2)
    AND ($3::integer[] IS NULL OR d.contact_id = ANY($3::integer[]))
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


// Estimated next-step review queue. This is NOT an eligibility/booking/sending
// API: pricing readiness, opt-in, AI decisions and future human replies can
// invalidate any estimate, and the worker rechecks all safety constraints.
const UPCOMING_SQL = `WITH contacts_recent AS (
  SELECT DISTINCT contact_id FROM messages
  WHERE role='user' AND created_at >= now() - interval '24 hours'
)
SELECT c.id AS contact_id, c.channel, inbound.created_at AS inbound_at,
  anchor.created_at AS anchor_at,
  COALESCE(progress.max_step, 0) + 1 AS next_step,
  progress.previous_at
FROM contacts_recent recent
JOIN contacts c ON c.id = recent.contact_id
JOIN LATERAL (
  SELECT id, created_at FROM messages
  WHERE contact_id=c.id AND role='user'
  ORDER BY created_at DESC, id DESC LIMIT 1
) inbound ON true
JOIN LATERAL (
  SELECT id, created_at, delivery_status, sent_by_username
  FROM messages m
  WHERE m.contact_id=c.id AND role='assistant'
    AND is_automated_follow_up=false
    AND (created_at,id) > (inbound.created_at,inbound.id)
    AND NOT EXISTS (
      SELECT 1 FROM outbound_message_evidence e
      WHERE e.message_id=m.id AND e.origin='system_fallback'
    )
  ORDER BY created_at DESC,id DESC LIMIT 1
) anchor ON true
LEFT JOIN LATERAL (
  SELECT MAX(automated_follow_up_step) AS max_step,
    MAX(created_at) AS previous_at,
    BOOL_OR(delivery_status IN ('failed','unknown')
      OR (delivery_status IS NULL AND whatsapp_message_id IS NULL)) AS blocked
  FROM messages m WHERE m.contact_id=c.id
    AND is_automated_follow_up=true
    AND automated_follow_up_for_message_id=anchor.id
) progress ON true
WHERE c.channel IN ('whatsapp','facebook','instagram')
  AND ($1::text='all' OR c.channel=$1)
  AND ($2::integer[] IS NULL OR c.id=ANY($2::integer[]))
  AND c.needs_attention=false
  AND inbound.created_at > now() - interval '23 hours 50 minutes'
  AND anchor.delivery_status IS DISTINCT FROM 'failed'
  AND COALESCE(progress.blocked,false)=false
  AND NOT EXISTS (
    SELECT 1 FROM follow_up_ai_decisions d
    WHERE d.contact_id=c.id AND d.trigger_message_id=anchor.id
      AND d.action IN ('skip','human_review')
  )
ORDER BY inbound.created_at DESC, c.id DESC LIMIT 80`;

function estimateUpcoming(rows, config, now = new Date()) {
  if (!config || config.enabled !== true ||
      !Number.isFinite(Date.parse(config.activatedAt)) ||
      !Array.isArray(config.additionalSteps)) return [];
  const steps = [config, ...config.additionalSteps].slice(0, 3);
  if (!steps.every((step) => Number.isFinite(Number(step.delayMinutes)) &&
      Number(step.delayMinutes) >= 5)) return [];
  const nowMs = now.getTime();
  return rows.flatMap((row) => {
    const idx = Number(row.next_step) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) return [];
    const inbound = Date.parse(row.inbound_at);
    const anchor = Date.parse(row.anchor_at);
    const prev = Date.parse(row.previous_at);
    if (!Number.isFinite(inbound) || !Number.isFinite(anchor) ||
        anchor < Date.parse(config.activatedAt)) return [];
    const step = steps[idx];
    const mode = step.timingMode === "before_window_expiry";
    const nominal = mode
      ? inbound + (1440 - Number(step.beforeWindowExpiryMinutes ?? 120)) * 60000
      : anchor + Number(step.delayMinutes) * 60000;
    const spacing = idx > 0 && Number.isFinite(prev)
      ? prev + 2 * 60 * 60000
      : nominal;
    const earliest = Math.max(nominal, spacing);
    const expiry = inbound + 23 * 60 * 60000 + 50 * 60000;
    if (!Number.isFinite(earliest) || earliest >= expiry || expiry <= nowMs) return [];
    return [{
      contact_id: row.contact_id, channel: row.channel, step: idx + 1,
      estimated_at: new Date(Math.max(earliest, nowMs)).toISOString(),
      window_expires_at: new Date(expiry).toISOString(),
      reason: "Estimate only — requires worker eligibility, quiet-hour, consent and live reply-window checks",
    }];
  }).sort((a,b) => a.estimated_at.localeCompare(b.estimated_at)).slice(0,20);
}

async function getUpcomingReviewQueue(filters, allowedContactIds, config, execute = (sql,params)=>pool.query(sql,params), now = new Date()) {
  if (!config?.enabled || (Array.isArray(allowedContactIds) && !allowedContactIds.length)) return [];
  const result = await execute(UPCOMING_SQL, [filters.channel, allowedContactIds]);
  return estimateUpcoming(result.rows, config, now);
}

module.exports = {
  getFollowUpHealth, getUpcomingReviewQueue, parseHealthFilters, estimateUpcoming,
  HEALTH_SQL, UPCOMING_SQL,
};
