const { pool } = require("./db");

const CLAIM_STALE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const QUEUE_LOCK_NAMESPACE = 24684;
const ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES = 60;
const RETRY_DELAY_MINUTES = Object.freeze([1, 5]);

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

async function queueSummary({ leadId, throughMessageId, score }) {
  return withTransaction(async (client) => {
    // Serialize queue changes for one lead so an older recovery racing with a
    // newer completed score can never replace the newer Telegram snapshot.
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [QUEUE_LOCK_NAMESPACE, leadId]
    );

    // Snapshot ordering is monotonic: only a newer message boundary can
    // supersede older unsent rows. An older recovered fallback must never
    // supersede a newer summary that has already been queued.
    await client.query(
      `UPDATE telegram_summary_alerts
       SET status = 'superseded', updated_at = now()
       WHERE lead_id = $1
         AND through_message_id < $2
         AND status IN ('pending', 'sending')`,
      [leadId, throughMessageId]
    );

    const result = await client.query(
      `INSERT INTO telegram_summary_alerts (
         lead_id, through_message_id, score_data
       )
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1
         FROM telegram_summary_alerts newer
         WHERE newer.lead_id = $1
           AND newer.through_message_id > $2
       )
       ON CONFLICT (lead_id, through_message_id) DO NOTHING
       RETURNING *`,
      [leadId, throughMessageId, score]
    );
    return result.rows[0] || null;
  });
}

async function findReadySummaries({
  inactivityMinutes,
  limit = 5,
  suppressionMinutes = ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES,
}) {
  const result = await pool.query(
    `SELECT
       a.id AS alert_id, a.lead_id, a.through_message_id, a.score_data,
       l.contact_id, l.temperature AS current_temperature,
       l.branch_name, l.treatment_interest, l.appointment_at,
       l.appointment_status, s.name AS stage_name,
       c.whatsapp_number, c.name, c.whatsapp_profile_name,
       c.channel, c.channel_user_id,
       latest.created_at AS last_message_at
     FROM telegram_summary_alerts a
     JOIN leads l ON l.id = a.lead_id
     JOIN pipeline_stages s ON s.id = l.stage_id
     JOIN contacts c ON c.id = l.contact_id
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = l.contact_id
       ORDER BY m.id DESC
       LIMIT 1
     ) latest ON true
     WHERE a.status IN ('pending', 'sending')
       AND a.attempts < ${MAX_ATTEMPTS}
       AND (
         (
           a.status = 'pending'
           AND (
             a.attempts = 0
             OR a.updated_at <= now() - (
               CASE a.attempts
                 WHEN 1 THEN interval '1 minute'
                 WHEN 2 THEN interval '5 minutes'
                 ELSE interval '100 years'
               END
             )
           )
         )
         OR (
           a.status = 'sending'
           AND a.claimed_at <= now() - (${CLAIM_STALE_MINUTES} * interval '1 minute')
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages newer_customer
         WHERE newer_customer.contact_id = l.contact_id
           AND newer_customer.role = 'user'
           AND newer_customer.id > a.through_message_id
       )
       AND (
         COALESCE(a.score_data->>'alertType', '') = 'ai_scoring_failed'
         OR NOT EXISTS (
           SELECT 1
           FROM telegram_immediate_alerts immediate
           WHERE immediate.contact_id = l.contact_id
             AND immediate.lead_id = l.id
             AND immediate.alert_type IN ('human_intervention', 'booking_ready', 'staff_waiting')
             AND immediate.status IN ('pending', 'sending', 'sent')
             AND immediate.created_at >=
                 a.created_at - ($3::integer * interval '1 minute')
             AND immediate.created_at <=
                 a.created_at + ($3::integer * interval '1 minute')
         )
       )
       AND latest.created_at <= now() - ($1::integer * interval '1 minute')
     ORDER BY latest.created_at ASC, a.id ASC
     LIMIT $2`,
    [inactivityMinutes, limit, suppressionMinutes]
  );
  return result.rows;
}

async function claimSummary(
  alertId,
  inactivityMinutes,
  suppressionMinutes = ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES
) {
  // Re-check the customer-message boundary and inactivity threshold in the
  // same SQL statement that claims the row. A customer reply arriving after
  // findReadySummaries() but before this claim therefore cancels the send.
  const result = await pool.query(
    `UPDATE telegram_summary_alerts a
     SET status = 'sending', attempts = a.attempts + 1,
         claimed_at = now(), error_text = NULL, updated_at = now()
     FROM leads l
     JOIN pipeline_stages s ON s.id = l.stage_id
     JOIN contacts c ON c.id = l.contact_id
     LEFT JOIN users u ON u.username = l.owner_username
     WHERE a.id = $1
       AND a.lead_id = l.id
       AND a.attempts < ${MAX_ATTEMPTS}
       AND (
         (
           a.status = 'pending'
           AND (
             a.attempts = 0
             OR a.updated_at <= now() - (
               CASE a.attempts
                 WHEN 1 THEN interval '1 minute'
                 WHEN 2 THEN interval '5 minutes'
                 ELSE interval '100 years'
               END
             )
           )
         )
         OR (
           a.status = 'sending'
           AND a.claimed_at <= now() - (${CLAIM_STALE_MINUTES} * interval '1 minute')
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages newer_customer
         WHERE newer_customer.contact_id = l.contact_id
           AND newer_customer.role = 'user'
           AND newer_customer.id > a.through_message_id
       )
       AND (
         COALESCE(a.score_data->>'alertType', '') = 'ai_scoring_failed'
         OR NOT EXISTS (
           SELECT 1
           FROM telegram_immediate_alerts immediate
           WHERE immediate.contact_id = l.contact_id
             AND immediate.lead_id = l.id
             AND immediate.alert_type IN ('human_intervention', 'booking_ready', 'staff_waiting')
             AND immediate.status IN ('pending', 'sending', 'sent')
             AND immediate.created_at >=
                 a.created_at - ($3::integer * interval '1 minute')
             AND immediate.created_at <=
                 a.created_at + ($3::integer * interval '1 minute')
         )
       )
       AND (
         SELECT latest.created_at
         FROM messages latest
         WHERE latest.contact_id = l.contact_id
         ORDER BY latest.id DESC
         LIMIT 1
       ) <= now() - ($2::integer * interval '1 minute')
     RETURNING
       a.id AS alert_id, a.lead_id, a.through_message_id, a.score_data,
       l.contact_id, l.temperature AS current_temperature,
       l.branch_name, l.treatment_interest, l.appointment_at,
       l.appointment_status, l.owner_username,
       u.display_name AS owner_display_name, s.name AS stage_name,
       c.whatsapp_number, c.name, c.whatsapp_profile_name,
       c.channel, c.channel_user_id`,
    [alertId, inactivityMinutes, suppressionMinutes]
  );
  return result.rows[0] || null;
}

async function findActionableCoverage(
  alertId,
  suppressionMinutes = ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES
) {
  const result = await pool.query(
    `SELECT immediate.status
     FROM telegram_summary_alerts a
     JOIN leads l ON l.id = a.lead_id
     JOIN telegram_immediate_alerts immediate
       ON immediate.contact_id = l.contact_id
      AND immediate.lead_id = l.id
     WHERE a.id = $1
       AND COALESCE(a.score_data->>'alertType', '') <> 'ai_scoring_failed'
       AND immediate.alert_type IN ('human_intervention', 'booking_ready', 'staff_waiting')
       AND immediate.status IN ('pending', 'sending', 'sent')
       AND immediate.created_at >=
           a.created_at - ($2::integer * interval '1 minute')
       AND immediate.created_at <=
           a.created_at + ($2::integer * interval '1 minute')
     ORDER BY
       CASE immediate.status WHEN 'sent' THEN 0 WHEN 'sending' THEN 1 ELSE 2 END,
       immediate.created_at DESC,
       immediate.id DESC
     LIMIT 1`,
    [alertId, suppressionMinutes]
  );
  return result.rows[0]?.status || null;
}

async function markSuperseded(alertId) {
  const result = await pool.query(
    `UPDATE telegram_summary_alerts
     SET status = 'superseded',
         claimed_at = NULL,
         error_text = NULL,
         updated_at = now()
     WHERE id = $1
       AND status IN ('pending', 'sending')
     RETURNING *`,
    [alertId]
  );
  return result.rows[0] || null;
}

async function releaseClaim(alertId) {
  const result = await pool.query(
    `UPDATE telegram_summary_alerts
     SET status = 'pending',
         attempts = GREATEST(0, attempts - 1),
         claimed_at = NULL,
         error_text = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'sending'
     RETURNING *`,
    [alertId]
  );
  return result.rows[0] || null;
}

async function supersedeCoveredSummaries(
  suppressionMinutes = ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES
) {
  const result = await pool.query(
    `UPDATE telegram_summary_alerts a
     SET status = 'superseded',
         claimed_at = NULL,
         error_text = NULL,
         updated_at = now()
     FROM leads l
     WHERE a.lead_id = l.id
       AND (
         a.status = 'pending'
         OR (
           a.status = 'sending'
           AND a.claimed_at <= now() - (${CLAIM_STALE_MINUTES} * interval '1 minute')
         )
       )
       AND COALESCE(a.score_data->>'alertType', '') <> 'ai_scoring_failed'
       AND EXISTS (
         SELECT 1
         FROM telegram_immediate_alerts immediate
         WHERE immediate.contact_id = l.contact_id
           AND immediate.lead_id = l.id
           AND immediate.alert_type IN ('human_intervention', 'booking_ready', 'staff_waiting')
           AND immediate.status = 'sent'
           AND immediate.created_at >=
               a.created_at - ($1::integer * interval '1 minute')
           AND immediate.created_at <=
               a.created_at + ($1::integer * interval '1 minute')
       )
     RETURNING a.id`,
    [suppressionMinutes]
  );
  return result.rows;
}

async function markSent(alertId) {
  const result = await pool.query(
    `UPDATE telegram_summary_alerts
     SET status = 'sent', sent_at = now(), claimed_at = NULL,
         error_text = NULL, updated_at = now()
     WHERE id = $1 AND status = 'sending'
     RETURNING *`,
    [alertId]
  );
  return result.rows[0] || null;
}

async function findNextRetryAt() {
  const result = await pool.query(
    `SELECT MIN(
       updated_at + CASE attempts
         WHEN 1 THEN interval '1 minute'
         WHEN 2 THEN interval '5 minutes'
         ELSE NULL
       END
     ) AS next_retry_at
     FROM telegram_summary_alerts
     WHERE status = 'pending'
       AND attempts > 0
       AND attempts < ${MAX_ATTEMPTS}`
  );
  return result.rows[0]?.next_retry_at || null;
}

async function markFailed(alertId, error) {
  const message = String(error?.message || error || "Telegram send failed.").slice(0, 1000);
  const result = await pool.query(
    `UPDATE telegram_summary_alerts
     SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
         claimed_at = NULL, error_text = $2, updated_at = now()
     WHERE id = $1 AND status = 'sending'
     RETURNING *`,
    [alertId, message]
  );
  return result.rows[0] || null;
}

module.exports = {
  ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES,
  CLAIM_STALE_MINUTES,
  MAX_ATTEMPTS,
  QUEUE_LOCK_NAMESPACE,
  RETRY_DELAY_MINUTES,
  claimSummary,
  findActionableCoverage,
  findNextRetryAt,
  findReadySummaries,
  markFailed,
  markSent,
  markSuperseded,
  queueSummary,
  releaseClaim,
  supersedeCoveredSummaries,
};
