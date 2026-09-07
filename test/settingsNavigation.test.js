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

test("configuration sidebar keeps grouped navigation and uses industry-aware labels", () => {
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(settings, /aria-label="Settings sections"/);
  assert.match(settings, /Administration/);
  assert.match(settings, /System/);
  assert.match(settings, /label: "Team & Access", to: "\/settings\/team"/);
  assert.match(settings, /label: "Setup Status", to: "\/settings\/setup"/);
  assert.match(settings, /permissions\.manage_users/);
  assert.match(settings, /user\?\.role === "admin"/);
  assert.match(settings, /getBusinessTerminology/);
  assert.match(settings, /getSettingsTabs/);
  assert.match(settings, /label=\{ui\.businessAndAiLabel\}/);
  assert.match(settings, /tabs\.map/);
  assert.match(settings, /useSearchParams/);
  assert.match(settings, /setSearchParams\(\{ tab: id \}/);
});

test("nested Settings pages reuse the same industry-aware grouped sidebar structure", () => {
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");

  assert.match(settingsLayout, /useBusinessConfig/);
  assert.match(settingsLayout, /getBusinessTerminology/);
  assert.match(settingsLayout, /getSettingsTabs/);
  assert.match(settingsLayout, /Administration/);
  assert.match(settingsLayout, /System/);
  assert.match(settingsLayout, /Team & Access/);
  assert.match(settingsLayout, /Setup Status/);
  assert.match(settingsLayout, /\/settings\?tab=/);
  assert.match(settingsLayout, /aria-label="Settings sections"/);
  assert.match(settingsLayout, /Bot & \{ui\.businessNoun\} configuration/);
});

test("authenticated portal routes provide the current business profile", () => {
  const app = read("portal-frontend/src/App.jsx");

  assert.match(app, /BusinessConfigProvider/);
  assert.match(app, /<BusinessConfigProvider>[\s\S]*<Layout>\{children\}<\/Layout>[\s\S]*<\/BusinessConfigProvider>/);
  assert.match(app, /path="\/settings" element=\{<ProtectedRoute anyCapabilities=\{\["manage_settings"\]\}><Settings \/><\/ProtectedRoute>\}/);
  assert.match(app, /path="\/settings\/team"[\s\S]*anyCapabilities=\{\["manage_users"\]\}/);
  assert.match(app, /SettingsSectionLayout><TeamAccess \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/settings\/setup"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(app, /SettingsSectionLayout><SetupStatus \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/setup" element=\{<Navigate to="\/settings\/setup" replace \/>\}/);
});
