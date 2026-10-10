const { pool } = require("./db");
const { beforeExpiryDueSql } = require("../utils/followUpAdaptiveTiming");
const { normalizeQuietHours, quietHoursStatus } = require("../utils/quietHours");
const { automatedRepliesEnabled } = require("../services/automaticReplyControl");

function normalizeTimingSettings(config) {
  if (!automatedRepliesEnabled() || config?.enabled !== true ||
      !["all", "staff"].includes(config.triggerMode) ||
      !Number.isFinite(Date.parse(config.activatedAt)) ||
      !Array.isArray(config.additionalSteps) || config.additionalSteps.length > 2) return null;
  const quietHours = normalizeQuietHours(config.quietHours);
  if (!quietHours) return null;
  const normalized = [config, ...config.additionalSteps].map((step) => {
    const mode = step.timingMode === "before_window_expiry" ? "before_window_expiry" : "after_reply";
    const offset = Number(step.beforeWindowExpiryMinutes ?? 120);
    const delay = mode === "before_window_expiry" ? 1440 - offset : Number(step.delayMinutes);
    return { mode, offset, delay };
  });
  if (normalized.some((s, i) => !Number.isInteger(s.delay) || s.delay < 5 ||
      s.delay > 1380 || !Number.isInteger(s.offset) || s.offset < 60 ||
      s.offset > 360 || (i > 0 && s.delay <= normalized[i - 1].delay))) return null;
  return {
    delays: normalized.map((s) => s.delay),
    modes: normalized.map((s) => s.mode),
    offsets: normalized.map((s) => s.offset),
    triggerMode: config.triggerMode, activatedAt: config.activatedAt, quietHours,
    pricingEnabled: config.pricingReminder?.enabled === true,
    pricingSocial: config.pricingReminder?.enableSocialChannels === true,
  };
}

// Exactly the same before-expiry helper, configured spacing, quiet shift and
// pricing buffer as the worker. No write or eligibility claim occurs here.
function buildScheduleSql(settings) {
  const due = `CASE WHEN ($6::text[])[next_step] = 'before_window_expiry'
    THEN ${beforeExpiryDueSql({
      inbound: "inbound_at", previous: "previous_at", step: "next_step",
      offset: "($7::integer[])[next_step]",
      gap: "(($5::integer[])[next_step] - ($5::integer[])[next_step - 1])",
      quietHours: settings.quietHours,
      reservePricingMinutes: settings.pricingEnabled ? 5 : 0,
      reservePricingOnSocial: settings.pricingSocial, channel: "channel",
    })}
    ELSE GREATEST(
      anchor_at + (($5::integer[])[next_step] * interval '1 minute'),
      COALESCE(previous_at + ((($5::integer[])[next_step] - ($5::integer[])[next_step - 1]) * interval '1 minute'),
        anchor_at + (($5::integer[])[next_step] * interval '1 minute'))
    ) END`;
  const guard = settings.pricingEnabled
    ? (settings.pricingSocial
        ? "(channel NOT IN ('whatsapp','facebook','instagram') OR next_step <> 3 OR due_at < inbound_at + interval '23 hours 35 minutes')"
        : "(channel <> 'whatsapp' OR next_step <> 3 OR due_at < inbound_at + interval '23 hours 35 minutes')")
    : "TRUE";
  return `WITH recently_active AS (
    SELECT DISTINCT contact_id FROM messages
    WHERE role = 'user' AND created_at >= now() - interval '24 hours'
  ), current_state AS (
    SELECT c.id AS contact_id, c.channel,
      inbound.created_at AS inbound_at, anchor.created_at AS anchor_at,
      COALESCE(progress.max_step, 0) + 1 AS next_step,
      prev.created_at AS previous_at, lead.treatment_interest AS service
    FROM recently_active recent
    JOIN contacts c ON c.id = recent.contact_id
    JOIN LATERAL (
      SELECT id, created_at FROM messages
      WHERE contact_id = c.id AND role = 'user'
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) inbound ON true
    JOIN LATERAL (
      SELECT id, created_at, sent_by_username, delivery_status
      FROM messages m
      WHERE m.contact_id = c.id AND role = 'assistant'
        AND m.is_automated_follow_up = false
        AND (m.created_at, m.id) > (inbound.created_at, inbound.id)
        AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
          WHERE e.message_id = m.id AND e.origin = 'system_fallback')
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) anchor ON true
    LEFT JOIN LATERAL (
      SELECT MAX(m.automated_follow_up_step) AS max_step,
        BOOL_OR(m.delivery_status IN ('failed','unknown')
          OR (m.delivery_status IS NULL AND m.whatsapp_message_id IS NULL)) AS blocked
      FROM messages m WHERE m.contact_id = c.id AND m.is_automated_follow_up = true
        AND m.automated_follow_up_for_message_id = anchor.id
    ) progress ON true
    LEFT JOIN LATERAL (
      SELECT m.created_at FROM messages m
      WHERE m.contact_id = c.id AND m.is_automated_follow_up = true
        AND m.automated_follow_up_for_message_id = anchor.id
        AND m.automated_follow_up_step = progress.max_step
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT l.id, l.treatment_interest, l.is_closed, l.appointment_status,
        s.stage_type, s.system_key
      FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
      WHERE l.contact_id = c.id
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) lead ON true
    WHERE c.channel IN ('whatsapp','facebook','instagram')
      AND ($1::text = 'all' OR c.channel = $1)
      AND ($2::integer[] IS NULL OR c.id = ANY($2::integer[]))
      AND c.needs_attention = false AND COALESCE(c.mode,'ai') <> 'human'
      AND ((c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL
        AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL)
        OR (c.channel IN ('facebook','instagram') AND c.channel_user_id IS NOT NULL
          AND c.social_opt_out_at IS NULL AND c.social_marketing_opt_out_at IS NULL))
      AND anchor.delivery_status IS DISTINCT FROM 'failed'
      AND anchor.created_at >= $4::timestamptz
      AND ($3::text = 'all' OR anchor.sent_by_username IS NOT NULL)
      AND inbound.created_at > now() - interval '23 hours 50 minutes'
      AND COALESCE(progress.blocked,false) = false
      AND (lead.id IS NULL OR (
        lead.is_closed = false AND COALESCE(lead.stage_type,'open')='open'
        AND (COALESCE(lead.appointment_status,'none') IN ('reschedule','cancelled')
          OR (COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
            AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')))
      ))
      AND NOT EXISTS (SELECT 1 FROM follow_up_ai_decisions d
        WHERE d.contact_id = c.id AND d.trigger_message_id = anchor.id
          AND d.action IN ('skip','human_review'))
  ), scheduled AS (
    SELECT current_state.*, ${due} AS due_at
    FROM current_state
    WHERE next_step BETWEEN 1 AND cardinality($5::integer[])
  ), in_window AS (
    SELECT * FROM scheduled WHERE due_at <= inbound_at + interval '23 hours 50 minutes'
      AND ${guard}
  )
  SELECT (SELECT COUNT(*)::integer FROM in_window WHERE due_at <= now()) AS due_now,
    COALESCE((SELECT jsonb_agg(to_jsonb(ordered) ORDER BY ordered.due_at, ordered.contact_id)
      FROM (SELECT contact_id, channel, next_step, due_at, inbound_at, service
        FROM in_window ORDER BY due_at, contact_id LIMIT 80) ordered), '[]'::jsonb) AS upcoming`;
}

function estimateUpcoming(rows, settings, now = new Date()) {
  const nowMs = now.getTime();
  return (rows || []).flatMap((row) => {
    const dueMs = Date.parse(row.due_at);
    const expiryMs = Date.parse(row.inbound_at) + 23 * 3600000 + 50 * 60000;
    if (!Number.isFinite(dueMs) || !Number.isFinite(expiryMs) || expiryMs <= nowMs) return [];
    const quiet = quietHoursStatus(new Date(Math.max(nowMs, dueMs)), settings.quietHours);
    const earliestMs = Math.max(nowMs, dueMs, quiet.active ? Date.parse(quiet.endsAt) : 0);
    if (earliestMs > expiryMs) return [];
    return [{
      contact_id: row.contact_id, channel: row.channel, step: Number(row.next_step),
      service: row.service || null,
      estimated_at: new Date(earliestMs).toISOString(),
      window_expires_at: new Date(expiryMs).toISOString(),
      reason: "Worker-derived estimate; all live eligibility and platform policy checks still apply",
    }];
  }).sort((a, b) => a.estimated_at.localeCompare(b.estimated_at)).slice(0,20);
}

async function getUpcomingReviewQueue(filters, allowedContactIds, config,
  execute = (sql, params) => pool.query(sql, params), now = new Date()) {
  const settings = normalizeTimingSettings(config);
  if (!settings || (Array.isArray(allowedContactIds) && allowedContactIds.length === 0)) {
    return { upcoming: [], dueNowCount: 0 };
  }
  const result = await execute(buildScheduleSql(settings), [
    filters.channel, allowedContactIds, settings.triggerMode, settings.activatedAt,
    settings.delays, settings.modes, settings.offsets,
  ]);
  const summary = result.rows[0] || {};
  const quiet = quietHoursStatus(now, settings.quietHours);
  return {
    upcoming: estimateUpcoming(summary.upcoming || [], settings, now),
    dueNowCount: quiet.active ? 0 : Number(summary.due_now || 0),
  };
}

module.exports = { getUpcomingReviewQueue, normalizeTimingSettings,
  estimateUpcoming, buildScheduleSql };
