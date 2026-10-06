const { pool } = require("./db");

function isAllowedPushEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint || ""));
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.port && url.port !== "443") return false;

    const host = url.hostname.toLowerCase();
    return (
      host === "fcm.googleapis.com" ||
      host === "android.googleapis.com" ||
      host === "push.services.mozilla.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host === "push.apple.com" ||
      host.endsWith(".push.apple.com")
    );
  } catch (_) {
    return false;
  }
}

function cleanSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || "").trim();
  const p256dh = String(subscription?.keys?.p256dh || "").trim();
  const auth = String(subscription?.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) return null;
  if (!isAllowedPushEndpoint(endpoint)) return null;
  return { endpoint, p256dh, auth };
}

async function upsertSubscription(userId, subscription, userAgent = null, queryable = pool) {
  const cleaned = cleanSubscription(subscription);
  if (!cleaned) return null;
  const result = await queryable.query(
    `INSERT INTO staff_push_subscriptions (
       user_id, endpoint, p256dh, auth, user_agent, disabled_at
     )
     VALUES ($1, $2, $3, $4, $5, NULL)
     ON CONFLICT (endpoint) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         updated_at = now(),
         disabled_at = NULL,
         failure_count = 0
     RETURNING id, user_id, endpoint, created_at, updated_at`,
    [
      Number(userId),
      cleaned.endpoint,
      cleaned.p256dh,
      cleaned.auth,
      userAgent ? String(userAgent).slice(0, 500) : null,
    ]
  );
  return result.rows[0] || null;
}

async function removeSubscription(userId, endpoint, queryable = pool) {
  const result = await queryable.query(
    `DELETE FROM staff_push_subscriptions
     WHERE user_id = $1 AND endpoint = $2
     RETURNING id`,
    [Number(userId), String(endpoint || "")]
  );
  return Boolean(result.rows[0]);
}

async function listActiveSubscriptions(queryable = pool) {
  const result = await queryable.query(
    `SELECT
       s.id, s.user_id, s.endpoint, s.p256dh, s.auth,
       u.username, u.role, u.permissions, u.is_active
     FROM staff_push_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.disabled_at IS NULL
       AND u.is_active = true
     ORDER BY s.id ASC`
  );
  return result.rows;
}

async function getActiveSubscriptionForUser(userId, endpoint, queryable = pool) {
  const result = await queryable.query(
    `SELECT
       s.id, s.user_id, s.endpoint, s.p256dh, s.auth,
       u.username, u.role, u.permissions, u.is_active
     FROM staff_push_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.disabled_at IS NULL
       AND u.is_active = true
       AND s.user_id = $1
       AND s.endpoint = $2
     LIMIT 1`,
    [Number(userId), String(endpoint || "")]
  );
  return result.rows[0] || null;
}

async function listActiveSubscriptionsForUser(userId, queryable = pool) {
  const result = await queryable.query(
    `SELECT
       s.id, s.user_id, s.endpoint, s.p256dh, s.auth,
       u.username, u.role, u.permissions, u.is_active
     FROM staff_push_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.disabled_at IS NULL
       AND u.is_active = true
       AND s.user_id = $1
     ORDER BY s.id ASC`,
    [Number(userId)]
  );
  return result.rows;
}

async function removeAllForUser(userId, queryable = pool) {
  const result = await queryable.query(
    `DELETE FROM staff_push_subscriptions
     WHERE user_id = $1
     RETURNING id`,
    [Number(userId)]
  );
  return result.rowCount || 0;
}

async function markSuccess(id, queryable = pool) {
  await queryable.query(
    `UPDATE staff_push_subscriptions
     SET last_success_at = now(), failure_count = 0, updated_at = now()
     WHERE id = $1`,
    [Number(id)]
  );
}

async function markFailure(id, { terminal = false } = {}, queryable = pool) {
  await queryable.query(
    `UPDATE staff_push_subscriptions
     SET last_failure_at = now(),
         failure_count = failure_count + 1,
         disabled_at = CASE WHEN $2::boolean THEN now() ELSE disabled_at END,
         updated_at = now()
     WHERE id = $1`,
    [Number(id), terminal]
  );
}

module.exports = {
  cleanSubscription,
  isAllowedPushEndpoint,
  getActiveSubscriptionForUser,
  listActiveSubscriptions,
  listActiveSubscriptionsForUser,
  markFailure,
  markSuccess,
  removeAllForUser,
  removeSubscription,
  upsertSubscription,
};
