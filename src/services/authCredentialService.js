const bcrypt = require("bcryptjs");

// A real bcrypt hash is intentionally created once at process startup so an
// unknown username still performs the same expensive password-check work as a
// real account. This reduces username-enumeration timing differences without
// storing or exposing any real credential.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  `clinic-ai-login-dummy-${process.pid}-${Date.now()}`,
  10
);

async function verifyLoginCredentials(user, password) {
  const candidate = typeof password === "string" ? password : "";
  const validPasswordShape = candidate.length > 0 && candidate.length <= 200;
  const hash = user?.password_hash || DUMMY_PASSWORD_HASH;

  let matches = false;
  try {
    // Use the async API so several login attempts do not synchronously block the
    // Node event loop while bcrypt is doing CPU-heavy work.
    matches = await bcrypt.compare(
      validPasswordShape ? candidate : "invalid-login-password",
      hash
    );
  } catch {
    // A malformed/corrupt stored hash must fail closed like bad credentials.
    matches = false;
  }

  return Boolean(
    user &&
    user.is_active !== false &&
    validPasswordShape &&
    matches
  );
}

module.exports = {
  DUMMY_PASSWORD_HASH,
  verifyLoginCredentials,
};
