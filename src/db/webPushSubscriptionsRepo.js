const { pool } = require("./db");

async function upsertSubscription(
  { userId, endpoint, p256dh, auth, userAgent = null },
  queryable = pool
) {
  const result = await queryable.query(
    `INSERT INTO web_push_subscriptions (
       user_id, endpoint, p256dh, auth, user_agent, failure_count,
       last_success_at, last_failure_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 0, NULL, NULL, now(), now())
     ON CONFLICT (endpoint)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       failure_count = 0,
       last_failure_at = NULL,
       updated_at = now()
     RETURNING *`,
    [userId, endpoint, p256dh, auth, userAgent]
  );
  return result.rows[0] || null;
}

async function deleteSubscription(endpoint, userId = null, queryable = pool) {
  const params = [endpoint];
  let sql = "DELETE FROM web_push_subscriptions WHERE endpoint = $1";
  if (userId != null) {
    params.push(userId);
    sql += " AND user_id = $2";
  }
  const result = await queryable.query(`${sql} RETURNING id`, params);
  return Boolean(result.rows[0]);
}

async function deleteSubscriptionById(id, queryable = pool) {
  const result = await queryable.query(
    "DELETE FROM web_push_subscriptions WHERE id = $1 RETURNING id",
    [id]
  );
  return Boolean(result.rows[0]);
}

async function countForUser(userId, queryable = pool) {
  const result = await queryable.query(
    "SELECT COUNT(*)::int AS count FROM web_push_subscriptions WHERE user_id = $1",
    [userId]
  );
  return Number(result.rows[0]?.count) || 0;
}

async function listForUser(userId, queryable = pool) {
  const result = await queryable.query(
    `SELECT *
     FROM web_push_subscriptions
     WHERE user_id = $1
     ORDER BY updated_at DESC, id DESC`,
    [userId]
  );
  return result.rows;
}

async function listActiveWithUsers(queryable = pool) {
  const result = await queryable.query(
    `SELECT
       s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.user_agent,
       s.failure_count, s.updated_at,
       u.username, u.display_name, u.role, u.permissions, u.branch_name, u.is_active
     FROM web_push_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE u.is_active = true
     ORDER BY s.id ASC`
  );
  return result.rows;
}

async function markSuccess(id, queryable = pool) {
  await queryable.query(
    `UPDATE web_push_subscriptions
     SET failure_count = 0,
         last_success_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

async function markFailure(id, queryable = pool) {
  await queryable.query(
    `UPDATE web_push_subscriptions
     SET failure_count = failure_count + 1,
         last_failure_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

module.exports = {
  countForUser,
  deleteSubscription,
  deleteSubscriptionById,
  listActiveWithUsers,
  listForUser,
  markFailure,
  markSuccess,
  upsertSubscription,
};
