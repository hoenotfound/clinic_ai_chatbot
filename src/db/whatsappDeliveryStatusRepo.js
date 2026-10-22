const crypto = require("crypto");
const { pool } = require("./db");
const { unresolvedFailedOutboundSql } = require("../utils/deliveryReplyAttentionSql");

const SUPPORTED_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function cleanNullable(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function newLeaseToken() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeUpdate(update) {
  const wamid = cleanNullable(update?.wamid);
  const deliveryStatus = cleanNullable(update?.status)?.toLowerCase() || null;
  if (!wamid || !SUPPORTED_STATUSES.has(deliveryStatus)) return null;

  const normalized = {
    wamid,
    deliveryStatus,
    errorCode: cleanNullable(update?.errorCode),
    errorTitle: cleanNullable(update?.errorTitle),
    errorMessage: cleanNullable(update?.errorMessage),
    businessPhoneNumberId: cleanNullable(update?.businessPhoneNumberId),
    businessAccountId: cleanNullable(update?.businessAccountId),
    // An explicitly billable webhook without a type is still billing evidence.
    // Do not drop it just because the provider omitted classification fields.
    pricingType: cleanNullable(update?.pricingType) ||
      (update?.pricingBillable === true ? "unknown" : null),
    pricingBillable: typeof update?.pricingBillable === "boolean" ? update.pricingBillable : null,
    pricingCategory: cleanNullable(update?.pricingCategory)?.toLowerCase() || null,
  };
  normalized.eventKey = crypto
    .createHash("sha256")
    .update([
      normalized.wamid,
      normalized.deliveryStatus,
      normalized.errorCode || "",
      normalized.errorTitle || "",
      normalized.errorMessage || "",
      normalized.pricingType || "",
      String(normalized.pricingBillable ?? ""),
      normalized.pricingCategory || "",
      ...(normalized.businessPhoneNumberId || normalized.businessAccountId
        ? [normalized.businessPhoneNumberId || "", normalized.businessAccountId || ""]
        : []),
    ].join("\0"))
    .digest("hex");
  return normalized;
}

async function storeBatch(updates, query = pool.query.bind(pool)) {
  const normalized = (updates || []).map(normalizeUpdate).filter(Boolean);
  if (!normalized.length) return [];

  const values = [];
  const placeholders = normalized.map((item, index) => {
    const offset = index * 8;
    values.push(
      item.eventKey,
      item.wamid,
      item.deliveryStatus,
      item.errorCode,
      item.errorTitle,
      item.errorMessage,
      item.businessPhoneNumberId,
      item.businessAccountId
    );
    return '(' + Array.from({ length: 8 }, (_, i) => String.fromCharCode(36) + (offset + i + 1)).join(', ') + ')';
  });

  const result = await query(
    `INSERT INTO whatsapp_delivery_status_jobs (
       event_key, wamid, delivery_status, error_code, error_title, error_message,
       business_phone_number_id, business_account_id
     )
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    values
  );
  // Billing callbacks are separate from the short-lived status job queue.
  // Only observed Meta billing evidence is stored. Missing pricing means unknown.
  const withPricing = normalized.filter((item) => item.pricingType);
  for (const item of withPricing) {
    await query(`INSERT INTO whatsapp_free_entry_pricing_evidence
       (wamid, pricing_type, billable, delivery_status, pricing_category,
        business_phone_number_id, business_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (wamid) DO UPDATE
       SET pricing_type = CASE
             WHEN whatsapp_free_entry_pricing_evidence.billable = true
               THEN whatsapp_free_entry_pricing_evidence.pricing_type
             WHEN EXCLUDED.billable = true THEN EXCLUDED.pricing_type
             ELSE EXCLUDED.pricing_type
           END,
           billable = CASE
             WHEN whatsapp_free_entry_pricing_evidence.billable = true OR EXCLUDED.billable = true THEN true
             WHEN whatsapp_free_entry_pricing_evidence.billable = false OR EXCLUDED.billable = false THEN false
             ELSE NULL
           END,
           delivery_status = CASE
             WHEN whatsapp_free_entry_pricing_evidence.delivery_status = 'failed' THEN 'failed'
             WHEN EXCLUDED.delivery_status = 'failed' THEN 'failed'
             WHEN whatsapp_free_entry_pricing_evidence.delivery_status = 'read' THEN 'read'
             WHEN EXCLUDED.delivery_status = 'read' THEN 'read'
             WHEN whatsapp_free_entry_pricing_evidence.delivery_status = 'delivered' THEN 'delivered'
             ELSE EXCLUDED.delivery_status
           END,
           pricing_category = CASE
             WHEN whatsapp_free_entry_pricing_evidence.pricing_category IS NOT NULL
               AND EXCLUDED.pricing_category IS NOT NULL
               AND whatsapp_free_entry_pricing_evidence.pricing_category <> EXCLUDED.pricing_category
               THEN 'conflicting'
             ELSE COALESCE(whatsapp_free_entry_pricing_evidence.pricing_category,
                           EXCLUDED.pricing_category)
           END,
           business_phone_number_id = COALESCE(
             whatsapp_free_entry_pricing_evidence.business_phone_number_id,
             EXCLUDED.business_phone_number_id),
           business_account_id = COALESCE(
             whatsapp_free_entry_pricing_evidence.business_account_id,
             EXCLUDED.business_account_id),
           updated_at = now()
       WHERE (whatsapp_free_entry_pricing_evidence.business_phone_number_id IS NULL
              OR EXCLUDED.business_phone_number_id IS NULL
              OR whatsapp_free_entry_pricing_evidence.business_phone_number_id =
                 EXCLUDED.business_phone_number_id)
         AND (whatsapp_free_entry_pricing_evidence.business_account_id IS NULL
              OR EXCLUDED.business_account_id IS NULL
              OR whatsapp_free_entry_pricing_evidence.business_account_id =
                 EXCLUDED.business_account_id)`,
       [item.wamid, item.pricingType, item.pricingBillable,
        item.deliveryStatus, item.pricingCategory,
        item.businessPhoneNumberId, item.businessAccountId]);
  }
  // Queue every unexpected billable callback (marketing, unclassified, and
  // conflicting categories included). Exempt ONLY an accepted 24h text
  // service reply whose persisted Meta receipt proves regular/service billing.
  // Using the durable receipt handles webhook-before-acceptance and later
  // category corrections. The UNIQUE wamid and ON CONFLICT make it idempotent.
  for (const item of withPricing) {
    if (item.pricingBillable !== true) continue;
    const account = item.businessPhoneNumberId ||
      String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
    if (!account) continue;
    await query(
      `INSERT INTO whatsapp_free_only_billing_alerts (wamid,phone_number_id)
       SELECT $1,$2
       WHERE NOT EXISTS(
         SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
         JOIN whatsapp_free_entry_pricing_evidence receipt
           ON receipt.wamid=ex.wamid
         WHERE ex.wamid=$1 AND ex.status='accepted'
           AND receipt.billable=true
           AND receipt.pricing_type='regular'
           AND receipt.pricing_category='service'
       )
       ON CONFLICT(wamid) DO NOTHING`,
      [item.wamid,account]
    );
  }
  return result.rows;
}

async function claimByIds(ids, query = pool.query.bind(pool)) {
  const cleanIds = (ids || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!cleanIds.length) return [];

  const leaseToken = newLeaseToken();
  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM whatsapp_delivery_status_jobs
       WHERE id = ANY($1::bigint[])
         AND terminal_at IS NULL
         AND processing_status IN ('pending', 'failed')
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_delivery_status_jobs job
     SET processing_status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = NOW(),
         lease_token = $2,
         last_error = NULL,
         updated_at = NOW()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.*`,
    [cleanIds, leaseToken]
  );
  return result.rows;
}

async function claimRecoverable(
  { limit = 50, staleAfterSeconds = 60, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const leaseToken = newLeaseToken();
  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM whatsapp_delivery_status_jobs
       WHERE terminal_at IS NULL
         AND attempts < $3
         AND (
           processing_status IN ('pending', 'failed')
           OR (
             processing_status = 'processing'
             AND claimed_at < NOW() - ($2::integer * interval '1 second')
           )
         )
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_delivery_status_jobs job
     SET processing_status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = NOW(),
         lease_token = $4,
         last_error = NULL,
         updated_at = NOW()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.*`,
    [limit, staleAfterSeconds, maxAttempts, leaseToken]
  );
  return result.rows;
}

async function listExhausted(
  { limit = 50, staleAfterSeconds = 60, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT *
     FROM whatsapp_delivery_status_jobs
     WHERE terminal_at IS NULL
       AND processing_status <> 'completed'
       AND attempts >= $3
       AND (
         processing_status <> 'processing'
         OR claimed_at < NOW() - ($2::integer * interval '1 second')
       )
     ORDER BY created_at, id
     LIMIT $1`,
    [limit, staleAfterSeconds, maxAttempts]
  );
  return result.rows;
}

async function markCompleted(id, leaseToken, query = pool.query.bind(pool)) {
  if (!leaseToken) return null;
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'completed',
         completed_at = NOW(),
         claimed_at = NULL,
         lease_token = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND lease_token = $2
       AND terminal_at IS NULL
       AND processing_status = 'processing'
     RETURNING *`,
    [id, leaseToken]
  );
  return result.rows[0] || null;
}

async function markFailed(id, leaseToken, error, query = pool.query.bind(pool)) {
  if (!leaseToken) return null;
  const message = String(error?.message || error || "Delivery-status processing failed.").slice(0, 1000);
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $3,
         updated_at = NOW()
     WHERE id = $1
       AND lease_token = $2
       AND terminal_at IS NULL
       AND processing_status = 'processing'
     RETURNING *`,
    [id, leaseToken, message]
  );
  return result.rows[0] || null;
}

async function markTerminal(id, query = pool.query.bind(pool)) {
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         lease_token = NULL,
         terminal_at = COALESCE(terminal_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND terminal_at IS NULL
       AND processing_status <> 'completed'
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function findMessageByWamid(wamid, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT id, contact_id, whatsapp_message_id, delivery_status, delivery_error
     FROM messages
     WHERE whatsapp_message_id = $1
     LIMIT 1`,
    [wamid]
  );
  return result.rows[0] || null;
}

// Durable delivery-status recovery must be able to restore the Inbox attention
// flag without replaying contactsRepo's best-effort Telegram side effect. This
// mirrors contactsRepo.setDeliveryAttention's precedence rules while keeping the
// durable database mutation independent from external notification delivery.
async function setDeliveryAttentionState(
  contactId,
  reason,
  query = pool.query.bind(pool),
  failedMessageId = null
) {
  const result = await query(
    `UPDATE contacts
     SET needs_attention = true, attention_reason = $1,
         delivery_attention_message_id = $3::integer,
         updated_at = now()
     WHERE id = $2
       AND (
         needs_attention = false
         OR attention_reason IS NULL
         OR attention_reason LIKE 'Delivery failed:%'
         OR attention_reason LIKE 'Delivery unconfirmed:%'
       )
       -- The same provider error text can describe two different failed
       -- outbound messages. A matching reason alone is NOT a replay when
       -- the failed message ID changed. Compare both parts of the task key.
       AND (
         needs_attention IS DISTINCT FROM true
         OR attention_reason IS DISTINCT FROM $1
         OR (
           $3::integer IS NOT NULL
           AND delivery_attention_message_id IS DISTINCT FROM $3::integer
         )
       )
       -- An out-of-order failed callback for an old *text* message must not
       -- reopen a conversation already answered with a newer accepted direct
       -- reply. Failed attachments remain actionable even after later text.
       -- Keep the predicate in this durable UPDATE to close the race with
       -- a concurrent Inbox send/retry and to cover recovered callbacks.
       AND (
         $3::integer IS NULL
         OR EXISTS (
           SELECT 1 FROM messages failed
           WHERE failed.id = $3::integer
             AND failed.contact_id = contacts.id
             AND failed.delivery_status = 'failed'
             -- Use the same dismissal, customer-episode and accepted-reply
             -- safeguards as Staff Assist. An out-of-order callback for
             -- historical media may not resurrect a routine alert, but
             -- explicitly open delivery warnings remain protected.
             AND ${unresolvedFailedOutboundSql("failed", "contacts")}
         )
       )
       -- Provider webhooks arrive out of order. Once another, newer failed
       -- attempt owns the delivery warning, replaying an older callback
       -- must not steal the task anchor or its human-readable reason.
       AND (
         $3::integer IS NULL
         OR contacts.needs_attention IS DISTINCT FROM TRUE
         OR NOT (
           contacts.attention_reason LIKE 'Delivery failed:%'
           OR contacts.attention_reason LIKE 'Delivery unconfirmed:%'
         )
         OR contacts.delivery_attention_message_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM messages active_attempt
           JOIN messages callback_attempt ON callback_attempt.id = $3::integer
           WHERE active_attempt.id = contacts.delivery_attention_message_id
             AND active_attempt.contact_id = contacts.id
             AND (active_attempt.created_at, active_attempt.id) >
                 (callback_attempt.created_at, callback_attempt.id)
         )
       )
     RETURNING id`,
    [reason, contactId, failedMessageId]
  );
  return result.rows[0] || null;
}

// A completed failed callback can become orphaned if its linked message is
// later removed, or if an external WAMID was never durably associated.
// Wait for late provider/message persistence and dedupe flags in the database.
// This is an operational anomaly, not proof a customer is still undelivered.
async function flagUnmatchedCompletedFailures(
  { graceSeconds = 300, limit = 25 } = {},
  query = pool.query.bind(pool)
) {
  const safeGrace = Math.max(60, Math.min(86400, Math.trunc(Number(graceSeconds) || 300)));
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 25)));
  const result = await query(
    `WITH candidates AS (
       SELECT j.id
       FROM whatsapp_delivery_status_jobs j
       WHERE j.delivery_status = 'failed'
         AND j.processing_status = 'completed'
         AND j.completed_at < NOW() - ($1::integer * interval '1 second')
         AND j.unmatched_detected_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.whatsapp_message_id = j.wamid
         )
         AND NOT EXISTS (
           SELECT 1 FROM outbound_message_evidence e
           WHERE e.provider_message_id = j.wamid
         )
       ORDER BY j.completed_at, j.id
       LIMIT $2
       FOR UPDATE OF j SKIP LOCKED
     )
     UPDATE whatsapp_delivery_status_jobs j
     SET unmatched_detected_at = NOW(),
         updated_at = NOW()
     FROM candidates
     WHERE j.id = candidates.id
     RETURNING j.id, j.error_code, j.error_title, j.unmatched_detected_at`,
    [safeGrace, safeLimit]
  );
  return result.rows;
}

async function pruneCompleted({ olderThanHours = 24 } = {}, query = pool.query.bind(pool)) {
  const result = await query(
    `DELETE FROM whatsapp_delivery_status_jobs
     WHERE processing_status = 'completed'
       AND completed_at < NOW() - ($1::integer * interval '1 hour')
       AND (
         unmatched_detected_at IS NULL
         OR completed_at < NOW() - interval '30 days'
       )`,
    [olderThanHours]
  );
  return result.rowCount || 0;
}

module.exports = {
  SUPPORTED_STATUSES,
  normalizeUpdate,
  storeBatch,
  claimByIds,
  claimRecoverable,
  listExhausted,
  markCompleted,
  markFailed,
  markTerminal,
  findMessageByWamid,
  setDeliveryAttentionState,
  pruneCompleted,
  flagUnmatchedCompletedFailures,
};
