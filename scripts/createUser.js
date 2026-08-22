/**
 * Usage: node scripts/createUser.js <username> <password>
 * Creates a staff login for the management portal.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const usersRepo = require("../src/db/usersRepo");

const { pool, initSchema } = require("../src/db/db");

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error("Usage: node scripts/createUser.js <username> <password>");
  process.exit(1);
}

async function main() {
  await initSchema(); // ensures the users table exists if this is a fresh DB

  const existing = await usersRepo.getUserByUsername(username);
  if (existing) {
    console.error(`A user named "${username}" already exists.`);
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await usersRepo.createUser(username, passwordHash);
  console.log(`✅ Created staff login "${username}". They can now log into the portal.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create user:", err);
  process.exit(1);
});
