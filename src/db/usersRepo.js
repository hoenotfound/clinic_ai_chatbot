const { pool } = require("./db");
const { normalizePermissionOverrides, normalizeRole } = require("../utils/permissions");

async function getUserByUsername(username, queryable = pool) {
  const result = await queryable.query("SELECT * FROM users WHERE username = $1", [username]);
  return result.rows[0] || null;
}

async function getUserById(id, queryable = pool) {
  const result = await queryable.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function createUser(usernameOrData, passwordHashArg, queryable = pool) {
  const data = typeof usernameOrData === "string"
    ? {
        username: usernameOrData,
        passwordHash: passwordHashArg,
        displayName: usernameOrData,
        role: "sales",
        permissions: {},
        branchName: null,
      }
    : usernameOrData || {};

  const username = String(data.username || "").trim();
  const displayName = String(data.displayName || username).trim() || username;
  const role = normalizeRole(data.role);
  const permissions = normalizePermissionOverrides(data.permissions);
  const branchName = role === "sales" && data.branchName
    ? String(data.branchName).trim() || null
    : null;

  const result = await queryable.query(
    `INSERT INTO users (
       username, password_hash, display_name, role, permissions, branch_name, is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [username, data.passwordHash, displayName, role, permissions, branchName]
  );
  return result.rows[0];
}

async function countUsers(queryable = pool) {
  const result = await queryable.query("SELECT COUNT(*) AS count FROM users");
  return parseInt(result.rows[0].count, 10);
}

async function listUsernames(queryable = pool) {
  const result = await queryable.query(
    "SELECT username FROM users WHERE is_active = true ORDER BY lower(username), id"
  );
  return result.rows.map((row) => row.username);
}

async function listActiveSalesUsers(queryable = pool) {
  const result = await queryable.query(
    `SELECT id, username, display_name, branch_name
     FROM users
     WHERE is_active = true
       AND role = 'sales'
       AND (
         COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
         OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
       )
       AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
     ORDER BY id ASC`
  );
  return result.rows;
}

async function listUsers(queryable = pool) {
  const result = await queryable.query(
    `SELECT id, username, password_hash, display_name, role, permissions,
            branch_name, is_active, auth_version, created_at
     FROM users
     ORDER BY is_active DESC, lower(display_name), lower(username), id`
  );
  return result.rows;
}

async function updateUser(id, updates, queryable = pool) {
  const fields = [];
  const values = [];
  const push = (column, value) => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(updates, "displayName")) {
    push("display_name", updates.displayName);
  }
  if (Object.prototype.hasOwnProperty.call(updates, "role")) {
    push("role", normalizeRole(updates.role));
  }
  if (Object.prototype.hasOwnProperty.call(updates, "permissions")) {
    push("permissions", normalizePermissionOverrides(updates.permissions));
  }
  if (Object.prototype.hasOwnProperty.call(updates, "branchName")) {
    push("branch_name", updates.branchName || null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, "isActive")) {
    push("is_active", updates.isActive === true);
  }
  if (Object.prototype.hasOwnProperty.call(updates, "passwordHash")) {
    push("password_hash", updates.passwordHash);
    fields.push("auth_version = auth_version + 1");
  }

  if (fields.length === 0) return getUserById(id, queryable);
  values.push(id);
  const result = await queryable.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function deactivateUser(id, queryable = pool) {
  const result = await queryable.query(
    "UPDATE users SET is_active = false WHERE id = $1 RETURNING *",
    [id]
  );
  return result.rows[0] || null;
}

async function withAdminMutationLock(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize destructive team-access changes so two administrators cannot
    // simultaneously pass the "last admin / last team manager" safety check.
    // The two-key advisory lock is scoped to this transaction and application.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [4341, 1]);
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

module.exports = {
  getUserByUsername,
  getUserById,
  createUser,
  countUsers,
  listUsernames,
  listActiveSalesUsers,
  listUsers,
  updateUser,
  deactivateUser,
  withAdminMutationLock,
};
