const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Team Access uses a compact searchable staff directory instead of stacked account editors", () => {
  const page = read("portal-frontend/src/pages/TeamAccess.jsx");

  assert.match(page, /const \[query, setQuery\] = useState\(""\)/);
  assert.match(page, /const \[roleFilter, setRoleFilter\] = useState\("all"\)/);
  assert.match(page, /const \[statusFilter, setStatusFilter\] = useState\("active"\)/);
  assert.match(page, /Search staff by name, username or branch/);
  assert.match(page, /function StaffDirectoryRow/);
  assert.match(page, /function StaffEditorModal/);
  assert.match(page, /function CreateStaffModal/);
  assert.match(page, /setSelectedStaffId\(staff\.id\)/);
  assert.match(page, /min-h-0 flex-1 overflow-y-auto/);
  assert.doesNotMatch(page, /function StaffCard/);
  assert.doesNotMatch(page, /function CreateStaffCard/);
});

test("Team Access keeps all existing staff mutations behind the focused editor", () => {
  const page = read("portal-frontend/src/pages/TeamAccess.jsx");

  assert.match(page, /teamApi\.createUser\(form\)/);
  assert.match(page, /teamApi\.updateUser\(staff\.id, updates\)/);
  assert.match(page, /teamApi\.removeUser\(staff\.id\)/);
  assert.match(page, /changeRole/);
  assert.match(page, /togglePermission/);
  assert.match(page, /saveProfile/);
  assert.match(page, /isCurrent/);
  assert.match(page, /staleBranch/);
  assert.match(page, /role="switch"/);
});
