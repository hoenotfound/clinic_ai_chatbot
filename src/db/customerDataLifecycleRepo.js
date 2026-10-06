const crypto = require("crypto");
const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const PURGE_PROCESSING_STALE_MINUTES = 10;
const PURGE_JOB_RETENTION_DAYS = 30;

function positiveContactId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeJsonArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

const RETENTION_ACTIVITY_SQL = `
  GREATEST(
    c.created_at,
    c.updated_at,
    COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.contact_id = c.id), c.created_at),
    COALESCE((SELECT MAX(l.updated_at) FROM leads l WHERE l.contact_id = c.id), c.created_at),
    COALESCE((SELECT MAX(n.created_at) FROM contact_notes n WHERE n.contact_id = c.id), c.created_at)
  )
`;

const NO_ACTIVE_CUSTOMER_WORK_SQL = `
  c.mode = 'ai'
  AND c.needs_attention = false
  AND c.needs_follow_up = false
  AND NOT EXISTS (
    SELECT 1
    FROM leads active_lead
    WHERE active_lead.contact_id = c.id
      AND active_lead.is_closed = false
      AND (
        active_lead.next_follow_up_at >= now()
        OR active_lead.appointment_at >= now()
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM scheduled_messages s
    WHERE s.contact_id = c.id
      AND s.status IN ('scheduled', 'processing')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM inbound_processing_jobs j
    WHERE j.contact_id = c.id
      AND j.terminal_at IS NULL
      AND j.status IN ('pending', 'processing', 'failed')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM whatsapp_outbound_retries r
    WHERE r.contact_id = c.id
      AND r.status IN ('scheduled', 'processing', 'attention_pending')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM follow_up_ai_generation_claims g
    WHERE g.contact_id = c.id
      AND g.claimed_at > now() - interval '10 minutes'
  )
`;

async function listRetentionCandidates({
  cutoff,
  limit = 25,
  database = pool,
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const cutoffDate = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (Number.isNaN(cutoffDate.getTime())) {
    throw new TypeError("A valid retention cutoff is required.");
  }

  const result = await database.query(
    `SELECT c.id, ${RETENTION_ACTIVITY_SQL} AS last_activity_at
     FROM contacts c
     WHERE ${RETENTION_ACTIVITY_SQL} < $1::timestamptz
       AND ${NO_ACTIVE_CUSTOMER_WORK_SQL}
     ORDER BY last_activity_at ASC, c.id ASC
     LIMIT $2`,
    [cutoffDate.toISOString(), safeLimit]
  );
  return result.rows;
}

async function purgeContactData({
  contactId,
  reason = "manual",
  requestedBy = null,
  mediaPrefixes = [],
  retentionCutoff = null,
} = {}, database = pool) {
  const id = positiveContactId(contactId);
  if (!id) throw new TypeError("contactId must be a positive integer.");
  if (!["manual", "retention"].includes(reason)) {
    throw new TypeError("reason must be manual or retention.");
  }

  const prefixes = normalizeJsonArray(mediaPrefixes);
  const ownsClient = database === pool;
  const client = ownsClient ? await pool.connect() : database;

  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock($1::integer, $2::integer)`,
      [CONVERSATION_LOCK_NAMESPACE, id]
    );

    const contactResult = await client.query(
      `SELECT id, channel, channel_user_id, whatsapp_number
       FROM contacts
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const contact = contactResult.rows[0];
    if (!contact) {
      await client.query("COMMIT");
      return { status: "not_found" };
    }

    if (reason === "retention") {
      const cutoffDate =
        retentionCutoff instanceof Date ? retentionCutoff : new Date(retentionCutoff);
      if (Number.isNaN(cutoffDate.getTime())) {
        throw new TypeError("retentionCutoff is required for retention purges.");
      }
      const eligible = await client.query(
        `SELECT 1
         FROM contacts c
         WHERE c.id = $1
           AND ${RETENTION_ACTIVITY_SQL} < $2::timestamptz
           AND ${NO_ACTIVE_CUSTOMER_WORK_SQL}`,
        [id, cutoffDate.toISOString()]
      );
      if (!eligible.rows[0]) {
        await client.query("COMMIT");
        return { status: "ineligible" };
      }
    }

    const [mediaResult, countResult] = await Promise.all([
      client.query(
        `SELECT DISTINCT media_key
         FROM messages
         WHERE contact_id = $1
           AND media_key IS NOT NULL
           AND BTRIM(media_key) <> ''`,
        [id]
      ),
      client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM messages WHERE contact_id = $1) AS messages,
           (SELECT COUNT(*)::int FROM leads WHERE contact_id = $1) AS leads,
           (SELECT COUNT(*)::int FROM contact_notes WHERE contact_id = $1) AS notes`,
        [id]
      ),
    ]);

    const mediaKeys = normalizeJsonArray(
      mediaResult.rows.map((row) => row.media_key)
    );
    let pendingAttributions = 0;
    let commentJobs = 0;
    const externalUserId =
      contact.channel === "whatsapp"
        ? null
        : String(contact.channel_user_id || "").trim() || null;

    if (externalUserId && ["facebook", "instagram"].includes(contact.channel)) {
      const attributionDelete = await client.query(
        `DELETE FROM pending_lead_attributions
         WHERE channel = $1 AND external_user_id = $2`,
        [contact.channel, externalUserId]
      );
      pendingAttributions = attributionDelete.rowCount || 0;

      const commentDelete = await client.query(
        `DELETE FROM meta_comment_automation_jobs
         WHERE channel = $1
           AND (
             author_id = $2
             OR private_reply_recipient_id = $2
           )
         RETURNING channel, comment_id`,
        [contact.channel, externalUserId]
      );
      commentJobs = commentDelete.rowCount || 0;

      if (commentDelete.rows.length > 0) {
        await client.query(
          `INSERT INTO customer_data_deleted_comment_ids (
             channel,
             comment_id,
             deleted_at,
             expires_at
           )
           SELECT
             deleted.channel,
             deleted.comment_id,
             now(),
             now() + interval '30 days'
           FROM jsonb_to_recordset($1::jsonb)
             AS deleted(channel TEXT, comment_id TEXT)
           WHERE deleted.comment_id IS NOT NULL
             AND BTRIM(deleted.comment_id) <> ''
           ON CONFLICT (channel, comment_id) DO UPDATE
           SET deleted_at = EXCLUDED.deleted_at,
               expires_at = GREATEST(
                 customer_data_deleted_comment_ids.expires_at,
                 EXCLUDED.expires_at
               )`,
          [JSON.stringify(commentDelete.rows)]
        );
      }
    }

    const tombstoneResult = await client.query(
      `INSERT INTO customer_data_deleted_message_ids (
         provider_message_id,
         deleted_at,
         expires_at
       )
       SELECT DISTINCT
         m.whatsapp_message_id,
         now(),
         now() + interval '30 days'
       FROM messages m
       WHERE m.contact_id = $1
         AND m.whatsapp_message_id IS NOT NULL
         AND BTRIM(m.whatsapp_message_id) <> ''
       ON CONFLICT (provider_message_id) DO UPDATE
       SET deleted_at = EXCLUDED.deleted_at,
           expires_at = GREATEST(
             customer_data_deleted_message_ids.expires_at,
             EXCLUDED.expires_at
           )
       RETURNING provider_message_id`,
      [id]
    );

    const deletedCounts = {
      messages: Number(countResult.rows[0]?.messages) || 0,
      leads: Number(countResult.rows[0]?.leads) || 0,
      notes: Number(countResult.rows[0]?.notes) || 0,
      pendingAttributions,
      commentJobs,
      providerMessageTombstones: tombstoneResult.rowCount || 0,
      providerCommentTombstones: commentJobs,
    };

    const jobResult = await client.query(
      `INSERT INTO customer_data_purge_jobs (
         contact_id,
         reason,
         requested_by,
         media_keys,
         media_prefixes,
         deleted_counts
       )
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
       RETURNING *`,
      [
        id,
        reason,
        requestedBy ? String(requestedBy).slice(0, 120) : null,
        JSON.stringify(mediaKeys),
        JSON.stringify(prefixes),
        JSON.stringify(deletedCounts),
      ]
    );

    const deletedContact = await client.query(
      "DELETE FROM contacts WHERE id = $1 RETURNING id",
      [id]
    );
    if (!deletedContact.rows[0]) {
      throw new Error("Customer disappeared during purge transaction.");
    }

    await client.query("COMMIT");
    return {
      status: "purged",
      job: jobResult.rows[0],
      deletedCounts,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    contact_id: Number(row.contact_id),
    attempts: Number(row.attempts || 0),
    media_keys: Array.isArray(row.media_keys) ? row.media_keys : [],
    media_prefixes: Array.isArray(row.media_prefixes) ? row.media_prefixes : [],
    deleted_counts:
      row.deleted_counts && typeof row.deleted_counts === "object"
        ? row.deleted_counts
        : {},
  };
}

async function claimPurgeJob({
  jobId = null,
  leaseToken = crypto.randomUUID(),
  database = pool,
} = {}) {
  const id = jobId == null ? null : Number(jobId);
  if (id != null && (!Number.isSafeInteger(id) || id < 1)) {
    throw new TypeError("jobId must be a positive integer.");
  }

  const result = await database.query(
    `WITH candidate AS (
       SELECT id
       FROM customer_data_purge_jobs
       WHERE ($1::bigint IS NULL OR id = $1)
         AND (
           (status IN ('pending', 'failed') AND next_attempt_at <= now())
           OR (
             status = 'processing'
             AND claimed_at <= now() - ($3::integer * interval '1 minute')
           )
         )
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE customer_data_purge_jobs job
     SET status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = now(),
         lease_token = $2,
         last_error = NULL,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.*`,
    [id, leaseToken, PURGE_PROCESSING_STALE_MINUTES]
  );

  return normalizeJob(result.rows[0]);
}

async function markPurgeJobCompleted({
  jobId,
  leaseToken,
  database = pool,
} = {}) {
  const result = await database.query(
    `UPDATE customer_data_purge_jobs
     SET status = 'completed',
         completed_at = now(),
         lease_token = NULL,
         claimed_at = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING *`,
    [jobId, leaseToken]
  );
  return normalizeJob(result.rows[0]);
}

async function markPurgeJobFailed({
  jobId,
  leaseToken,
  error,
  attempts = 1,
  database = pool,
} = {}) {
  const safeAttempts = Math.max(1, Number(attempts) || 1);
  const retrySeconds = Math.min(6 * 60 * 60, 30 * 2 ** Math.min(10, safeAttempts - 1));
  const result = await database.query(
    `UPDATE customer_data_purge_jobs
     SET status = 'failed',
         next_attempt_at = now() + ($4::integer * interval '1 second'),
         lease_token = NULL,
         claimed_at = NULL,
         last_error = $3,
         updated_at = now()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING *`,
    [
      jobId,
      leaseToken,
      String(error?.message || error || "Customer media cleanup failed.").slice(0, 2000),
      retrySeconds,
    ]
  );
  return normalizeJob(result.rows[0]);
}

async function pruneCompletedPurgeJobs({
  olderThanDays = PURGE_JOB_RETENTION_DAYS,
  database = pool,
} = {}) {
  const days = Math.max(1, Math.min(365, Number(olderThanDays) || PURGE_JOB_RETENTION_DAYS));
  const [jobsResult, messageTombstonesResult, commentTombstonesResult] = await Promise.all([
    database.query(
      `DELETE FROM customer_data_purge_jobs
       WHERE status = 'completed'
         AND completed_at < now() - ($1::integer * interval '1 day')`,
      [days]
    ),
    database.query(
      `DELETE FROM customer_data_deleted_message_ids
       WHERE expires_at <= now()`
    ),
    database.query(
      `DELETE FROM customer_data_deleted_comment_ids
       WHERE expires_at <= now()`
    ),
  ]);
  return {
    purgeJobs: jobsResult.rowCount || 0,
    messageTombstones: messageTombstonesResult.rowCount || 0,
    commentTombstones: commentTombstonesResult.rowCount || 0,
  };
}

module.exports = {
  PURGE_JOB_RETENTION_DAYS,
  PURGE_PROCESSING_STALE_MINUTES,
  claimPurgeJob,
  listRetentionCandidates,
  markPurgeJobCompleted,
  markPurgeJobFailed,
  normalizeJob,
  pruneCompletedPurgeJobs,
  purgeContactData,
};
