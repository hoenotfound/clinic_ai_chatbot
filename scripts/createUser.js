/**
 * Usage: node scripts/createUser.js <username> <password> [sales|admin]
 * Creates a staff login for the management portal. New CLI accounts default
 * to Sales, matching the safer default used by Settings > Team & Access.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const usersRepo = require("../src/db/usersRepo");

const { pool, initSchema } = require("../src/db/db");

const [, , username, password, requestedRole = "sales"] = process.argv;
const role = String(requestedRole).toLowerCase();

if (!username || !password || !["sales", "admin"].includes(role)) {
  console.error("Usage: node scripts/createUser.js <username> <password> [sales|admin]");
  process.exit(1);
}

async function main() {
  await initSchema();

  const existing = await usersRepo.getUserByUsername(username);
  if (existing) {
    console.error(`A user named "${username}" already exists.`);
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await usersRepo.createUser({
    username,
    displayName: username,
    passwordHash,
    role,
    permissions: {},
  });
  console.log(`✅ Created ${role} portal login "${username}".`);
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create user:", err);
  process.exit(1);
});
