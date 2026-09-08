const { pool } = require("./db");
const messagingRuntimeHealthRepo = require("./messagingRuntimeHealthRepo");

async function listAppliedMigrations(queryable = pool) {
  const result = await queryable.query(
    `SELECT version, name, checksum, applied_at
     FROM schema_migrations
     ORDER BY version ASC`
  );
  return result.rows;
}

async function getInboundProcessingMetrics({ hours = 24 } = {}, queryable = pool) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const [messageJobs, resolutionJobs, failures, recoveries] = await Promise.all([
    queryable.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE j.terminal_at IS NULL AND j.status = 'pending'
         )::int AS pending_count,
         COUNT(*) FILTER (
           WHERE j.terminal_at IS NULL AND j.status = 'processing'
         )::int AS processing_count,
         COUNT(*) FILTER (
           WHERE j.terminal_at IS NULL AND j.status = 'failed'
         )::int AS retryable_failed_count,
         COUNT(*) FILTER (
           WHERE j.terminal_at IS NOT NULL
             AND j.terminal_at >= NOW() - ($1::int * interval '1 hour')
             AND EXISTS (
               SELECT 1
               FROM contacts c
               WHERE c.id = j.contact_id
                 AND c.needs_attention = true
             )
         )::int AS terminal_count,
         MIN(j.created_at) FILTER (
           WHERE j.terminal_at IS NULL AND j.status IN ('pending', 'processing', 'failed')
         ) AS oldest_open_at
       FROM inbound_processing_jobs j`,
      [safeHours]
    ),
    queryable.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE terminal_at IS NULL AND status = 'pending'
         )::int AS pending_count,
         COUNT(*) FILTER (
           WHERE terminal_at IS NULL AND status = 'processing'
         )::int AS processing_count,
         COUNT(*) FILTER (
           WHERE terminal_at IS NULL AND status = 'failed'
         )::int AS retryable_failed_count,
         COUNT(*) FILTER (
           WHERE terminal_at IS NOT NULL
             AND terminal_at >= NOW() - ($1::int * interval '1 hour')
         )::int AS terminal_count,
         MIN(created_at) FILTER (
           WHERE terminal_at IS NULL AND status IN ('pending', 'processing', 'failed')
         ) AS oldest_open_at
       FROM inbound_meta_resolution_jobs`,
      [safeHours]
    ),
    queryable.query(
      `SELECT COUNT(*)::int AS failed_jobs
       FROM (
         SELECT DISTINCT job_type, job_id
         FROM inbound_failure_events
         WHERE failed_at >= NOW() - ($1::int * interval '1 hour')
       ) recent_failures`,
      [safeHours]
    ),
    queryable.query(
      `SELECT COUNT(*)::int AS restart_recoveries
       FROM inbound_recovery_events
       WHERE recovered_at >= NOW() - ($1::int * interval '1 hour')`,
      [safeHours]
    ),
  ]);

  const message = messageJobs.rows[0] || {};
  const resolution = resolutionJobs.rows[0] || {};
  const oldestCandidates = [message.oldest_open_at, resolution.oldest_open_at]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
  const oldestOpenAt = oldestCandidates.length
    ? new Date(Math.min(...oldestCandidates.map((value) => value.getTime())))
    : null;

  return {
    windowHours: safeHours,
    pendingCount: (Number(message.pending_count) || 0) + (Number(resolution.pending_count) || 0),
    processingCount: (Number(message.processing_count) || 0) + (Number(resolution.processing_count) || 0),
    retryableFailedCount: (Number(message.retryable_failed_count) || 0) + (Number(resolution.retryable_failed_count) || 0),
    failedJobs: Number(failures.rows[0]?.failed_jobs) || 0,
    terminalFailures: (Number(message.terminal_count) || 0) + (Number(resolution.terminal_count) || 0),
    restartRecoveries: Number(recoveries.rows[0]?.restart_recoveries) || 0,
    oldestOpenAt,
  };
}

function timestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function socialRoundTripAccepted(replyCandidate, runtimeAccepted) {
  const candidate = timestamp(replyCandidate);
  const accepted = timestamp(runtimeAccepted);
  if (!candidate || !accepted) return null;
  return accepted.getTime() >= candidate.getTime() ? candidate : null;
}

async function getMessagingMetrics({ hours = 24 } = {}, queryable = pool) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const [result, runtimeRows] = await Promise.all([
    queryable.query(
      `WITH latest_inbound AS (
         SELECT DISTINCT ON (c.channel)
           c.channel,
           m.contact_id,
           m.id AS inbound_message_id,
           m.created_at AS last_inbound_at
         FROM contacts c
         JOIN messages m ON m.contact_id = c.id
         WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
           AND m.role = 'user'
         ORDER BY c.channel, m.created_at DESC, m.id DESC
       ), correlated_reply AS (
         SELECT
           li.channel,
           li.contact_id,
           li.inbound_message_id,
           li.last_inbound_at,
           MAX(m.created_at) FILTER (
             WHERE m.role = 'assistant'
               AND m.created_at > li.last_inbound_at
               AND m.sent_by_username IS NULL
               AND COALESCE(m.is_automated_follow_up, false) = false
               AND COALESCE(m.delivery_status, 'pending') NOT IN ('failed', 'unknown')
               AND (
                 li.channel <> 'whatsapp'
                 OR m.whatsapp_message_id IS NOT NULL
               )
           ) AS last_correlated_outbound_at
         FROM latest_inbound li
         LEFT JOIN messages m ON m.contact_id = li.contact_id
         GROUP BY li.channel, li.contact_id, li.inbound_message_id, li.last_inbound_at
       ), channel_failures AS (
         SELECT
           c.channel,
           COUNT(*) FILTER (
             WHERE m.role = 'assistant'
               AND m.delivery_status = 'failed'
               AND m.created_at >= NOW() - ($1::int * interval '1 hour')
           )::int AS recent_delivery_failures,
           MAX(m.created_at) FILTER (
             WHERE m.role = 'assistant'
               AND m.delivery_status = 'failed'
           ) AS last_delivery_failure_at
         FROM contacts c
         LEFT JOIN messages m ON m.contact_id = c.id
         WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
         GROUP BY c.channel
       )
       SELECT
         channels.channel,
         cr.contact_id AS last_inbound_contact_id,
         cr.inbound_message_id AS last_inbound_message_id,
         cr.last_inbound_at,
         cr.last_correlated_outbound_at,
         COALESCE(cf.recent_delivery_failures, 0)::int AS recent_delivery_failures,
         cf.last_delivery_failure_at
       FROM (VALUES ('whatsapp'), ('instagram'), ('facebook')) AS channels(channel)
       LEFT JOIN correlated_reply cr ON cr.channel = channels.channel
       LEFT JOIN channel_failures cf ON cf.channel = channels.channel
       ORDER BY channels.channel`,
      [safeHours]
    ),
    messagingRuntimeHealthRepo.listRuntimeHealth(queryable),
  ]);

  const byChannel = new Map(result.rows.map((row) => [row.channel, row]));
  const runtimeByChannel = new Map(runtimeRows.map((row) => [row.channel, row]));
  return ["whatsapp", "instagram", "facebook"].map((channel) => {
    const row = byChannel.get(channel) || {};
    const runtime = runtimeByChannel.get(channel) || {};
    const correlatedOutbound = channel === "whatsapp"
      ? timestamp(row.last_correlated_outbound_at)
      : socialRoundTripAccepted(
          row.last_correlated_outbound_at,
          runtime.last_outbound_accepted_at
        );
    return {
      channel,
      lastInboundAt: row.last_inbound_at || null,
      lastInboundContactId: row.last_inbound_contact_id == null
        ? null
        : Number(row.last_inbound_contact_id),
      lastInboundMessageId: row.last_inbound_message_id == null
        ? null
        : Number(row.last_inbound_message_id),
      lastSuccessfulOutboundAt: correlatedOutbound,
      roundTripCorrelated: Boolean(row.last_inbound_at && correlatedOutbound),
      recentDeliveryFailures: Number(row.recent_delivery_failures) || 0,
      lastDeliveryFailureAt: row.last_delivery_failure_at || null,
    };
  });
}

module.exports = {
  getInboundProcessingMetrics,
  getMessagingMetrics,
  listAppliedMigrations,
  socialRoundTripAccepted,
};
