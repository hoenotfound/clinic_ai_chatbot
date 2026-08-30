const { pool } = require("./db");
const { lockConversation } = require("./conversationLock");
const realtimeEvents = require("../utils/realtimeEvents");

const PROCESSING_STALE_MINUTES = 10;
const FAILED_RETRY_MINUTES = 2;
const MAX_ATTEMPTS = 3;

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findCandidates({
  inactivityMinutes,
  maxConversationMinutes,
  maxMessages,
  activatedAt,
  limit = 5,
}) {
  const result = await pool.query(
    `SELECT
       l.id AS lead_id,
       l.contact_id,
       l.temperature,
       l.temperature_source,
       l.temperature_locked,
       l.started_message_id,
       l.created_at AS journey_started_at,
       l.appointment_status,
       l.branch_name,
       l.treatment_interest,
       latest.id AS through_message_id,
       segment.latest_customer_at,
       CASE
         WHEN segment.message_count >= $3 THEN 'message_ceiling'
         WHEN segment.started_at <= now() - ($2::integer * interval '1 minute')
           THEN 'time_ceiling'
         ELSE 'inactivity'
       END AS trigger_type
     FROM leads l
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = l.contact_id
       ORDER BY m.id DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT s.through_message_id
       FROM lead_temperature_scores s
       WHERE s.lead_id = l.id AND s.status = 'completed'
       ORDER BY s.through_message_id DESC, s.id DESC
       LIMIT 1
     ) last_score ON true
     JOIN LATERAL (
       SELECT
         COUNT(*)::integer AS message_count,
         COUNT(*) FILTER (WHERE m.role = 'user')::integer AS customer_message_count,
         MIN(m.created_at) AS started_at,
         MAX(m.created_at) FILTER (WHERE m.role = 'user') AS latest_customer_at
       FROM messages m
       WHERE m.contact_id = l.contact_id
         AND m.id > COALESCE(last_score.through_message_id, 0)
         AND (
           (l.started_message_id IS NOT NULL AND m.id >= l.started_message_id)
           OR
           (l.started_message_id IS NULL AND m.created_at >= l.created_at)
         )
         AND m.id <= latest.id
         AND m.created_at >= $4::timestamptz
     ) segment ON segment.customer_message_count > 0
     WHERE l.is_closed = false
       AND latest.id > COALESCE(last_score.through_message_id, 0)
       AND (
         latest.created_at <= now() - ($1::integer * interval '1 minute')
         OR segment.started_at <= now() - ($2::integer * interval '1 minute')
         OR segment.message_count >= $3
       )
       AND NOT EXISTS (
         SELECT 1
         FROM lead_temperature_scores existing
         WHERE existing.lead_id = l.id
           AND existing.through_message_id = latest.id
           AND (
             existing.status IN ('completed', 'superseded', 'cancelled')
             OR (
             existing.status = 'processing'
               AND (
                 existing.attempts >= ${MAX_ATTEMPTS}
                 OR existing.updated_at > now() - (${PROCESSING_STALE_MINUTES} * interval '1 minute')
               )
             )
             OR (
               existing.status = 'failed'
               AND (
                 existing.attempts >= ${MAX_ATTEMPTS}
                 OR existing.updated_at > now() - (${FAILED_RETRY_MINUTES} * interval '1 minute')
               )
             )
           )
       )
     ORDER BY segment.started_at ASC, l.id ASC
     LIMIT $5`,
    [
      inactivityMinutes,
      maxConversationMinutes,
      maxMessages,
      activatedAt,
      limit,
    ]
  );
  return result.rows;
}

async function claimCandidate(candidate) {
  const result = await pool.query(
    `INSERT INTO lead_temperature_scores (
       lead_id, through_message_id, trigger_type, status
     )
     SELECT $1, $2, $3, 'processing'
     FROM leads l
     WHERE l.id = $1
       AND l.contact_id = $4
       AND l.is_closed = false
       AND (
         SELECT m.id FROM messages m
         WHERE m.contact_id = l.contact_id
         ORDER BY m.id DESC LIMIT 1
       ) = $2
     ON CONFLICT (lead_id, through_message_id) DO UPDATE
       SET status = 'processing',
           trigger_type = EXCLUDED.trigger_type,
           attempts = lead_temperature_scores.attempts + 1,
           error_text = NULL,
           updated_at = now()
       WHERE (
         lead_temperature_scores.status = 'failed'
         AND lead_temperature_scores.attempts < ${MAX_ATTEMPTS}
         AND lead_temperature_scores.updated_at <= now() - (${FAILED_RETRY_MINUTES} * interval '1 minute')
       ) OR (
         lead_temperature_scores.status = 'processing'
         AND lead_temperature_scores.attempts < ${MAX_ATTEMPTS}
         AND lead_temperature_scores.updated_at <= now() - (${PROCESSING_STALE_MINUTES} * interval '1 minute')
       )
     RETURNING id, lead_id, through_message_id, trigger_type, attempts`,
    [
      candidate.lead_id,
      candidate.through_message_id,
      candidate.trigger_type,
      candidate.contact_id,
    ]
  );
  return result.rows[0] || null;
}

async function getTranscript(
  contactId,
  startedMessageId,
  journeyStartedAt,
  throughMessageId,
  limit = 80
) {
  const result = await pool.query(
    `SELECT id, role, content, sent_by_username, created_at
     FROM messages
     WHERE contact_id = $1
       AND (
         ($2::integer IS NOT NULL AND id >= $2)
         OR
         ($2::integer IS NULL AND created_at >= $3::timestamptz)
       )
       AND id <= $4
       AND (
         role <> 'assistant'
         OR delivery_status IS NULL
         OR delivery_status NOT IN ('failed', 'unknown')
       )
     ORDER BY id DESC
     LIMIT $5`,
    [contactId, startedMessageId, journeyStartedAt, throughMessageId, limit]
  );
  return result.rows.reverse();
}

async function findTerminalFailuresNeedingAlert({ limit = 5 } = {}) {
  const result = await pool.query(
    `SELECT
       failed.id AS score_id,
       failed.lead_id,
       failed.through_message_id,
       failed.attempts,
       failed.error_text
     FROM lead_temperature_scores failed
     JOIN leads l ON l.id = failed.lead_id
     WHERE failed.status = 'failed'
       AND failed.attempts >= ${MAX_ATTEMPTS}
       AND l.is_closed = false
       AND NOT EXISTS (
         SELECT 1
         FROM telegram_summary_alerts alert
         WHERE alert.lead_id = failed.lead_id
           AND alert.through_message_id = failed.through_message_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages newer_customer
         WHERE newer_customer.contact_id = l.contact_id
           AND newer_customer.role = 'user'
           AND newer_customer.id > failed.through_message_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM lead_temperature_scores newer_score
         WHERE newer_score.lead_id = failed.lead_id
           AND newer_score.through_message_id > failed.through_message_id
       )
     ORDER BY failed.updated_at ASC, failed.id ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

function scoreDescription(lead, score, applied) {
  const label = score.temperature[0].toUpperCase() + score.temperature.slice(1);
  const confidence = `${score.confidence} confidence`;
  if (lead.temperature_locked) {
    return `AI conversation score: ${label} (${confidence}). Staff temperature kept. ${score.reason}`;
  }
  if (applied && lead.temperature !== score.temperature) {
    const previous = lead.temperature[0].toUpperCase() + lead.temperature.slice(1);
    return `AI conversation score changed temperature from ${previous} to ${label} (${confidence}). ${score.reason}`;
  }
  if (applied) {
    return `AI conversation score confirmed ${label} (${confidence}). ${score.reason}`;
  }
  return `AI conversation score suggested ${label} (${confidence}); temperature unchanged. ${score.reason}`;
}

function serializeEvidenceMessageIds(score) {
  return JSON.stringify(Array.isArray(score?.evidenceMessageIds) ? score.evidenceMessageIds : []);
}

function serializeSummaryData(score) {
  const summary =
    score?.summary && typeof score.summary === "object" && !Array.isArray(score.summary)
      ? score.summary
      : {};
  return JSON.stringify(summary);
}

async function saveSupersededScore(client, scoreId, score) {
  await client.query(
    `UPDATE lead_temperature_scores
     SET status = 'superseded', temperature = $2, confidence = $3,
         reason = $4, evidence_message_ids = $5::jsonb,
         summary_data = $6::jsonb, provider = $7,
         model = $8, prompt_version = $9, applied = false,
         error_text = NULL, updated_at = now()
     WHERE id = $1`,
    [
      scoreId,
      score.temperature,
      score.confidence,
      score.reason,
      serializeEvidenceMessageIds(score),
      serializeSummaryData(score),
      score.provider,
      score.model,
      score.promptVersion,
    ]
  );
}

async function completeScore({
  scoreId,
  leadId,
  throughMessageId,
  triggerType,
  score,
  allowTemperatureUpdate = true,
}) {
  const outcome = await withTransaction(async (client) => {
    const claimedResult = await client.query(
      `SELECT s.id, s.status, l.contact_id
       FROM lead_temperature_scores s
       JOIN leads l ON l.id = s.lead_id
       WHERE s.id = $1 AND s.lead_id = $2 AND s.through_message_id = $3
       FOR UPDATE OF s`,
      [scoreId, leadId, throughMessageId]
    );
    const claim = claimedResult.rows[0];
    if (claim?.status !== "processing") {
      return { status: "ignored" };
    }

    // Message inserts and transcript-changing updates take this same lock.
    // Once acquired, no message can slip in after the final latest-message
    // check and before this scoring transaction commits.
    await lockConversation(client, claim.contact_id);

    const leadResult = await client.query(
      `SELECT l.*,
              (SELECT m.id FROM messages m WHERE m.contact_id = l.contact_id ORDER BY m.id DESC LIMIT 1)
                AS latest_message_id
       FROM leads l
       WHERE l.id = $1
       FOR UPDATE`,
      [leadId]
    );
    const lead = leadResult.rows[0];
    const superseded =
      !lead ||
      lead.is_closed ||
      Number(lead.latest_message_id) !== Number(throughMessageId);

    if (superseded) {
      await saveSupersededScore(client, scoreId, score);
      return { status: "superseded" };
    }

    const shouldApply =
      allowTemperatureUpdate === true &&
      score.confidence === "high" &&
      !lead.temperature_locked;
    let updatedLead = null;
    if (shouldApply) {
      const updated = await client.query(
        `UPDATE leads
         SET temperature = $2, temperature_source = 'ai',
             last_temperature_scored_at = now(),
             last_temperature_scored_message_id = $3,
             updated_at = now()
         WHERE id = $1 AND is_closed = false AND temperature_locked = false
           AND (
             SELECT m.id FROM messages m
             WHERE m.contact_id = leads.contact_id
             ORDER BY m.id DESC LIMIT 1
           ) = $3
         RETURNING *`,
        [leadId, score.temperature, throughMessageId]
      );
      updatedLead = updated.rows[0] || null;
    } else {
      const updated = await client.query(
        `UPDATE leads
         SET last_temperature_scored_at = now(),
             last_temperature_scored_message_id = $2,
             updated_at = now()
         WHERE id = $1 AND is_closed = false
           AND (
             SELECT m.id FROM messages m
             WHERE m.contact_id = leads.contact_id
             ORDER BY m.id DESC LIMIT 1
           ) = $2
         RETURNING *`,
        [leadId, throughMessageId]
      );
      updatedLead = updated.rows[0] || null;
    }

    // Re-check in the same statement that applies the result. A message can
    // arrive in the small gap after the first stale-result check above.
    if (!updatedLead) {
      await saveSupersededScore(client, scoreId, score);
      return { status: "superseded" };
    }

    const applied = shouldApply;
    await client.query(
      `UPDATE lead_temperature_scores
       SET status = 'completed', temperature = $2, confidence = $3,
           reason = $4, evidence_message_ids = $5::jsonb,
           summary_data = $6::jsonb, provider = $7,
           model = $8, prompt_version = $9, applied = $10,
           error_text = NULL, updated_at = now()
       WHERE id = $1`,
      [
        scoreId,
        score.temperature,
        score.confidence,
        score.reason,
        serializeEvidenceMessageIds(score),
        serializeSummaryData(score),
        score.provider,
        score.model,
        score.promptVersion,
        applied,
      ]
    );

    await client.query(
      `INSERT INTO lead_activities (
         lead_id, activity_type, description, actor, metadata
       ) VALUES ($1, 'updated', $2, 'AI scoring', $3)`,
      [
        leadId,
        scoreDescription(lead, score, applied),
        {
          source: "conversation_ai",
          scoreId,
          throughMessageId,
          triggerType,
          temperature: score.temperature,
          confidence: score.confidence,
          evidenceMessageIds: score.evidenceMessageIds,
          summary: score.summary,
          provider: score.provider,
          model: score.model,
          promptVersion: score.promptVersion,
          applied,
        },
      ]
    );

    return { status: "completed", applied, lead: updatedLead };
  });

  if (outcome.status === "completed") {
    realtimeEvents.publish("pipeline_changed", { leadId });
  }
  return outcome;
}

async function markScoreFailed(scoreId, error) {
  const result = await pool.query(
    `UPDATE lead_temperature_scores
     SET status = 'failed', error_text = $2, updated_at = now()
     WHERE id = $1 AND status = 'processing'
     RETURNING id, lead_id, through_message_id, attempts`,
    [scoreId, String(error?.message || error || "Lead scoring failed.").slice(0, 1000)]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    terminal: Number(row.attempts) >= MAX_ATTEMPTS,
  };
}

async function markScoreCancelled(scoreId) {
  await pool.query(
    `UPDATE lead_temperature_scores
     SET status = 'cancelled', error_text = NULL, updated_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [scoreId]
  );
}

module.exports = {
  FAILED_RETRY_MINUTES,
  MAX_ATTEMPTS,
  PROCESSING_STALE_MINUTES,
  claimCandidate,
  completeScore,
  findCandidates,
  findTerminalFailuresNeedingAlert,
  getTranscript,
  markScoreCancelled,
  markScoreFailed,
};
