const express = require("express");
const bcrypt = require("bcryptjs");
const usersRepo = require("../db/usersRepo");
const clinicConfig = require("../config/clinicConfig");
const realtimeEvents = require("../utils/realtimeEvents");
const { loginRateLimit, recordFailedAttempt, clearAttempts } = require("../middleware/loginRateLimit");
const { verifyLoginCredentials } = require("../services/authCredentialService");
const { requireAuth, requireCapability } = require("../middleware/requireAuth");
const { ownedLeadContinuityError } = require("../utils/leadOwnerContinuity");
const {
  effectivePermissions,
  normalizePermissionOverrides,
  presentUser,
  publicPermissionDefinitions,
  roleDefaults,
} = require("../utils/permissions");

const router = express.Router();
const USERNAME_RE = /^[A-Za-z0-9._-]{3,60}$/;
const ROLES = new Set(["admin", "sales"]);

// Authentication responses can contain account/session state and should never
// be cached by browsers or intermediary proxies. Whenever this router changes a
// session in production, force the cookie to carry the Secure attribute. The
// app runs behind Render's TLS-terminating proxy, so the browser still receives
// the cookie over HTTPS even though Render forwards plain HTTP internally.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.sessionOptions && process.env.NODE_ENV === "production") {
    req.sessionOptions.secure = true;
  }
  next();
});

function validateDisplayName(value) {
  const displayName = typeof value === "string" ? value.trim() : "";
  return displayName && displayName.length <= 100 ? displayName : null;
}

function validatePassword(value, { optional = false } = {}) {
  if ((value == null || value === "") && optional) return null;
  if (typeof value !== "string" || value.length < 8 || value.length > 200) return false;
  return value;
}

function configuredBranches() {
  return (clinicConfig.branches || [])
    .map((branch) => String(branch?.name || "").trim())
    .filter(Boolean);
}

function validateBranchName(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) return null;
  const match = configuredBranches().find(
    (branchName) => branchName.toLowerCase() === requested.toLowerCase()
  );
  return match || false;
}

function proposedUser(users, targetId, updates) {
  return users.map((user) => {
    if (Number(user.id) !== Number(targetId)) return user;
    return {
      ...user,
      display_name: Object.prototype.hasOwnProperty.call(updates, "displayName")
        ? updates.displayName
        : user.display_name,
      role: Object.prototype.hasOwnProperty.call(updates, "role") ? updates.role : user.role,
      permissions: Object.prototype.hasOwnProperty.call(updates, "permissions")
        ? updates.permissions
        : user.permissions,
      branch_name: Object.prototype.hasOwnProperty.call(updates, "branchName")
        ? updates.branchName
        : user.branch_name,
      is_active: Object.prototype.hasOwnProperty.call(updates, "isActive")
        ? updates.isActive
        : user.is_active,
    };
  });
}

function validateAdminSafety(users) {
  const activeUsers = users.filter((user) => user.is_active !== false);
  if (!activeUsers.some((user) => user.role === "admin")) {
    return "At least one active admin account is required.";
  }
  if (!activeUsers.some((user) => effectivePermissions(user).manage_users === true)) {
    return "At least one active account must be able to manage team access.";
  }
  return null;
}

function mutationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function touchesLeadServiceEligibility(updates) {
  return ["role", "permissions", "isActive"].some((key) =>
    Object.prototype.hasOwnProperty.call(updates || {}, key)
  );
}

router.post("/login", loginRateLimit, async (req, res) => {
  const rawUsername = req.body?.username;
  const password = req.body?.password;
  const username = typeof rawUsername === "string" ? rawUsername.trim() : "";
  if (!username || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    // Only usernames that could have been created by the portal are allowed to
    // reach Postgres. Malformed identifiers still take the dummy-bcrypt path
    // and are recorded as failed authentication below, so validation does not
    // become an account-enumeration shortcut.
    const user = USERNAME_RE.test(username)
      ? await usersRepo.getUserByUsername(username)
      : null;
    const credentialsValid = await verifyLoginCredentials(user, password);
    if (!credentialsValid) {
      try {
        await recordFailedAttempt(req);
      } catch (rateLimitErr) {
        // Do not allow a persistent limiter outage to silently turn brute-force
        // protection off. A valid login would also depend on the same database.
        console.error("Failed to persist rejected login attempt:", rateLimitErr);
        return res.status(503).json({
          error: "Login is temporarily unavailable. Please try again shortly.",
        });
      }
      return res.status(401).json({ error: "Invalid username or password." });
    }

    try {
      await clearAttempts(req);
    } catch (rateLimitErr) {
      // Clearing stale username/pair failures is convenience after a successful
      // authentication, not a reason to deny a legitimate staff login.
      console.warn("Failed to clear successful login rate-limit buckets:", rateLimitErr?.message || rateLimitErr);
    }

    // Replace the entire pre-auth cookie payload rather than mutating whatever
    // the browser sent. cookie-session is signed client-side state, so this
    // produces a fresh authenticated cookie containing only server-approved
    // fields and avoids carrying arbitrary pre-login session properties forward.
    req.session = {
      userId: user.id,
      username: user.username,
      authVersion: Number(user.auth_version) || 0,
    };
    return res.json({ username: user.username, user: presentUser(user) });
  } catch (err) {
    console.error("Login failed:", err);
    return res.status(500).json({ error: "Something went wrong logging in." });
  }
});

router.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username, user: presentUser(req.user) });
});

router.get("/users", requireAuth, requireCapability("manage_users"), async (req, res) => {
  try {
    const users = await usersRepo.listUsers();
    res.json({
      users: users.map(presentUser),
      branches: configuredBranches(),
      permissionDefinitions: publicPermissionDefinitions(),
      roleDefaults: {
        admin: roleDefaults("admin"),
        sales: roleDefaults("sales"),
      },
      currentUserId: req.user.id,
    });
  } catch (err) {
    console.error("Failed to list staff accounts:", err);
    res.status(500).json({ error: "Something went wrong loading team access." });
  }
});

router.post("/users", requireAuth, requireCapability("manage_users"), async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const displayName = validateDisplayName(req.body?.displayName || username);
  const password = validatePassword(req.body?.password);
  const role = req.body?.role || "sales";
  const requestedBranch = validateBranchName(req.body?.branchName);

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: "Username must be 3–60 characters using letters, numbers, dots, dashes or underscores.",
    });
  }
  if (!displayName) {
    return res.status(400).json({ error: "Display name is required and must be 100 characters or fewer." });
  }
  if (!password) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!ROLES.has(role)) {
    return res.status(400).json({ error: "Role must be admin or sales." });
  }
  if (requestedBranch === false) {
    return res.status(400).json({ error: "Choose a branch that exists in clinic settings." });
  }

  try {
    if (await usersRepo.getUserByUsername(username)) {
      return res.status(409).json({ error: "That username is already in use." });
    }

    const created = await usersRepo.createUser({
      username,
      displayName,
      passwordHash: bcrypt.hashSync(password, 10),
      role,
      branchName: role === "sales" ? requestedBranch : null,
      permissions: normalizePermissionOverrides(req.body?.permissions),
    });
    res.status(201).json({ user: presentUser(created) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "That username is already in use." });
    }
    console.error("Failed to create staff account:", err);
    res.status(500).json({ error: "Something went wrong creating this account." });
  }
});

router.patch("/users/:userId", requireAuth, requireCapability("manage_users"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Invalid staff account id." });
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "displayName")) {
    const displayName = validateDisplayName(req.body.displayName);
    if (!displayName) {
      return res.status(400).json({ error: "Display name is required and must be 100 characters or fewer." });
    }
    updates.displayName = displayName;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "role")) {
    if (!ROLES.has(req.body.role)) {
      return res.status(400).json({ error: "Role must be admin or sales." });
    }
    updates.role = req.body.role;
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "permissions")) {
      updates.permissions = {};
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "permissions")) {
    updates.permissions = normalizePermissionOverrides(req.body.permissions);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "branchName")) {
    const branchName = validateBranchName(req.body.branchName);
    if (branchName === false) {
      return res.status(400).json({ error: "Choose a branch that exists in clinic settings." });
    }
    updates.branchName = branchName;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "isActive")) {
    if (typeof req.body.isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be true or false." });
    }
    if (userId === Number(req.user.id) && req.body.isActive === false) {
      return res.status(400).json({ error: "You can't disable the account you're currently using." });
    }
    updates.isActive = req.body.isActive;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "password")) {
    const password = validatePassword(req.body.password, { optional: true });
    if (password === false) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (password) updates.passwordHash = bcrypt.hashSync(password, 10);
  }

  try {
    const updated = await usersRepo.withAdminMutationLock(async (queryable) => {
      // Lock this account so automatic lead assignment cannot select it halfway
      // through a disable/permission change and strand a newly assigned lead.
      const current = await usersRepo.getUserByIdForUpdate(userId, queryable);
      if (!current) throw mutationError("STAFF_NOT_FOUND", "Staff account not found.");

      const nextRole = updates.role || current.role;
      if (nextRole !== "sales") {
        updates.branchName = null;
      }

      const allUsers = await usersRepo.listUsers(queryable);
      const safetyError = validateAdminSafety(proposedUser(allUsers, userId, updates));
      if (safetyError) throw mutationError("ADMIN_SAFETY", safetyError);

      if (touchesLeadServiceEligibility(updates)) {
        const openLeadCount = await usersRepo.countOpenOwnedLeads(current.username, queryable);
        const continuityError = ownedLeadContinuityError(current, updates, openLeadCount);
        if (continuityError) throw mutationError("OWNED_LEADS", continuityError);
      }

      return usersRepo.updateUser(userId, updates, queryable);
    });

    if (
      userId === Number(req.user.id) &&
      Object.prototype.hasOwnProperty.call(updates, "passwordHash")
    ) {
      // Keep the password-resetting browser signed in while every other session
      // still carries the previous version and is rejected on its next request.
      req.session.authVersion = Number(updated?.auth_version) || 0;
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, "role") ||
      Object.prototype.hasOwnProperty.call(updates, "permissions") ||
      Object.prototype.hasOwnProperty.call(updates, "isActive") ||
      Object.prototype.hasOwnProperty.call(updates, "passwordHash")
    ) {
      // SSE permissions are snapshotted when the connection opens. Force the
      // browser to reconnect after access or credential changes so stale
      // realtime authorization cannot remain on a long-lived connection.
      realtimeEvents.disconnectUser(userId);
    }
    res.json({ user: presentUser(updated) });
  } catch (err) {
    if (err.code === "STAFF_NOT_FOUND") {
      return res.status(404).json({ error: err.message });
    }
    if (err.code === "ADMIN_SAFETY") {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "OWNED_LEADS") {
      return res.status(409).json({ error: err.message, code: "OPEN_LEADS_REQUIRE_REASSIGNMENT" });
    }
    console.error("Failed to update staff account:", err);
    res.status(500).json({ error: "Something went wrong updating this account." });
  }
});

router.delete("/users/:userId", requireAuth, requireCapability("manage_users"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Invalid staff account id." });
  }
  if (userId === Number(req.user.id)) {
    return res.status(400).json({ error: "You can't remove the account you're currently using." });
  }

  try {
    const removed = await usersRepo.withAdminMutationLock(async (queryable) => {
      // Pair this row lock with the assignment trigger's KEY SHARE lock so an
      // account cannot be removed at the same moment it receives a new lead.
      const current = await usersRepo.getUserByIdForUpdate(userId, queryable);
      if (!current) throw mutationError("STAFF_NOT_FOUND", "Staff account not found.");

      const allUsers = await usersRepo.listUsers(queryable);
      const safetyError = validateAdminSafety(
        proposedUser(allUsers, userId, { isActive: false })
      );
      if (safetyError) throw mutationError("ADMIN_SAFETY", safetyError);

      const openLeadCount = await usersRepo.countOpenOwnedLeads(current.username, queryable);
      const continuityError = ownedLeadContinuityError(
        current,
        { isActive: false },
        openLeadCount
      );
      if (continuityError) throw mutationError("OWNED_LEADS", continuityError);

      return usersRepo.deactivateUser(userId, queryable);
    });

    realtimeEvents.disconnectUser(userId);
    res.json({ removed: true, user: presentUser(removed) });
  } catch (err) {
    if (err.code === "STAFF_NOT_FOUND") {
      return res.status(404).json({ error: err.message });
    }
    if (err.code === "ADMIN_SAFETY") {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "OWNED_LEADS") {
      return res.status(409).json({ error: err.message, code: "OPEN_LEADS_REQUIRE_REASSIGNMENT" });
    }
    console.error("Failed to remove staff access:", err);
    res.status(500).json({ error: "Something went wrong removing this account." });
  }
});

module.exports = router;
