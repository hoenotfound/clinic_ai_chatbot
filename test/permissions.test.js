const test = require("node:test");
const assert = require("node:assert/strict");
const {
  effectivePermissions,
  hasCapability,
  normalizePermissionOverrides,
  presentUser,
  roleDefaults,
} = require("../src/utils/permissions");

test("admin defaults grant every capability", () => {
  const defaults = roleDefaults("admin");
  assert.ok(Object.keys(defaults).length > 0);
  assert.equal(Object.values(defaults).every(Boolean), true);
});

test("sales defaults are limited to assigned lead work", () => {
  const defaults = roleDefaults("sales");
  assert.equal(defaults.view_assigned_leads, true);
  assert.equal(defaults.reply_to_assigned_leads, true);
  assert.equal(defaults.manage_assigned_leads, true);
  assert.equal(defaults.view_all_leads, false);
  assert.equal(defaults.manage_users, false);
  assert.equal(defaults.manage_settings, false);
});

test("per-user capability overrides can enable or disable role defaults", () => {
  const admin = {
    role: "admin",
    permissions: { view_analytics: false },
  };
  const sales = {
    role: "sales",
    permissions: { view_analytics: true },
  };

  assert.equal(hasCapability(admin, "view_analytics"), false);
  assert.equal(hasCapability(admin, "manage_settings"), true);
  assert.equal(hasCapability(sales, "view_analytics"), true);
  assert.equal(hasCapability(sales, "manage_settings"), false);
});

test("unknown or non-boolean overrides are ignored", () => {
  assert.deepEqual(
    normalizePermissionOverrides({
      view_analytics: true,
      manage_users: "yes",
      not_a_real_capability: true,
    }),
    { view_analytics: true }
  );
});

test("presentUser never exposes password hashes and returns effective permissions", () => {
  const presented = presentUser({
    id: 7,
    username: "jessica",
    display_name: "Jessica Tan",
    role: "sales",
    is_active: true,
    password_hash: "secret-hash",
    permissions: { create_leads: true },
    created_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(presented.username, "jessica");
  assert.equal(presented.displayName, "Jessica Tan");
  assert.equal(presented.password_hash, undefined);
  assert.equal(presented.permissions.create_leads, true);
  assert.equal(presented.permissions.view_all_leads, false);
  assert.deepEqual(presented.permissions, effectivePermissions({
    role: "sales",
    permissions: { create_leads: true },
  }));
});
