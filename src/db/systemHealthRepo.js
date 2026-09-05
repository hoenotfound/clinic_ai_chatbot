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

function newestTimestamp(...values) {
  const valid = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
  return valid.length
    ? new Date(Math.max(...valid.map((value) => value.getTime())))
    : null;
}

async function getMessagingMetrics({ hours = 24 } = {}, queryable = pool) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const [result, runtimeRows] = await Promise.all([
    queryable.query(
      `SELECT
         c.channel,
         MAX(m.created_at) FILTER (WHERE m.role = 'user') AS last_inbound_at,
         MAX(m.created_at) FILTER (
           WHERE m.role = 'assistant'
             AND m.whatsapp_message_id IS NOT NULL
             AND COALESCE(m.delivery_status, 'pending') <> 'failed'
         ) AS last_successful_outbound_at,
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
       GROUP BY c.channel`,
      [safeHours]
    ),
    messagingRuntimeHealthRepo.listRuntimeHealth(queryable),
  ]);

  const byChannel = new Map(result.rows.map((row) => [row.channel, row]));
  const runtimeByChannel = new Map(runtimeRows.map((row) => [row.channel, row]));
  return ["whatsapp", "instagram", "facebook"].map((channel) => {
    const row = byChannel.get(channel) || {};
    const runtime = runtimeByChannel.get(channel) || {};
    return {
      channel,
      lastInboundAt: row.last_inbound_at || null,
      lastSuccessfulOutboundAt: newestTimestamp(
        row.last_successful_outbound_at,
        runtime.last_outbound_accepted_at
      ),
      recentDeliveryFailures: Number(row.recent_delivery_failures) || 0,
      lastDeliveryFailureAt: row.last_delivery_failure_at || null,
    };
  });
}

module.exports = {
  getInboundProcessingMetrics,
  getMessagingMetrics,
  listAppliedMigrations,
};