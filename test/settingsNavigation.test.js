const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("main sidebar collapses Team Access and Setup Status into Settings", () => {
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");

  assert.match(sidebar, /label: "Settings"/);
  assert.match(sidebar, /capabilities: \["manage_settings", "manage_users"\]/);
  assert.match(sidebar, /adminAlso: true/);
  assert.doesNotMatch(sidebar, /label: "Team & Access"/);
  assert.doesNotMatch(sidebar, /label: "Setup Status"/);
});

test("Settings section navigation exposes permission-aware destinations", () => {
  const settingsNav = read("portal-frontend/src/components/SettingsSectionLayout.jsx");

  assert.match(settingsNav, /permissions\.manage_settings/);
  assert.match(settingsNav, /to: "\/settings"/);
  assert.match(settingsNav, /permissions\.manage_users/);
  assert.match(settingsNav, /to: "\/settings\/team"/);
  assert.match(settingsNav, /user\?\.role === "admin"/);
  assert.match(settingsNav, /to: "\/settings\/setup"/);
  assert.match(settingsNav, /aria-label="Settings sections"/);
});

test("Settings child routes retain their existing access controls and legacy setup URL", () => {
  const app = read("portal-frontend/src/App.jsx");

  assert.match(app, /path="\/settings\/team"[\s\S]*anyCapabilities=\{\["manage_users"\]\}/);
  assert.match(app, /path="\/settings\/setup"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(app, /path="\/setup" element=\{<Navigate to="\/settings\/setup" replace \/>\}/);
  assert.match(app, /SettingsSectionLayout><TeamAccess \/><\/SettingsSectionLayout>/);
  assert.match(app, /SettingsSectionLayout><SetupStatus \/><\/SettingsSectionLayout>/);
});
