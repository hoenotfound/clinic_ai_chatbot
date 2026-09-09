const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  getOnboardingIndustryProfile,
} = require("../src/config/onboardingIndustryProfiles");
const {
  createSeedIndustrySetup,
} = require("../src/config/industrySetup");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("fresh explicit industry provisioning is locked before client Settings are edited", () => {
  const setup = createSeedIndustrySetup({
    INITIAL_BUSINESS_TYPE: "home_renovation",
  }, new Date("2026-09-09T01:00:00.000Z"));

  assert.equal(setup.selectable, false);
  assert.equal(setup.locked, true);
  assert.equal(setup.source, "environment");
  assert.equal(setup.lockReason, "environment_selected");
});

test("fresh onboarding profiles keep customer-specific setup fields visibly incomplete", () => {
  const cases = [
    ["aesthetic_clinic", "Your Clinic"],
    ["home_renovation", "Your Renovation Business"],
    ["generic", "Your Business"],
  ];

  for (const [businessType, placeholderName] of cases) {
    const profile = getOnboardingIndustryProfile(businessType);
    assert.equal(profile.businessType, businessType);
    assert.equal(profile.businessName, placeholderName);
    assert.deepEqual(profile.branches, []);
    assert.deepEqual(profile.services, []);
    assert.deepEqual(profile.serviceAliases, []);
    assert.deepEqual(profile.faqs, []);
    assert.deepEqual(profile.promotions, []);
    assert.match(profile.hours.general, /not configured yet/i);
  }
});

test("client setup is admin-only and successful login passes through first-run routing", () => {
  const app = read("portal-frontend/src/App.jsx");
  const login = read("portal-frontend/src/pages/Login.jsx");
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");

  assert.match(app, /path="\/settings\/client-setup"/);
  assert.match(app, /<ProtectedRoute adminOnly>/);
  assert.match(app, /shouldAutoStartClientSetup/);
  assert.match(app, /readClientSetupProgress/);
  assert.match(login, /<Navigate to="\/" replace \/>/);
  assert.match(settingsLayout, /Client Setup/);
  assert.match(settingsLayout, /\/settings\/client-setup/);
  assert.match(settingsLayout, /user\?\.role === "admin"/);
});

test("wizard reuses live Settings config and existing Setup Status without customer messaging", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");
  const helper = read("portal-frontend/src/utils/clientSetupWizard.js");

  assert.match(wizard, /api\.getConfig\(\)/);
  assert.match(wizard, /api\.updateConfig\(payload\)/);
  assert.match(wizard, /api\.getSetupStatus\(\)/);
  assert.match(wizard, /api\.runSetupChecks\(\)/);
  assert.match(wizard, /Saved changes appear in Settings immediately/);
  assert.doesNotMatch(wizard, /api\.(?:sendMessage|sendImage|sendVoice|takeOver|returnToAi)\(/);

  assert.match(helper, /getClientSetupCompletion/);
  assert.match(helper, /requiredComplete/);
  assert.match(helper, /localStorage/);
  assert.match(helper, /dismissed/);
  assert.match(helper, /completed/);
  assert.match(helper, /required: false/);
  assert.doesNotMatch(helper, /fetch\(|\/api\/|api\./);
});

test("wizard completion is derived from saved configuration rather than click-through state", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");
  const helper = read("portal-frontend/src/utils/clientSetupWizard.js");

  assert.match(wizard, /getClientSetupCompletion\(config \|\| \{\}\)/);
  assert.match(wizard, /setConfig\(updated\)/);
  assert.match(helper, /sections\.filter\(\(section\) => section\.complete\)/);
  assert.match(helper, /sections\.filter\(\(section\) => section\.required && !section\.complete\)/);
  assert.match(helper, /isPlaceholderBusinessName/);
  assert.match(helper, /not configured yet/i);
});
