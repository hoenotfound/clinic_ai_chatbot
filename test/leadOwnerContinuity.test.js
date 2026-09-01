const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  canContinueServingOwnedLeads,
  ownedLeadContinuityError,
} = require("../src/utils/leadOwnerContinuity");

const salesUser = {
  username: "jessica",
  display_name: "Jessica",
  role: "sales",
  is_active: true,
  permissions: {},
};

test("active Sales with assigned-lead view and reply can keep owned leads", () => {
  assert.equal(canContinueServingOwnedLeads(salesUser), true);
  assert.equal(ownedLeadContinuityError(salesUser, {}, 3), null);
});

test("disabling an owner with open leads requires reassignment first", () => {
  const error = ownedLeadContinuityError(salesUser, { isActive: false }, 2);
  assert.match(error, /Reassign 2 open leads/i);
});

test("removing owned-lead visibility requires reassignment unless all-lead view remains", () => {
  const blocked = ownedLeadContinuityError(
    salesUser,
    { permissions: { view_assigned_leads: false } },
    1
  );
  assert.match(blocked, /Reassign 1 open lead/i);

  const allowed = ownedLeadContinuityError(
    salesUser,
    {
      permissions: {
        view_assigned_leads: false,
        view_all_leads: true,
        reply_to_assigned_leads: true,
      },
    },
    1
  );
  assert.equal(allowed, null);
});

test("removing reply access from an owner with open leads requires reassignment", () => {
  const error = ownedLeadContinuityError(
    salesUser,
    { permissions: { reply_to_assigned_leads: false } },
    4
  );
  assert.match(error, /Reassign 4 open leads/i);
});

test("promoting an active owner to Admin keeps access through Admin defaults", () => {
  assert.equal(
    ownedLeadContinuityError(salesUser, { role: "admin", permissions: {} }, 2),
    null
  );
});

test("staff mutation and automatic assignment use compatible row locks", () => {
  const usersRepo = fs.readFileSync(
    path.join(__dirname, "../src/db/usersRepo.js"),
    "utf8"
  );
  const auth = fs.readFileSync(
    path.join(__dirname, "../src/routes/auth.js"),
    "utf8"
  );
  const schema = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(usersRepo, /SELECT \* FROM users WHERE id = \$1 FOR UPDATE/);
  assert.match(usersRepo, /WHERE is_closed = false[\s\S]*owner_username = \$1/);
  assert.match(auth, /OPEN_LEADS_REQUIRE_REASSIGNMENT/);
  assert.match(auth, /countOpenOwnedLeads/);
  assert.match(schema, /LIMIT 1\s+FOR SHARE;/i);
  assert.doesNotMatch(schema, /FOR KEY SHARE/i);
});
