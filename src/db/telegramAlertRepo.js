const { pool } = require("./db");

const CLAIM_STALE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const QUEUE_LOCK_NAMESPACE = 24684;

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

async function findReadySummaries({ inactivityMinutes, limit = 5 }) {
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
         a.status = 'pending'
         OR a.claimed_at <= now() - (${CLAIM_STALE_MINUTES} * interval '1 minute')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages newer_customer
         WHERE newer_customer.contact_id = l.contact_id
           AND newer_customer.role = 'user'
           AND newer_customer.id > a.through_message_id
       )
       AND latest.created_at <= now() - ($1::integer * interval '1 minute')
     ORDER BY latest.created_at ASC, a.id ASC
     LIMIT $2`,
    [inactivityMinutes, limit]
  );
  return result.rows;
}

async function claimSummary(alertId, inactivityMinutes) {
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
         a.status = 'pending'
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
    [alertId, inactivityMinutes]
  );
  return result.rows[0] || null;
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
  CLAIM_STALE_MINUTES,
  MAX_ATTEMPTS,
  QUEUE_LOCK_NAMESPACE,
  claimSummary,
  findReadySummaries,
  markFailed,
  markSent,
  queueSummary,
};
