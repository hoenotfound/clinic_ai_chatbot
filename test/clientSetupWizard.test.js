const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  getOnboardingIndustryProfile,
} = require("../src/config/onboardingIndustryProfiles");
const {
  createSeedIndustrySetup,
} = require("../src/config/industrySetup");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function loadWizardHelper() {
  const source = `${read("portal-frontend/src/utils/clientSetupWizard.js").replace(/^export /gm, "")}
module.exports = {
  getClientSetupCompletion,
  isFreshClientSetupCandidate,
  readClientSetupProgress,
  shouldAutoStartClientSetup,
  writeClientSetupProgress,
};`;
  const context = vm.createContext({ module: { exports: {} }, globalThis: {} });
  vm.runInContext(source, context, { filename: "clientSetupWizard.js" });
  return context.module.exports;
}

function configuredBusiness(businessType = "home_renovation") {
  return {
    businessType,
    businessName: businessType === "aesthetic_clinic" ? "Clinic ABC" : "Acme Cabinets",
    aiAssistantName: "Ava",
    introMessage: "Hi, how can I help?",
    industrySetup: {
      selectable: false,
      locked: true,
      source: "environment",
    },
    branches: businessType === "aesthetic_clinic" ? [{ name: "KL" }] : [],
    hours: { general: "Mon-Sat 10am-7pm" },
    services: [{ name: businessType === "aesthetic_clinic" ? "Pico Laser" : "Kitchen Cabinets" }],
    serviceAliases: [],
    faqs: [],
    promotions: [],
    tone: "Friendly and professional",
    messagingStyle: "Keep replies concise.",
    closingPlaybook: "Qualify the enquiry before suggesting the next step.",
    sop: "Follow the configured business process.",
    escalation: {
      handoffMessage: "A team member will assist you.",
      outOfScopeTriggers: ["Complaint"],
    },
    guardrails: ["Do not invent prices."],
  };
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

test("completion rules are industry-aware and based on real saved configuration", () => {
  const { getClientSetupCompletion } = loadWizardHelper();
  const renovation = configuredBusiness("home_renovation");
  const renovationCompletion = getClientSetupCompletion(renovation);
  const renovationLocations = renovationCompletion.sections.find((section) => section.id === "locations");

  assert.equal(renovationLocations.required, false);
  assert.equal(renovationLocations.complete, true);
  assert.match(renovationLocations.label, /Service areas/);
  assert.equal(renovationCompletion.requiredComplete, true);

  const clinic = configuredBusiness("aesthetic_clinic");
  clinic.branches = [];
  const clinicCompletion = getClientSetupCompletion(clinic);
  const clinicLocations = clinicCompletion.sections.find((section) => section.id === "locations");
  assert.equal(clinicLocations.required, true);
  assert.equal(clinicLocations.complete, false);
  assert.equal(clinicCompletion.requiredComplete, false);
});

test("auto-start only targets fresh setup and respects continue-later dismissal", () => {
  const { shouldAutoStartClientSetup } = loadWizardHelper();
  const fresh = configuredBusiness("home_renovation");
  fresh.businessName = "Your Renovation Business";
  fresh.hours.general = "Business hours not configured yet";
  fresh.services = [];

  assert.equal(shouldAutoStartClientSetup(fresh, null), true);
  assert.equal(shouldAutoStartClientSetup(fresh, { started: true, dismissed: true }), false);
  assert.equal(shouldAutoStartClientSetup(fresh, { started: true, completed: true }), false);

  const existing = configuredBusiness("home_renovation");
  assert.equal(shouldAutoStartClientSetup(existing, null), false);

  const legacyPlaceholder = { ...fresh, industrySetup: { ...fresh.industrySetup, source: "legacy" } };
  assert.equal(shouldAutoStartClientSetup(legacyPlaceholder, null), false);
});

test("resume metadata survives normal storage and fails open when browser storage is unavailable", () => {
  const { readClientSetupProgress, writeClientSetupProgress } = loadWizardHelper();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };

  const saved = writeClientSetupProgress("admin", "generic", {
    lastScreen: "offerings",
    dismissed: true,
  }, storage);
  const loaded = readClientSetupProgress("admin", "generic", storage);

  assert.equal(saved.lastScreen, "offerings");
  assert.equal(loaded.dismissed, true);
  assert.equal(loaded.lastScreen, "offerings");

  const blockedStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => writeClientSetupProgress("admin", "generic", { lastScreen: "business" }, blockedStorage));
  assert.equal(readClientSetupProgress("admin", "generic", blockedStorage), null);
});

test("client setup is admin-only and successful login passes through first-run routing", () => {
  const app = read("portal-frontend/src/App.jsx");
  const login = read("portal-frontend/src/pages/Login.jsx");
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");

  assert.match(app, /path="\/settings\/client-setup"/);
  assert.match(app, /<ProtectedRoute adminOnly>/);
  assert.match(app, /shouldAutoStartClientSetup/);
  assert.match(app, /setupDecision\.key !== adminDecisionKey/);
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
  assert.match(wizard, /measurements, budget, timeline/);
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
