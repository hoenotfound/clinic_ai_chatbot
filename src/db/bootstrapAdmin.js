const bcrypt = require("bcryptjs");
const usersRepo = require("./usersRepo");

/**
 * Creates the first administrator automatically on server startup, using
 * ADMIN_USERNAME / ADMIN_PASSWORD env vars — no shell access required.
 * Only ever runs if the users table is empty, so it's safe to leave these
 * env vars set permanently; it won't create duplicates or reset passwords.
 */
async function bootstrapAdminUser() {
  const existingCount = await usersRepo.countUsers();
  if (existingCount > 0) return; // already have at least one staff login

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.warn(
      "⚠️  No staff login exists yet, and ADMIN_USERNAME/ADMIN_PASSWORD are not set. " +
        "Set them as environment variables and restart to create your first portal admin " +
        "(useful on hosts without shell access, like Render's free tier)."
    );
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await usersRepo.createUser({
    username,
    displayName: username,
    passwordHash,
    role: "admin",
    permissions: {},
  });
  console.log(`✅ Created initial portal admin "${username}" from ADMIN_USERNAME/ADMIN_PASSWORD.`);
}

module.exports = { bootstrapAdminUser };
