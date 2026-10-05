const crypto = require("crypto");
const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const MAX_INCOMING_PAYLOAD_BYTES = 128 * 1024;
const PROCESSING_OWNER_ID = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;

const MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  (media_key IS NOT NULL) AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error,
  is_automated_follow_up
`;

const JOB_COLUMNS = `
  id,
  message_id,
  contact_id,
  channel,
  incoming_payload,
  status,
  attempts,
  prepared_at,
  was_first_message,
  claimed_at,
  lease_owner,
  completed_at,
  terminal_at,
  last_error,
  created_at,
  updated_at
`;

const META_RESOLUTION_JOB_COLUMNS = `
  id,
  channel,
  external_message_id,
  entry_id,
  incoming_payload,
  status,
  attempts,
  claimed_at,
  lease_owner,
  completed_at,
  terminal_at,
  last_error,
  created_at,
  updated_at
`;

function serializeIncoming(incoming) {
  const json = JSON.stringify(incoming || {});
  if (Buffer.byteLength(json, "utf8") > MAX_INCOMING_PAYLOAD_BYTES) {
    throw new Error("Inbound processing payload is unexpectedly large.");
  }
  return json;
}

function safeOwnerId(ownerId) {
  const text = String(ownerId || PROCESSING_OWNER_ID).trim();
  return text || PROCESSING_OWNER_ID;
}

function whatsappMessageSourceCreatedAt(channel, incoming, nowMs = Date.now()) {
  if (channel !== "whatsapp") return null;

  const seconds = Number(incoming?.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const sourceMs = seconds * 1000;
  if (!Number.isFinite(sourceMs)) return null;

  // Meta's message timestamp is the policy clock we care about. Never allow a
  // provider/client clock that is ahead of this server to extend the 24-hour
  // window beyond when we actually received and persisted the webhook.
  const boundedMs = Math.min(sourceMs, Number(nowMs));
  if (!Number.isFinite(boundedMs) || boundedMs <= 0) return null;
  return new Date(boundedMs).toISOString();
}

/**
 * Atomically stores the inbound customer message and the durable processing
 * job that represents the remaining reply work. A Meta retry races safely on
 * messages.whatsapp_message_id: exactly one INSERT wins and only that winner
 * receives a processing job.
 */
async function storeInboundClaim({
  contactId,
  content,
  storedMessageId,
  channel,
  incoming,
}, database = pool) {
  const payload = serializeIncoming(incoming);
  const sourceCreatedAt = whatsappMessageSourceCreatedAt(channel, incoming);
  const result = await database.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), inserted_message AS (
       INSERT INTO messages (
         contact_id, role, content, whatsapp_message_id, source_created_at
       )
       SELECT $1, 'user', $2, $3, $6::timestamptz
       FROM conversation_lock
       ON CONFLICT (whatsapp_message_id) DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}
     ), inserted_job AS (
       INSERT INTO inbound_processing_jobs (
         message_id, contact_id, channel, incoming_payload
       )
       SELECT id, contact_id, $4, $5::jsonb
       FROM inserted_message
       RETURNING ${JOB_COLUMNS}
     )
     SELECT
       row_to_json(m.*) AS saved_inbound,
       row_to_json(j.*) AS processing_job,
       NOT EXISTS (
         SELECT 1
         FROM messages earlier
         WHERE earlier.contact_id = m.contact_id
           AND earlier.id < m.id
       ) AS derived_first_message
     FROM inserted_message m
     JOIN inserted_job j ON j.message_id = m.id`,
    [contactId, content, storedMessageId, channel, payload, sourceCreatedAt]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    savedInbound: row.saved_inbound,
    processingJob: row.processing_job,
    // Capture the journey boundary at persistence time. Later rapid-fire
    // messages may already exist by the time reply preparation runs, but they
    // must not make the genuine first message lose its first-contact behavior.
    derivedFirstMessage: Boolean(row.derived_first_message),
  };
}

async function reserveOutboundAttempt({
  processingJobId,
  contactId,
  content,
  origin,
}, database = pool) {
  const safeJobId = Number(processingJobId);
  const safeContactId = Number(contactId);
  const safeOrigin = String(origin || "").trim();
  if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) {
    throw new TypeError("processingJobId must be a positive integer.");
  }
  if (!Number.isSafeInteger(safeContactId) || safeContactId < 1) {
    throw new TypeError("contactId must be a positive integer.");
  }
  if (!["ai_reply", "system_fallback"].includes(safeOrigin)) {
    throw new TypeError("origin must be ai_reply or system_fallback.");
  }

  // The production default is the shared Pool. Tests and transactional
  // callers may pass an already-connected queryable client, which must never
  // be connected a second time.
  const ownsClient = database === pool;
  const client = ownsClient ? await pool.connect() : database;
  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `SELECT id, message_id, contact_id, status, terminal_at
       FROM inbound_processing_jobs
       WHERE id = $1
       FOR UPDATE`,
      [safeJobId]
    );
    const job = jobResult.rows[0];
    if (
      !job ||
      Number(job.contact_id) !== safeContactId ||
      job.status !== "processing" ||
      job.terminal_at
    ) {
      const err = new Error("Inbound processing job is not available for outbound delivery.");
      err.code = "INBOUND_JOB_NOT_SENDABLE";
      throw err;
    }

    const existing = await client.query(
      `SELECT
         a.processing_job_id,
         a.inbound_message_id,
         a.assistant_message_id,
         a.contact_id,
         a.origin,
         a.outcome,
         a.provider_message_id,
         a.error_text,
         a.started_at,
         a.finalized_at,
         m.whatsapp_message_id,
         m.delivery_status,
         m.delivery_error
       FROM inbound_outbound_attempts a
       LEFT JOIN messages m ON m.id = a.assistant_message_id
       WHERE a.processing_job_id = $1`,
      [safeJobId]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { alreadyStarted: true, attempt: existing.rows[0], message: null };
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,
      [safeContactId]
    );
    const messageResult = await client.query(
      `INSERT INTO messages (contact_id, role, content)
       VALUES ($1, 'assistant', $2)
       RETURNING ${MESSAGE_COLUMNS}`,
      [safeContactId, String(content || "")]
    );
    const message = messageResult.rows[0];

    const attemptResult = await client.query(
      `INSERT INTO inbound_outbound_attempts (
         processing_job_id,
         inbound_message_id,
         assistant_message_id,
         contact_id,
         origin
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING processing_job_id, inbound_message_id, assistant_message_id,
                 contact_id, origin, outcome, provider_message_id, error_text,
                 started_at, finalized_at`,
      [safeJobId, job.message_id, message.id, safeContactId, safeOrigin]
    );

    await client.query("COMMIT");
    return {
      alreadyStarted: false,
      attempt: attemptResult.rows[0],
      message,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

async function cancelOutboundAttempt(processingJobId, database = pool) {
  const safeJobId = Number(processingJobId);
  if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) {
    throw new TypeError("processingJobId must be a positive integer.");
  }

  const ownsClient = database === pool;
  const client = ownsClient ? await pool.connect() : database;
  try {
    await client.query("BEGIN");

    const stateResult = await client.query(
      `SELECT
         processing_job_id,
         assistant_message_id,
         outcome,
         provider_message_id
       FROM inbound_outbound_attempts
       WHERE processing_job_id = $1
       FOR UPDATE`,
      [safeJobId]
    );
    const state = stateResult.rows[0];
    if (!state) {
      await client.query("COMMIT");
      return null;
    }

    let messageState = null;
    if (state.assistant_message_id) {
      const messageResult = await client.query(
        `SELECT whatsapp_message_id, delivery_status
         FROM messages
         WHERE id = $1
         FOR UPDATE`,
        [state.assistant_message_id]
      );
      messageState = messageResult.rows[0] || null;
    }

    const deliveryStatus = String(messageState?.delivery_status || "").toLowerCase();
    const providerEvidenceExists =
      Boolean(state.provider_message_id) ||
      Boolean(messageState?.whatsapp_message_id) ||
      ["pending", "sent", "delivered", "read", "failed"].includes(deliveryStatus);

    if (
      providerEvidenceExists ||
      ["accepted", "rejected", "ambiguous"].includes(String(state.outcome || "").toLowerCase())
    ) {
      await client.query("COMMIT");
      return { cancelled: false, state };
    }

    await client.query(
      `UPDATE inbound_outbound_attempts
       SET outcome = 'cancelled',
           provider_message_id = NULL,
           error_text = NULL,
           finalized_at = COALESCE(finalized_at, NOW()),
           updated_at = NOW()
       WHERE processing_job_id = $1`,
      [safeJobId]
    );

    if (state.assistant_message_id) {
      await client.query(
        `DELETE FROM messages
         WHERE id = $1
           AND role = 'assistant'
           AND whatsapp_message_id IS NULL
           AND delivery_status IS NULL`,
        [state.assistant_message_id]
      );
    }

    const result = await client.query(
      `SELECT processing_job_id, inbound_message_id, assistant_message_id,
              contact_id, origin, outcome, provider_message_id, error_text,
              started_at, finalized_at
       FROM inbound_outbound_attempts
       WHERE processing_job_id = $1`,
      [safeJobId]
    );

    await client.query("COMMIT");
    return { cancelled: true, attempt: result.rows[0] || null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

async function getOutboundAttempt(processingJobId, database = pool) {
  const safeJobId = Number(processingJobId);
  if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) return null;

  const result = await database.query(
    `SELECT
       a.processing_job_id,
       a.inbound_message_id,
       a.assistant_message_id,
       a.contact_id,
       a.origin,
       a.outcome,
       a.provider_message_id,
       a.error_text,
       a.started_at,
       a.finalized_at,
       m.whatsapp_message_id,
       m.delivery_status,
       m.delivery_error
     FROM inbound_outbound_attempts a
     LEFT JOIN messages m ON m.id = a.assistant_message_id
     WHERE a.processing_job_id = $1`,
    [safeJobId]
  );
  const attempt = result.rows[0] || null;
  if (!attempt?.assistant_message_id) return attempt;

  // Keep the inbound-processing repository usable in isolated tests and during
  // startup/migration boundaries where migration 039 may not exist yet. Retry
  // ownership is additive recovery metadata, not a prerequisite for reading
  // the durable outbound attempt itself.
  try {
    const retryResult = await database.query(
      `SELECT status, processing_kind
       FROM whatsapp_outbound_retries
       WHERE message_id = $1`,
      [attempt.assistant_message_id]
    );
    const retry = retryResult.rows[0] || null;
    attempt.whatsapp_retry_status = retry?.status || null;
    attempt.whatsapp_retry_processing_kind = retry?.processing_kind || null;
  } catch (err) {
    if (err?.code !== "42P01") throw err;
    attempt.whatsapp_retry_status = null;
    attempt.whatsapp_retry_processing_kind = null;
  }

  return attempt;
}

async function finalizeOutboundAttempt(
  processingJobId,
  { outcome, providerMessageId = null, errorText = null } = {},
  database = pool
) {
  const safeJobId = Number(processingJobId);
  const safeOutcome = String(outcome || "").trim();
  if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) {
    throw new TypeError("processingJobId must be a positive integer.");
  }
  if (!["accepted", "rejected", "cancelled", "ambiguous"].includes(safeOutcome)) {
    throw new TypeError("outcome must be accepted, rejected, cancelled or ambiguous.");
  }

  const result = await database.query(
    `UPDATE inbound_outbound_attempts
     SET outcome = $2,
         provider_message_id = $3,
         error_text = $4,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE processing_job_id = $1
     RETURNING processing_job_id, inbound_message_id, assistant_message_id,
               contact_id, origin, outcome, provider_message_id, error_text,
               started_at, finalized_at`,
    [
      safeJobId,
      safeOutcome,
      providerMessageId ? String(providerMessageId) : null,
      errorText ? String(errorText).slice(0, 1000) : null,
    ]
  );
  return result.rows[0] || null;
}

async function finalizeOutboundAttemptByAssistantMessageId(
  assistantMessageId,
  { outcome, providerMessageId = null, errorText = null } = {},
  database = pool
) {
  const safeMessageId = Number(assistantMessageId);
  const safeOutcome = String(outcome || "").trim();
  if (!Number.isSafeInteger(safeMessageId) || safeMessageId < 1) {
    throw new TypeError("assistantMessageId must be a positive integer.");
  }
  if (!["accepted", "rejected", "cancelled", "ambiguous"].includes(safeOutcome)) {
    throw new TypeError("outcome must be accepted, rejected, cancelled or ambiguous.");
  }

  const result = await database.query(
    `UPDATE inbound_outbound_attempts
     SET outcome = $2,
         provider_message_id = $3,
         error_text = $4,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE assistant_message_id = $1
     RETURNING processing_job_id, inbound_message_id, assistant_message_id,
               contact_id, origin, outcome, provider_message_id, error_text,
               started_at, finalized_at`,
    [
      safeMessageId,
      safeOutcome,
      providerMessageId ? String(providerMessageId) : null,
      errorText ? String(errorText).slice(0, 1000) : null,
    ]
  );
  return result.rows[0] || null;
}

async function markOutboundAttemptAmbiguous(
  processingJobId,
  errorText,
  database = pool
) {
  const safeJobId = Number(processingJobId);
  if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) {
    throw new TypeError("processingJobId must be a positive integer.");
  }
  const safeError = String(
    errorText ||
      "Delivery could not be confirmed because the server restarted during this automated reply."
  ).slice(0, 1000);

  const ownsClient = database === pool;
  const client = ownsClient ? await pool.connect() : database;
  try {
    await client.query("BEGIN");
    const stateResult = await client.query(
      `SELECT
         a.outcome,
         a.provider_message_id,
         a.assistant_message_id,
         m.whatsapp_message_id,
         m.delivery_status
       FROM inbound_outbound_attempts a
       JOIN messages m ON m.id = a.assistant_message_id
       WHERE a.processing_job_id = $1
       FOR UPDATE OF a, m`,
      [safeJobId]
    );
    const state = stateResult.rows[0];
    if (!state) {
      await client.query("COMMIT");
      return null;
    }

    const deliveryStatus = String(state.delivery_status || "").toLowerCase();
    const durableOutcomeExists =
      Boolean(state.outcome) ||
      Boolean(state.provider_message_id) ||
      Boolean(state.whatsapp_message_id) ||
      ["pending", "sent", "delivered", "read", "failed"].includes(deliveryStatus);

    if (durableOutcomeExists) {
      await client.query("COMMIT");
      return { marked: false, state };
    }

    await client.query(
      `UPDATE inbound_outbound_attempts
       SET outcome = 'ambiguous',
           error_text = $2,
           finalized_at = COALESCE(finalized_at, NOW()),
           updated_at = NOW()
       WHERE processing_job_id = $1`,
      [safeJobId, safeError]
    );

    const messageResult = await client.query(
      `UPDATE messages
       SET delivery_status = 'unknown',
           delivery_error = $2
       WHERE id = $1
       RETURNING ${MESSAGE_COLUMNS}`,
      [state.assistant_message_id, safeError]
    );
    await client.query("COMMIT");
    return {
      marked: true,
      message: messageResult.rows[0] || null,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

async function markPrepared(messageId, wasFirstMessage, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET prepared_at = COALESCE(prepared_at, NOW()),
         was_first_message = COALESCE(was_first_message, $2),
         updated_at = NOW()
     WHERE message_id = $1
       AND status <> 'completed'
       AND terminal_at IS NULL
     RETURNING ${JOB_COLUMNS}`,
    [messageId, Boolean(wasFirstMessage)]
  );
  return result.rows[0] || null;
}

/**
 * Claims live work for this process. Earlier processing jobs owned by this
 * same process are allowed because the in-memory reply queue serializes them
 * and lets normal rapid-fire messages join the existing typing burst. An
 * unfinished predecessor owned by another process blocks the newer claim,
 * which prevents a post-restart message from overtaking work leased before the
 * restart/deploy. The recovery sweep later reclaims the ordered prefix.
 */
async function claimPendingByMessageId(
  messageId,
  database = pool,
  ownerId = PROCESSING_OWNER_ID
) {
  const owner = safeOwnerId(ownerId);
  const result = await database.query(
    `UPDATE inbound_processing_jobs j
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = NOW(),
         lease_owner = $2,
         last_error = NULL,
         updated_at = NOW()
     WHERE j.message_id = $1
       AND j.status = 'pending'
       AND j.terminal_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM inbound_processing_jobs earlier
         WHERE earlier.contact_id = j.contact_id
           AND earlier.message_id < j.message_id
           AND earlier.terminal_at IS NULL
           AND earlier.status <> 'completed'
           AND NOT (
             earlier.status = 'processing'
             AND COALESCE(earlier.lease_owner = $2, false)
           )
       )
     RETURNING ${JOB_COLUMNS}`,
    [messageId, owner]
  );
  return result.rows[0] || null;
}

async function claimRecoverable({
  limit = 25,
  staleAfterSeconds = 45,
  maxAttempts = 5,
  ownerId = PROCESSING_OWNER_ID,
} = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeStaleSeconds = Math.max(5, Math.min(3600, Number(staleAfterSeconds) || 45));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  const owner = safeOwnerId(ownerId);

  const result = await database.query(
    `WITH eligible AS (
       SELECT j.id
       FROM inbound_processing_jobs j
       WHERE j.terminal_at IS NULL
         AND j.attempts < $3
         AND (
           j.status = 'pending'
           OR j.status = 'failed'
           OR (
             j.status = 'processing'
             AND (
               j.claimed_at IS NULL
               OR j.claimed_at < NOW() - ($2::int * interval '1 second')
             )
           )
         )
         -- Do not let a newer pending message overtake an older job that is
         -- still actively leased by a live/possibly-live process. Pending,
         -- failed and stale predecessors are recoverable together, preserving
         -- the existing same-contact batch replay behavior.
         AND NOT EXISTS (
           SELECT 1
           FROM inbound_processing_jobs earlier
           WHERE earlier.contact_id = j.contact_id
             AND earlier.message_id < j.message_id
             AND earlier.terminal_at IS NULL
             AND earlier.status <> 'completed'
             AND (
               earlier.attempts >= $3
               OR (
                 earlier.status = 'processing'
                 AND earlier.claimed_at IS NOT NULL
                 AND earlier.claimed_at >= NOW() - ($2::int * interval '1 second')
               )
             )
         )
       ORDER BY j.created_at ASC, j.id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE inbound_processing_jobs j
     SET status = 'processing',
         attempts = j.attempts + 1,
         claimed_at = NOW(),
         lease_owner = $4,
         last_error = NULL,
         updated_at = NOW()
     FROM eligible
     WHERE j.id = eligible.id
     RETURNING j.*`,
    [safeLimit, safeStaleSeconds, safeMaxAttempts, owner]
  );
  return result.rows;
}

/**
 * Finds jobs that have exhausted automatic attempts but were never durably
 * handed to staff. This closes the crash-on-final-attempt gap: a process can
 * die immediately after attempt N is leased, and the next process will still
 * surface that stale job instead of leaving it invisible forever.
 */
async function listExhausted({
  limit = 25,
  staleAfterSeconds = 45,
  maxAttempts = 5,
} = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeStaleSeconds = Math.max(5, Math.min(3600, Number(staleAfterSeconds) || 45));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));

  const result = await database.query(
    `SELECT ${JOB_COLUMNS}
     FROM inbound_processing_jobs
     WHERE terminal_at IS NULL
       AND attempts >= $3
       AND (
         status IN ('pending', 'failed')
         OR (
           status = 'processing'
           AND (
             claimed_at IS NULL
             OR claimed_at < NOW() - ($2::int * interval '1 second')
           )
         )
       )
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    [safeLimit, safeStaleSeconds, safeMaxAttempts]
  );
  return result.rows;
}

async function markCompleted(jobId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'completed',
         completed_at = NOW(),
         terminal_at = NULL,
         lease_owner = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function markCompletedByMessageId(messageId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'completed',
         completed_at = NOW(),
         terminal_at = NULL,
         lease_owner = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE message_id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function markFailed(jobId, error, database = pool) {
  const text = String(error?.message || error || "Inbound processing failed.").slice(0, 1000);
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'failed',
         lease_owner = NULL,
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1
       AND status <> 'completed'
       AND terminal_at IS NULL
     RETURNING ${JOB_COLUMNS}`,
    [jobId, text]
  );
  return result.rows[0] || null;
}

/**
 * Records that an exhausted job has successfully been surfaced to staff. The
 * failed status and last_error are intentionally preserved for diagnostics.
 */
async function markTerminal(jobId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'failed',
         terminal_at = COALESCE(terminal_at, NOW()),
         lease_owner = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function getJobContext(jobId, database = pool) {
  const result = await database.query(
    `SELECT
       j.*,
       row_to_json(m.*) AS saved_inbound,
       NOT EXISTS (
         SELECT 1
         FROM messages earlier
         WHERE earlier.contact_id = m.contact_id
           AND earlier.id < m.id
       ) AS derived_first_message
     FROM inbound_processing_jobs j
     JOIN LATERAL (
       SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE id = j.message_id AND contact_id = j.contact_id AND role = 'user'
     ) m ON true
     WHERE j.id = $1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    job: {
      id: row.id,
      message_id: row.message_id,
      contact_id: row.contact_id,
      channel: row.channel,
      incoming_payload: row.incoming_payload,
      status: row.status,
      attempts: row.attempts,
      prepared_at: row.prepared_at,
      was_first_message: row.was_first_message,
      claimed_at: row.claimed_at,
      lease_owner: row.lease_owner,
      completed_at: row.completed_at,
      terminal_at: row.terminal_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    savedInbound: row.saved_inbound,
    derivedFirstMessage: Boolean(row.derived_first_message),
  };
}

/** Durable pre-ACK placeholder for Meta message_edit events with no sender/text. */
async function storeMetaResolutionClaim({
  channel,
  externalMessageId,
  entryId = null,
  incoming,
}, database = pool) {
  const payload = serializeIncoming(incoming);
  const result = await database.query(
    `INSERT INTO inbound_meta_resolution_jobs (
       channel, external_message_id, entry_id, incoming_payload
     )
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (channel, external_message_id) DO NOTHING
     RETURNING ${META_RESOLUTION_JOB_COLUMNS}`,
    [channel, externalMessageId, entryId, payload]
  );
  return result.rows[0] || null;
}

async function getMetaResolutionByExternalId(
  channel,
  externalMessageId,
  database = pool
) {
  const result = await database.query(
    `SELECT ${META_RESOLUTION_JOB_COLUMNS}
     FROM inbound_meta_resolution_jobs
     WHERE channel = $1 AND external_message_id = $2`,
    [channel, externalMessageId]
  );
  return result.rows[0] || null;
}

async function claimMetaResolutionByExternalId({
  channel,
  externalMessageId,
  maxAttempts = 5,
  ownerId = PROCESSING_OWNER_ID,
} = {}, database = pool) {
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  const owner = safeOwnerId(ownerId);
  const result = await database.query(
    `UPDATE inbound_meta_resolution_jobs
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = NOW(),
         lease_owner = $4,
         last_error = NULL,
         updated_at = NOW()
     WHERE channel = $1
       AND external_message_id = $2
       AND status IN ('pending', 'failed')
       AND attempts < $3
       AND terminal_at IS NULL
     RETURNING ${META_RESOLUTION_JOB_COLUMNS}`,
    [channel, externalMessageId, safeMaxAttempts, owner]
  );
  return result.rows[0] || null;
}

async function claimRecoverableMetaResolutions({
  limit = 25,
  staleAfterSeconds = 45,
  maxAttempts = 5,
  ownerId = PROCESSING_OWNER_ID,
} = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeStaleSeconds = Math.max(5, Math.min(3600, Number(staleAfterSeconds) || 45));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  const owner = safeOwnerId(ownerId);

  const result = await database.query(
    `WITH eligible AS (
       SELECT id
       FROM inbound_meta_resolution_jobs
       WHERE terminal_at IS NULL
         AND attempts < $3
         AND (
           status IN ('pending', 'failed')
           OR (
             status = 'processing'
             AND (
               claimed_at IS NULL
               OR claimed_at < NOW() - ($2::int * interval '1 second')
             )
           )
         )
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE inbound_meta_resolution_jobs j
     SET status = 'processing',
         attempts = j.attempts + 1,
         claimed_at = NOW(),
         lease_owner = $4,
         last_error = NULL,
         updated_at = NOW()
     FROM eligible
     WHERE j.id = eligible.id
     RETURNING j.*`,
    [safeLimit, safeStaleSeconds, safeMaxAttempts, owner]
  );
  return result.rows;
}

async function markMetaResolutionCompleted(jobId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_meta_resolution_jobs
     SET status = 'completed',
         completed_at = NOW(),
         terminal_at = NULL,
         lease_owner = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${META_RESOLUTION_JOB_COLUMNS}`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function markMetaResolutionFailed(jobId, error, database = pool) {
  const text = String(error?.message || error || "Meta message resolution failed.").slice(0, 1000);
  const result = await database.query(
    `UPDATE inbound_meta_resolution_jobs
     SET status = 'failed',
         lease_owner = NULL,
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1
       AND status <> 'completed'
       AND terminal_at IS NULL
     RETURNING ${META_RESOLUTION_JOB_COLUMNS}`,
    [jobId, text]
  );
  return result.rows[0] || null;
}

async function listExhaustedMetaResolutions({
  limit = 25,
  staleAfterSeconds = 45,
  maxAttempts = 5,
} = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeStaleSeconds = Math.max(5, Math.min(3600, Number(staleAfterSeconds) || 45));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  const result = await database.query(
    `SELECT ${META_RESOLUTION_JOB_COLUMNS}
     FROM inbound_meta_resolution_jobs
     WHERE terminal_at IS NULL
       AND attempts >= $3
       AND (
         status IN ('pending', 'failed')
         OR (
           status = 'processing'
           AND (
             claimed_at IS NULL
             OR claimed_at < NOW() - ($2::int * interval '1 second')
           )
         )
       )
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    [safeLimit, safeStaleSeconds, safeMaxAttempts]
  );
  return result.rows;
}

async function markMetaResolutionTerminal(jobId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_meta_resolution_jobs
     SET status = 'failed',
         terminal_at = COALESCE(terminal_at, NOW()),
         lease_owner = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${META_RESOLUTION_JOB_COLUMNS}`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function pruneCompleted({ olderThanHours = 24 } = {}, database = pool) {
  const hours = Math.max(1, Math.min(24 * 30, Number(olderThanHours) || 24));
  const [processingResult, resolutionResult] = await Promise.all([
    database.query(
      `DELETE FROM inbound_processing_jobs
       WHERE (
         status = 'completed'
         AND completed_at < NOW() - ($1::int * interval '1 hour')
       ) OR (
         terminal_at IS NOT NULL
         AND terminal_at < NOW() - ($1::int * interval '1 hour')
       )`,
      [hours]
    ),
    database.query(
      `DELETE FROM inbound_meta_resolution_jobs
       WHERE (
         status = 'completed'
         AND completed_at < NOW() - ($1::int * interval '1 hour')
       ) OR (
         terminal_at IS NOT NULL
         AND terminal_at < NOW() - ($1::int * interval '1 hour')
       )`,
      [hours]
    ),
  ]);
  return (processingResult.rowCount || 0) + (resolutionResult.rowCount || 0);
}

module.exports = {
  MAX_INCOMING_PAYLOAD_BYTES,
  PROCESSING_OWNER_ID,
  claimMetaResolutionByExternalId,
  claimPendingByMessageId,
  claimRecoverable,
  claimRecoverableMetaResolutions,
  getJobContext,
  getMetaResolutionByExternalId,
  listExhausted,
  listExhaustedMetaResolutions,
  markCompleted,
  markCompletedByMessageId,
  markFailed,
  markMetaResolutionCompleted,
  markMetaResolutionFailed,
  markMetaResolutionTerminal,
  markPrepared,
  markTerminal,
  pruneCompleted,
  serializeIncoming,
  whatsappMessageSourceCreatedAt,
  storeInboundClaim,
  reserveOutboundAttempt,
  cancelOutboundAttempt,
  getOutboundAttempt,
  finalizeOutboundAttempt,
  finalizeOutboundAttemptByAssistantMessageId,
  markOutboundAttemptAmbiguous,
  storeMetaResolutionClaim,
};
