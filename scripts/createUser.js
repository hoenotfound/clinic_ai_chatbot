/**
 * Usage: node scripts/createUser.js <username> <password>
 * Creates a staff login for the management portal.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const usersRepo = require("../src/db/usersRepo");

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error("Usage: node scripts/createUser.js <username> <password>");
  process.exit(1);
}

if (usersRepo.getUserByUsername(username)) {
  console.error(`A user named "${username}" already exists.`);
  process.exit(1);
}

const passwordHash = bcrypt.hashSync(password, 10);
usersRepo.createUser(username, passwordHash);
console.log(`✅ Created staff login "${username}". They can now log into the portal.`);
