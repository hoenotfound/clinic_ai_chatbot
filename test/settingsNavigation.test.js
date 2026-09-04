const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("main sidebar keeps Team Access and Setup Status nested under Settings", () => {
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");

  assert.match(sidebar, /label: "Settings"/);
  assert.match(sidebar, /capabilities: \["manage_settings", "manage_users"\]/);
  assert.match(sidebar, /adminAlso: true/);
  assert.doesNotMatch(sidebar, /label: "Team & Access"/);
  assert.doesNotMatch(sidebar, /label: "Setup Status"/);
});

test("configuration sidebar contains Team Access and Setup Status alongside config sections", () => {
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(settings, /aria-label="Settings sections"/);
  assert.match(settings, /Administration/);
  assert.match(settings, /label: "Team & Access", to: "\/settings\/team"/);
  assert.match(settings, /label: "Setup Status", to: "\/settings\/setup"/);
  assert.match(settings, /permissions\.manage_users/);
  assert.match(settings, /user\?\.role === "admin"/);
  assert.match(settings, /useSearchParams/);
  assert.match(settings, /setSearchParams\(\{ tab: id \}/);
});

test("nested Settings pages reuse the same configuration sidebar structure", () => {
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");

  assert.match(settingsLayout, /const CONFIG_ITEMS = \[/);
  assert.match(settingsLayout, /General/);
  assert.match(settingsLayout, /Handoff & Rules/);
  assert.match(settingsLayout, /Administration/);
  assert.match(settingsLayout, /Team & Access/);
  assert.match(settingsLayout, /Setup Status/);
  assert.match(settingsLayout, /\/settings\?tab=/);
  assert.match(settingsLayout, /aria-label="Settings sections"/);
});

test("Settings child routes retain access controls and legacy setup URL", () => {
  const app = read("portal-frontend/src/App.jsx");

  assert.match(app, /path="\/settings" element=\{<ProtectedRoute anyCapabilities=\{\["manage_settings"\]\}><Settings \/><\/ProtectedRoute>\}/);
  assert.match(app, /path="\/settings\/team"[\s\S]*anyCapabilities=\{\["manage_users"\]\}/);
  assert.match(app, /SettingsSectionLayout><TeamAccess \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/settings\/setup"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(app, /SettingsSectionLayout><SetupStatus \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/setup" element=\{<Navigate to="\/settings\/setup" replace \/>\}/);
});
