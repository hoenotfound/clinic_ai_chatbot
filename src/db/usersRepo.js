const { pool } = require("./db");
const { normalizePermissionOverrides, normalizeRole } = require("../utils/permissions");

async function getUserByUsername(username) {
  const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return result.rows[0] || null;
}

async function getUserById(id) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function createUser(usernameOrData, passwordHashArg) {
  const data = typeof usernameOrData === "string"
    ? {
        username: usernameOrData,
        passwordHash: passwordHashArg,
        displayName: usernameOrData,
        role: "sales",
        permissions: {},
      }
    : usernameOrData || {};

  const username = String(data.username || "").trim();
  const displayName = String(data.displayName || username).trim() || username;
  const role = normalizeRole(data.role);
  const permissions = normalizePermissionOverrides(data.permissions);

  const result = await pool.query(
    `INSERT INTO users (username, password_hash, display_name, role, permissions, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [username, data.passwordHash, displayName, role, permissions]
  );
  return result.rows[0];
}

async function countUsers() {
  const result = await pool.query("SELECT COUNT(*) AS count FROM users");
  return parseInt(result.rows[0].count, 10);
}

async function listUsernames() {
  const result = await pool.query(
    "SELECT username FROM users WHERE is_active = true ORDER BY lower(username), id"
  );
  return result.rows.map((row) => row.username);
}

async function listUsers() {
  const result = await pool.query(
    `SELECT id, username, password_hash, display_name, role, permissions,
            is_active, created_at
     FROM users
     ORDER BY is_active DESC, lower(display_name), lower(username), id`
  );
  return result.rows;
}

async function updateUser(id, updates) {
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
  if (Object.prototype.hasOwnProperty.call(updates, "isActive")) {
    push("is_active", updates.isActive === true);
  }
  if (Object.prototype.hasOwnProperty.call(updates, "passwordHash")) {
    push("password_hash", updates.passwordHash);
  }

  if (fields.length === 0) return getUserById(id);
  values.push(id);
  const result = await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function deactivateUser(id) {
  const result = await pool.query(
    "UPDATE users SET is_active = false WHERE id = $1 RETURNING *",
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  getUserByUsername,
  getUserById,
  createUser,
  countUsers,
  listUsernames,
  listUsers,
  updateUser,
  deactivateUser,
};
