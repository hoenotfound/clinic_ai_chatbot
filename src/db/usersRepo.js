const db = require("./db");

function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function createUser(username, passwordHash) {
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
    username,
    passwordHash
  );
}

function countUsers() {
  return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
}

module.exports = { getUserByUsername, createUser, countUsers };
