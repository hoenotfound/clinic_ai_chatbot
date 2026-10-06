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

test("authenticated portal shell provides one shared business profile without refetching full settings", () => {
  const app = read("portal-frontend/src/App.jsx");
  const businessConfig = read("portal-frontend/src/context/BusinessConfigContext.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(app, /<AuthProvider>\s*<BusinessConfigProvider>\s*<Routes>/);
  assert.match(app, /return <Layout>\{children\}<\/Layout>;/);
  assert.match(businessConfig, /useAuth/);
  assert.match(businessConfig, /user\?\.businessProfile/);
  assert.doesNotMatch(businessConfig, /api\.getConfig/);
  assert.match(settings, /api\s*\.getConfig\(\)/);
  assert.match(app, /path="\/settings" element=\{<ProtectedRoute anyCapabilities=\{\["manage_settings"\]\}><Settings \/><\/ProtectedRoute>\}/);
  assert.match(app, /path="\/settings\/team"[\s\S]*anyCapabilities=\{\["manage_users"\]\}/);
  assert.match(app, /SettingsSectionLayout><TeamAccess \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/settings\/setup"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(app, /SettingsSectionLayout><SetupStatus \/><\/SettingsSectionLayout>/);
  assert.match(app, /path="\/setup" element=\{<Navigate to="\/settings\/setup" replace \/>\}/);
});


test("notifications are reachable by every authenticated staff account", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const notifications = read("portal-frontend/src/pages/Notifications.jsx");
  const pushUtils = read("portal-frontend/src/utils/pushNotifications.js");

  assert.match(app, /path="\/notifications" element=\{<ProtectedRoute><Notifications \/><\/ProtectedRoute>\}/);
  assert.match(sidebar, /to: "\/notifications"/);
  assert.match(sidebar, /label: "Notifications"/);
  assert.match(notifications, /Normal new customer messages are intentionally excluded/);
  assert.match(notifications, /Send test notification/);
  assert.match(notifications, /Android \/ HONOR notification reliability/);
  assert.match(notifications, /HONOR MagicOS can be especially aggressive/);
  assert.match(notifications, /Auto-launch, Secondary launch, and Run in background/);
  assert.match(pushUtils, /export function isIosDevice/);
  assert.match(notifications, /ios && !standalone && state\.supported/);
});
