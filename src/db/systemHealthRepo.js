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
  const [operationalResult, readinessResult, runtimeRows] = await Promise.all([
    // Preserve the pre-PR106 operational metric exactly. Setup Status uses this
    // to decide whether any successful outbound (including staff/scheduled) has
    // recovered from an earlier delivery failure.
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
    // Readiness evidence is intentionally separate from ordinary channel
    // health. It must belong to the latest inbound contact and to an explicitly
    // tagged normal AI reply; staff, scheduled, follow-up and system-fallback
    // sends cannot satisfy this query.
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
       ), readiness_evidence AS (
         SELECT
           li.channel,
           li.contact_id,
           li.inbound_message_id,
           li.last_inbound_at,
           MAX(e.accepted_at) FILTER (
             WHERE e.origin = 'ai_reply' AND e.accepted = true
           ) AS last_verified_ai_reply_at,
           MAX(e.attempted_at) FILTER (
             WHERE e.origin = 'ai_reply' AND e.accepted = false
           ) AS last_ai_reply_failure_at
         FROM latest_inbound li
         LEFT JOIN messages reply
           ON reply.contact_id = li.contact_id
          AND reply.role = 'assistant'
          AND reply.created_at > li.last_inbound_at
         LEFT JOIN outbound_message_evidence e
           ON e.message_id = reply.id
          AND e.contact_id = li.contact_id
          AND e.channel = li.channel
         GROUP BY li.channel, li.contact_id, li.inbound_message_id, li.last_inbound_at
       )
       SELECT
         channels.channel,
         re.contact_id AS last_inbound_contact_id,
         re.inbound_message_id AS last_inbound_message_id,
         re.last_inbound_at,
         re.last_verified_ai_reply_at,
         re.last_ai_reply_failure_at
       FROM (VALUES ('whatsapp'), ('instagram'), ('facebook')) AS channels(channel)
       LEFT JOIN readiness_evidence re ON re.channel = channels.channel
       ORDER BY channels.channel`
    ),
    messagingRuntimeHealthRepo.listRuntimeHealth(queryable),
  ]);

  const operationalByChannel = new Map(
    operationalResult.rows.map((row) => [row.channel, row])
  );
  const readinessByChannel = new Map(
    readinessResult.rows.map((row) => [row.channel, row])
  );
  const runtimeByChannel = new Map(runtimeRows.map((row) => [row.channel, row]));

  return ["whatsapp", "instagram", "facebook"].map((channel) => {
    const operational = operationalByChannel.get(channel) || {};
    const readiness = readinessByChannel.get(channel) || {};
    const runtime = runtimeByChannel.get(channel) || {};
    return {
      channel,
      // Existing operational fields keep their original meaning for Setup Status.
      lastInboundAt: operational.last_inbound_at || readiness.last_inbound_at || null,
      lastSuccessfulOutboundAt: newestTimestamp(
        operational.last_successful_outbound_at,
        runtime.last_outbound_accepted_at
      ),
      recentDeliveryFailures: Number(operational.recent_delivery_failures) || 0,
      lastDeliveryFailureAt: operational.last_delivery_failure_at || null,

      // PR106-only go-live evidence. These are exact-message signals and are not
      // used to redefine ordinary channel health/recovery behavior.
      lastInboundContactId: readiness.last_inbound_contact_id == null
        ? null
        : Number(readiness.last_inbound_contact_id),
      lastInboundMessageId: readiness.last_inbound_message_id == null
        ? null
        : Number(readiness.last_inbound_message_id),
      lastVerifiedAutomatedReplyAt: readiness.last_verified_ai_reply_at || null,
      lastReadinessDeliveryFailureAt: readiness.last_ai_reply_failure_at || null,
      roundTripCorrelated: Boolean(
        readiness.last_inbound_at && readiness.last_verified_ai_reply_at
      ),
    };
  });
}

module.exports = {
  getInboundProcessingMetrics,
  getMessagingMetrics,
  listAppliedMigrations,
  newestTimestamp,
};
