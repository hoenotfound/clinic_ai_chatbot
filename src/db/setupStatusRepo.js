const { pool } = require("./db");

async function listConnectionHealth(queryable = pool) {
  const result = await queryable.query(
    `SELECT check_key, last_check_status, last_check_summary,
            last_checked_at, last_success_at, last_webhook_at
     FROM setup_connection_health
     ORDER BY check_key`
  );
  return result.rows;
}

async function saveCheckResults(results, queryable = pool) {
  for (const result of results) {
    if (!result?.key || !result?.status) continue;
    await queryable.query(
      `INSERT INTO setup_connection_health (
         check_key, last_check_status, last_check_summary,
         last_checked_at, last_success_at, updated_at
       )
       VALUES ($1, $2, $3, $4,
         CASE WHEN $2 = 'ready' THEN $4::timestamptz ELSE NULL END,
         now()
       )
       ON CONFLICT (check_key) DO UPDATE SET
         last_check_status = EXCLUDED.last_check_status,
         last_check_summary = EXCLUDED.last_check_summary,
         last_checked_at = EXCLUDED.last_checked_at,
         last_success_at = CASE
           WHEN EXCLUDED.last_check_status = 'ready' THEN EXCLUDED.last_checked_at
           ELSE setup_connection_health.last_success_at
         END,
         updated_at = now()`,
      [result.key, result.status, result.summary || null, result.checkedAt]
    );
  }
}

async function recordWebhook(checkKey, at = new Date(), queryable = pool) {
  await queryable.query(
    `INSERT INTO setup_connection_health (check_key, last_webhook_at, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (check_key) DO UPDATE SET
       last_webhook_at = GREATEST(
         COALESCE(setup_connection_health.last_webhook_at, '-infinity'::timestamptz),
         EXCLUDED.last_webhook_at
       ),
       updated_at = now()`,
    [checkKey, at]
  );
}

async function listLatestInboundActivity(queryable = pool) {
  const result = await queryable.query(
    `SELECT c.channel, MAX(m.created_at) AS last_inbound_at
     FROM messages m
     JOIN contacts c ON c.id = m.contact_id
     WHERE m.role = 'user'
       AND c.channel IN ('whatsapp', 'facebook', 'instagram')
     GROUP BY c.channel`
  );
  return result.rows;
}

async function listAiCandidateHealth(queryable = pool) {
  const result = await queryable.query(
    `SELECT candidate_key, provider, last_status, last_failure_kind,
            last_attempt_at, last_success_at, last_failure_at,
            last_rate_limited_at
     FROM setup_ai_candidate_health
     ORDER BY provider, candidate_key`
  );
  return result.rows;
}

async function recordAiCandidateOutcome(
  { candidateKey, provider, status, failureKind = null, at = new Date() },
  queryable = pool
) {
  if (!candidateKey || !["gemini", "claude"].includes(provider)) return;
  if (!["ready", "rate_limited", "unavailable", "invalid", "failed"].includes(status)) return;

  const failed = status !== "ready";
  await queryable.query(
    `INSERT INTO setup_ai_candidate_health (
       candidate_key, provider, last_status, last_failure_kind,
       last_attempt_at, last_success_at, last_failure_at,
       last_rate_limited_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       CASE WHEN $3 = 'ready' THEN $5::timestamptz ELSE NULL END,
       CASE WHEN $3 <> 'ready' THEN $5::timestamptz ELSE NULL END,
       CASE WHEN $3 = 'rate_limited' THEN $5::timestamptz ELSE NULL END,
       now()
     )
     ON CONFLICT (candidate_key) DO UPDATE SET
       provider = EXCLUDED.provider,
       last_status = CASE
         WHEN EXCLUDED.last_attempt_at >= setup_ai_candidate_health.last_attempt_at
           THEN EXCLUDED.last_status
         ELSE setup_ai_candidate_health.last_status
       END,
       last_failure_kind = CASE
         WHEN EXCLUDED.last_failure_at IS NOT NULL
          AND (setup_ai_candidate_health.last_failure_at IS NULL
            OR EXCLUDED.last_failure_at >= setup_ai_candidate_health.last_failure_at)
           THEN EXCLUDED.last_failure_kind
         ELSE setup_ai_candidate_health.last_failure_kind
       END,
       last_attempt_at = GREATEST(
         setup_ai_candidate_health.last_attempt_at,
         EXCLUDED.last_attempt_at
       ),
       last_success_at = GREATEST(
         setup_ai_candidate_health.last_success_at,
         EXCLUDED.last_success_at
       ),
       last_failure_at = GREATEST(
         setup_ai_candidate_health.last_failure_at,
         EXCLUDED.last_failure_at
       ),
       last_rate_limited_at = GREATEST(
         setup_ai_candidate_health.last_rate_limited_at,
         EXCLUDED.last_rate_limited_at
       ),
       updated_at = now()`,
    [candidateKey, provider, status, failed ? failureKind : null, at]
  );
}

async function listAiCandidateSetupChecks(queryable = pool) {
  const result = await queryable.query(
    `SELECT candidate_key, provider, last_status, last_failure_kind,
            last_checked_at, last_success_at
     FROM setup_ai_candidate_checks
     ORDER BY provider, candidate_key`
  );
  return result.rows;
}

async function recordAiCandidateSetupCheck(
  { candidateKey, provider, status, failureKind = null, at = new Date() },
  queryable = pool
) {
  if (!candidateKey || !["gemini", "claude"].includes(provider)) return;
  if (!["ready", "rate_limited", "unavailable", "invalid", "failed"].includes(status)) return;

  await queryable.query(
    `INSERT INTO setup_ai_candidate_checks (
       candidate_key, provider, last_status, last_failure_kind,
       last_checked_at, last_success_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       CASE WHEN $3 = 'ready' THEN $5::timestamptz ELSE NULL END,
       now()
     )
     ON CONFLICT (candidate_key) DO UPDATE SET
       provider = EXCLUDED.provider,
       last_status = EXCLUDED.last_status,
       last_failure_kind = EXCLUDED.last_failure_kind,
       last_checked_at = EXCLUDED.last_checked_at,
       last_success_at = CASE
         WHEN EXCLUDED.last_status = 'ready' THEN EXCLUDED.last_checked_at
         ELSE setup_ai_candidate_checks.last_success_at
       END,
       updated_at = now()`,
    [candidateKey, provider, status, status === "ready" ? null : failureKind, at]
  );
}

module.exports = {
  listAiCandidateHealth,
  listAiCandidateSetupChecks,
  listConnectionHealth,
  listLatestInboundActivity,
  recordAiCandidateOutcome,
  recordAiCandidateSetupCheck,
  recordWebhook,
  saveCheckResults,
};
