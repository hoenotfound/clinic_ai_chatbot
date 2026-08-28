const { pool } = require("./db");

async function getUserByUsername(username) {
  const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return result.rows[0] || null;
}

async function createUser(username, passwordHash) {
  await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
    [username, passwordHash]
  );
}

async function countUsers() {
  const result = await pool.query("SELECT COUNT(*) AS count FROM users");
  return parseInt(result.rows[0].count, 10);
}

async function listUsernames() {
  const result = await pool.query("SELECT username FROM users ORDER BY lower(username), id");
  return result.rows.map((row) => row.username);
}

module.exports = { getUserByUsername, createUser, countUsers, listUsernames };
