const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { quietHoursStatus } = require("../utils/quietHours");

const ACTIVITY_DAYS = new Set([7, 30]);
const ACTIVITY_CHANNELS = new Set(["all", "whatsapp", "facebook", "instagram"]);
const ACTIVITY_TYPES = new Set(["all", "sequence", "pricing"]);
const ACTIVITY_STATES = new Set(["all", "sent", "pending", "failed", "skipped", "attention"]);
const PAGE_SIZE = 25;
const MAX_PAGE = 20;

function parseActivityFilters(query = {}) {
  const days = Number(query.days || 7);
  const channel = String(query.channel || "all");
  const type = String(query.type || "all");
  const state = String(query.state || "all");
  const page = Number(query.page || 1);
  if (!ACTIVITY_DAYS.has(days) || !ACTIVITY_CHANNELS.has(channel) ||
      !ACTIVITY_TYPES.has(type) || !ACTIVITY_STATES.has(state) ||
      !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) return null;
  return { days, channel, type, state, page };
}

// Read-only bounded event history. Each row is a persisted message or terminal
// decision; pending does not prove delivery, and unrecorded quiet-hour deferrals
// cannot be counted as skips. Extended templates retain their own diagnostics.
const ACTIVITY_SQL = `WITH activity AS (
  SELECT 'message:' || m.id::text AS event_id, m.created_at AS occurred_at,
    m.contact_id, c.channel,
    CASE WHEN m.pricing_reminder_anchor_id IS NOT NULL OR m.automated_follow_up_step = 4
      THEN 'pricing' ELSE 'sequence' END AS type,
    m.automated_follow_up_step AS step,
    CASE
      WHEN m.delivery_status IN ('sent', 'delivered', 'read') THEN 'sent'
      WHEN m.delivery_status = 'failed' THEN 'failed'
      WHEN m.delivery_status = 'cancelled' THEN 'skipped'
      WHEN m.delivery_status IN ('unknown') THEN 'attention'
      ELSE 'pending'
    END AS state,
    LEFT(COALESCE(m.delivery_error, ''), 240) AS detail,
    COALESCE(m.delivery_status, 'pending') AS raw_status,
    CASE
      WHEN c.channel = 'whatsapp' AND m.whatsapp_accepted_at IS NOT NULL
        AND m.whatsapp_message_id IS NOT NULL THEN 'accepted'
      WHEN c.channel IN ('facebook', 'instagram') AND m.social_accepted_at IS NOT NULL
        AND m.whatsapp_message_id LIKE (c.channel || ':%') THEN 'accepted'
      WHEN m.whatsapp_message_id IS NOT NULL THEN 'provider_id'
      ELSE 'none'
    END AS provider_evidence,
    CASE
      WHEN LOWER(COALESCE(m.media_mime_type, '')) LIKE 'video/%'
        OR LOWER(COALESCE(m.media_key, '')) ~ '\\.(mp4|mov)(\\?|$)' THEN 'video'
      WHEN LOWER(COALESCE(m.media_mime_type, '')) LIKE 'image/%'
        OR NULLIF(m.media_url, '') IS NOT NULL THEN 'image'
      WHEN m.media_key IS NOT NULL THEN 'attachment'
      ELSE 'text'
    END AS media_type
  FROM messages m
  JOIN contacts c ON c.id = m.contact_id
  WHERE m.is_automated_follow_up = true
    AND (m.automated_follow_up_for_message_id IS NOT NULL
      OR m.pricing_reminder_anchor_id IS NOT NULL)
    AND m.automated_follow_up_step BETWEEN 1 AND 4
    AND m.created_at >= now() - $1::integer * interval '1 day'
  UNION ALL
  SELECT 'pricing_decision:' || p.id::text, p.created_at, p.contact_id, c.channel,
    'pricing', 4,
    CASE WHEN p.reason = 'delivery_review' THEN 'attention' ELSE 'skipped' END,
    LEFT(p.reason, 240), p.reason, NULL::text, NULL::text
  FROM pricing_reminder_decisions p
  JOIN contacts c ON c.id = p.contact_id
  WHERE p.created_at >= now() - $1::integer * interval '1 day'
  UNION ALL
  SELECT 'sequence_decision:' || d.id::text, d.created_at, d.contact_id, c.channel,
    'sequence', d.follow_up_step,
    CASE WHEN d.action = 'human_review' THEN 'attention' ELSE 'skipped' END,
    LEFT(COALESCE(d.reason, d.action), 240), d.action, NULL::text, NULL::text
  FROM follow_up_ai_decisions d
  JOIN contacts c ON c.id = d.contact_id
  WHERE d.created_at >= now() - $1::integer * interval '1 day'
), scoped AS (
  SELECT * FROM activity
  WHERE ($2::text = 'all' OR channel = $2)
    AND ($3::text = 'all' OR type = $3)
    AND ($7::integer[] IS NULL OR contact_id = ANY($7::integer[]))
), visible AS (
  SELECT * FROM scoped WHERE ($4::text = 'all' OR state = $4)
)
SELECT
  (SELECT jsonb_build_object(
    'sent', COUNT(*) FILTER (WHERE state = 'sent'),
    'pending', COUNT(*) FILTER (WHERE state = 'pending'),
    'failed', COUNT(*) FILTER (WHERE state = 'failed'),
    'skipped', COUNT(*) FILTER (WHERE state = 'skipped'),
    'attention', COUNT(*) FILTER (WHERE state = 'attention')
  ) FROM scoped) AS summary,
  (SELECT COUNT(*)::integer FROM visible) AS total,
  COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY paged.occurred_at DESC, paged.event_id DESC) FROM (
    SELECT event_id, occurred_at, contact_id, channel, type, step, state, detail, raw_status, provider_evidence, media_type
    FROM visible
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT $5::integer OFFSET $6::integer
  ) paged), '[]'::jsonb) AS items`;

async function listActivity(query = {}, allowedContactIds = null, queryFn = (sql, params) => pool.query(sql, params)) {
  const filters = parseActivityFilters(query);
  if (!filters) {
    const error = new Error("Invalid activity filters.");
    error.status = 400;
    throw error;
  }
  if (Array.isArray(allowedContactIds) && allowedContactIds.length === 0) {
    return {
      items: [], total: 0, page: filters.page, pageSize: PAGE_SIZE,
      hasMore: false, summary: { sent: 0, pending: 0, failed: 0, skipped: 0, attention: 0 },
    };
  }
  const offset = (filters.page - 1) * PAGE_SIZE;
  const result = await queryFn(ACTIVITY_SQL, [
    filters.days, filters.channel, filters.type, filters.state, PAGE_SIZE, offset,
    allowedContactIds,
  ]);
  const data = result.rows[0] || {};
  const items = data.items || [];
  const total = Number(data.total || 0);
  return {
    items, total, page: filters.page, pageSize: PAGE_SIZE,
    hasMore: offset + items.length < total,
    summary: { sent: 0, pending: 0, failed: 0, skipped: 0, attention: 0, ...(data.summary || {}) },
  };
}

// Separate, conservative diagnostic: an expired most-recent conversation
// window whose configured Follow-up 3 has no message or terminal decision.
// This is NOT a recorded skip: staff takeover, customer opt-out, booking,
// scheduling limits or quiet hours may explain the gap. Never insert events.
const MISSING_FINAL_STEP_SQL = `WITH candidate_contacts AS (
    SELECT DISTINCT contact_id
    FROM messages
    WHERE role = 'user'
      AND created_at >= now() - $1::integer * interval '1 day'
  )
  SELECT c.id AS contact_id, c.channel,
    inbound.created_at AS inbound_at, anchor.created_at AS anchor_at
  FROM candidate_contacts recent
  JOIN contacts c ON c.id = recent.contact_id
  JOIN LATERAL (
    SELECT id, created_at FROM messages
    WHERE contact_id = c.id AND role = 'user'
    ORDER BY created_at DESC, id DESC LIMIT 1
  ) inbound ON true
  JOIN LATERAL (
    SELECT id, created_at FROM messages normal
    WHERE normal.contact_id = c.id AND normal.role = 'assistant'
      AND normal.is_automated_follow_up = false
      AND normal.delivery_status IS DISTINCT FROM 'failed'
      AND normal.delivery_status IS DISTINCT FROM 'cancelled'
      AND (normal.created_at, normal.id) > (inbound.created_at, inbound.id)
      AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
        WHERE e.message_id = normal.id AND e.origin = 'system_fallback')
    ORDER BY normal.created_at DESC, normal.id DESC LIMIT 1
  ) anchor ON true
  WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
    AND ($2::text = 'all' OR c.channel = $2)
    AND ($4::integer[] IS NULL OR c.id = ANY($4::integer[]))
    AND inbound.created_at >= now() - $1::integer * interval '1 day'
    AND inbound.created_at <= now() - interval '23 hours 50 minutes'
    AND anchor.created_at >= $3::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM messages m
      WHERE m.contact_id = c.id
        AND m.is_automated_follow_up = true
        AND m.automated_follow_up_for_message_id = anchor.id
        AND m.automated_follow_up_step = 3
    )
    AND NOT EXISTS (
      SELECT 1 FROM follow_up_ai_decisions d
      WHERE d.contact_id = c.id AND d.trigger_message_id = anchor.id
        AND d.action IN ('skip', 'human_review')
    )
  ORDER BY inbound.created_at DESC, c.id DESC
  LIMIT 15`;

function currentFinalStepSettings(config = clinicConfig.automatedFollowUp) {
  if (config?.enabled !== true || !Array.isArray(config.additionalSteps) ||
      config.additionalSteps.length < 2 || !Number.isFinite(Date.parse(config.activatedAt))) return null;
  const step = config.additionalSteps[1];
  return {
    activation: config.activatedAt,
    timingMode: step?.timingMode === 'before_window_expiry' ? 'before_window_expiry' : 'after_reply',
    delay: Number(step?.delayMinutes) || 1200,
    expiryOffset: Number(step?.beforeWindowExpiryMinutes) || 120,
    quietHours: config.quietHours,
  };
}

async function listSchedulingDiagnostics(filters, allowedContactIds, queryFn = (sql, params) => pool.query(sql, params), config = clinicConfig.automatedFollowUp) {
  const finalStep = currentFinalStepSettings(config);
  if (!filters || !finalStep || (Array.isArray(allowedContactIds) && allowedContactIds.length === 0) ||
      filters.type === 'pricing') return [];
  const records = await queryFn(MISSING_FINAL_STEP_SQL, [
    filters.days, filters.channel, finalStep.activation, allowedContactIds,
  ]);
  return (records.rows || []).map((item) => {
    const inbound = Date.parse(item.inbound_at);
    const anchor = Date.parse(item.anchor_at);
    const nominal = finalStep.timingMode === 'before_window_expiry'
      ? inbound + (1440 - finalStep.expiryOffset) * 60000
      : anchor + finalStep.delay * 60000;
    const quietOverlap = Number.isFinite(nominal) && quietHoursStatus(
      new Date(nominal), finalStep.quietHours,
    ).active;
    return {
      contact_id: item.contact_id, channel: item.channel,
      inbound_at: item.inbound_at,
      possible_quiet_overlap: quietOverlap,
    };
  });
}

module.exports = {
  listActivity, listSchedulingDiagnostics, parseActivityFilters,
  ACTIVITY_SQL, MISSING_FINAL_STEP_SQL, PAGE_SIZE,
};
