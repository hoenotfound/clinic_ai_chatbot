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
  assert.match(sidebar, /const settingsNavItem = permissions\.manage_settings/);
  assert.match(sidebar, /to: "\/settings\/notifications"/);
  assert.match(sidebar, /item=\{settingsNavItem\}/);
  assert.doesNotMatch(sidebar, /label: "Team & Access"/);
  assert.doesNotMatch(sidebar, /label: "Setup Status"/);
});

test("configuration sidebar keeps grouped navigation and uses industry-aware labels", () => {
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(settings, /aria-label="Settings sections"/);
  assert.match(settings, /Administration/);
  assert.match(settings, /System/);
  assert.match(settings, /label: "Team & Access", to: "\/settings\/team"/);
  assert.match(settings, /label: "Notifications", to: "\/settings\/notifications"/);
  assert.match(settings, /Preferences/);
  assert.match(settings, /<option value=\{notificationsItem\.id\}>/);
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
  assert.match(settingsLayout, /Preferences/);
  assert.match(settingsLayout, /<SettingsNavLink item=\{notificationsItem\} \/>/);
  assert.match(settingsLayout, /isNotifications/);
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

  assert.match(app, /path="\/notifications" element=\{<Navigate to="\/settings\/notifications" replace \/>\}/);
  assert.match(app, /path="\/settings\/notifications"[\s\S]*?<ProtectedRoute>[\s\S]*?<SettingsSectionLayout><Notifications \/><\/SettingsSectionLayout>/);
  assert.doesNotMatch(sidebar, /to: "\/notifications"/);
  assert.doesNotMatch(sidebar, /label: "Notifications"/);
  const settings = read("portal-frontend/src/pages/Settings.jsx");
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const fallback = read("src/utils/portalFallbackGuard.js");
  assert.match(settings, /to: "\/settings\/notifications"/);
  assert.match(settingsLayout, /to: "\/settings\/notifications"/);
  assert.match(fallback, /"\/settings\/notifications"/);
  assert.match(notifications, /Normal new customer messages are intentionally excluded/);
  assert.match(notifications, /Send test notification/);
  assert.match(notifications, /Android \/ HONOR notification reliability/);
  assert.match(notifications, /HONOR MagicOS can be especially aggressive/);
  assert.match(notifications, /Auto-launch, Secondary launch, and Run in background/);
  assert.match(pushUtils, /export function isIosDevice/);
  assert.match(notifications, /ios && !standalone && state\.supported/);
});

test("primary sidebar icons are unique and describe each destination", () => {
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const navItems = [...sidebar.matchAll(/\{ to: "\/[^"]+", label: "([^"]+)", icon: (\w+)/g)]
    .map((match) => ({ label: match[1], icon: match[2] }));
  const byLabel = Object.fromEntries(navItems.map(({ label, icon }) => [label, icon]));

  assert.deepEqual(Object.keys(byLabel), [
    "Inbox", "Contacts", "Pipeline", "Sales Follow-up", "Analytics", "Tools", "Promo Blast"
  ]);
  assert.equal(new Set(navItems.map((item) => item.icon)).size, navItems.length);
  assert.equal(byLabel["Sales Follow-up"], "FollowUpIcon");
  assert.equal(byLabel["Promo Blast"], "PromoBlastIcon");
  assert.match(sidebar, /function FollowUpIcon/);
  assert.match(sidebar, /function PromoBlastIcon/);
  assert.doesNotMatch(sidebar, /function BellIcon/);
  assert.match(sidebar, /const settingsNavItem = permissions\.manage_settings[\s\S]*?\/settings\/notifications/);
});
