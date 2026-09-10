const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  getOnboardingIndustryProfile,
} = require("../src/config/onboardingIndustryProfiles");
const {
  getIndustryProfile,
} = require("../src/config/industryProfiles");
const {
  createSeedIndustrySetup,
} = require("../src/config/industrySetup");
const {
  evaluateClientSetup,
} = require("../src/services/clientSetupService");

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
    businessDescription: businessType === "aesthetic_clinic"
      ? "Aesthetic clinic serving patients in Kuala Lumpur"
      : "Custom cabinetry and home renovation around Klang Valley",
    aiAssistantName: "Ava",
    introMessage: "Hi, how can I help?",
    industrySetup: {
      selectable: false,
      locked: true,
      source: "environment",
    },
    branches: businessType === "aesthetic_clinic"
      ? [{ name: "KL", address: "Kuala Lumpur", phone: "" }]
      : [],
    serviceAreas: businessType === "home_renovation" ? ["Klang Valley"] : [],
    hours: { general: "Mon-Sat 10am-7pm", closed: "" },
    contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
    services: [{
      name: businessType === "aesthetic_clinic" ? "Pico Laser" : "Kitchen Cabinets",
      description: "",
      priceRange: "",
      duration: "",
    }],
    serviceAliases: [],
    faqs: [],
    promotions: [],
    tone: "Friendly and professional",
    messagingStyle: "Keep replies concise.",
    closingPlaybook: "Qualify the enquiry before suggesting the next step.",
    sop: "Follow the configured business process.",
    escalation: {
      handoffMessage: "A team member will assist you.",
      handoffNote: "",
      outOfScopeTriggers: ["Complaint"],
    },
    guardrails: ["Do not invent prices."],
  };
}

function withSetupStatus(config) {
  return { ...config, clientSetup: evaluateClientSetup(config) };
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
    assert.deepEqual(profile.serviceAreas, []);
    assert.deepEqual(profile.services, []);
    assert.deepEqual(profile.serviceAliases, []);
    assert.deepEqual(profile.faqs, []);
    assert.deepEqual(profile.promotions, []);
    assert.match(profile.hours.general, /not configured yet/i);
  }
});

test("server-side setup evaluation is industry-aware and treats optional sections honestly", () => {
  const renovation = configuredBusiness("home_renovation");
  const renovationStatus = evaluateClientSetup(renovation);
  const renovationLocations = renovationStatus.sections.find((section) => section.id === "locations");
  const renovationFaqs = renovationStatus.sections.find((section) => section.id === "knowledge");
  const renovationPromotions = renovationStatus.sections.find((section) => section.id === "promotions");

  assert.equal(renovationLocations.required, false);
  assert.equal(renovationLocations.configured, true);
  assert.equal(renovationLocations.state, "configured");
  assert.match(renovationLocations.label, /service areas/i);
  assert.equal(renovationFaqs.required, false);
  assert.equal(renovationFaqs.complete, false);
  assert.equal(renovationFaqs.state, "optional");
  assert.equal(renovationPromotions.complete, false);
  assert.equal(renovationStatus.requiredComplete, true);
  assert.equal(renovationStatus.requiredCompletedCount, renovationStatus.requiredTotal);

  const clinic = configuredBusiness("aesthetic_clinic");
  clinic.branches = [];
  const clinicStatus = evaluateClientSetup(clinic);
  const clinicLocations = clinicStatus.sections.find((section) => section.id === "locations");
  assert.equal(clinicLocations.required, true);
  assert.equal(clinicLocations.complete, false);
  assert.equal(clinicLocations.state, "needs_attention");
  assert.equal(clinicStatus.requiredComplete, false);

  const clinicMissingAddress = configuredBusiness("aesthetic_clinic");
  clinicMissingAddress.branches = [{ name: "KL", address: "", phone: "" }];
  const missingAddressStatus = evaluateClientSetup(clinicMissingAddress);
  const missingAddressLocations = missingAddressStatus.sections.find((section) => section.id === "locations");
  assert.equal(missingAddressLocations.complete, false);
  assert.equal(missingAddressLocations.state, "needs_attention");
  assert.match(missingAddressLocations.missing.join(" "), /address/i);
  assert.equal(missingAddressStatus.requiredComplete, false);
});

test("renovation service areas are separate from branches used for routing", () => {
  const renovation = configuredBusiness("home_renovation");
  renovation.branches = [];
  renovation.serviceAreas = ["Klang Valley", "PJ / Subang"];

  const status = evaluateClientSetup(renovation);
  const locations = status.sections.find((section) => section.id === "locations");
  assert.equal(locations.configured, true);
  assert.deepEqual(renovation.branches, []);

  const configRepo = read("src/db/configRepo.js");
  const configRoute = read("src/routes/config.js");
  const leadDistribution = read("src/routes/config.js");
  const systemPrompt = read("src/utils/systemPrompt.js");

  assert.match(configRepo, /"serviceAreas"/);
  assert.match(configRoute, /serviceAreas: \(v\) => Array\.isArray\(v\)/);
  assert.match(leadDistribution, /const configuredBranches = \(config\.branches \|\| \[\]\)/);
  assert.doesNotMatch(leadDistribution, /configuredBranches = \(config\.serviceAreas/);
  assert.match(systemPrompt, /Project service areas \/ coverage/);
});

test("setup evaluation protects only profile guardrails already active for the client", () => {
  const renovation = configuredBusiness("home_renovation");
  const profile = getIndustryProfile("home_renovation");
  const activeBuiltIn = profile.guardrails[0];
  const inactiveBuiltIn = profile.guardrails[1];
  const customRule = "Only serve projects inside Klang Valley.";
  renovation.guardrails = [activeBuiltIn, customRule];

  const status = evaluateClientSetup(renovation);
  assert.deepEqual(status.protectedGuardrails, [activeBuiltIn]);
  assert.equal(status.protectedGuardrails.includes(customRule), false);
  assert.equal(status.protectedGuardrails.includes(inactiveBuiltIn), false);

  const fresh = configuredBusiness("home_renovation");
  fresh.guardrails = [...profile.guardrails];
  assert.deepEqual(evaluateClientSetup(fresh).protectedGuardrails, profile.guardrails);
});

test("frontend completion consumes the authoritative server result", () => {
  const { getClientSetupCompletion } = loadWizardHelper();
  const configured = withSetupStatus(configuredBusiness("home_renovation"));
  const completion = getClientSetupCompletion(configured);

  assert.equal(completion.requiredComplete, true);
  assert.equal(completion.requiredCompletedCount, completion.requiredTotal);
  assert.equal(completion.sections.length, 8);

  const missingServerStatus = getClientSetupCompletion(configuredBusiness("home_renovation"));
  assert.equal(missingServerStatus.requiredComplete, false);
  assert.deepEqual(Array.from(missingServerStatus.sections), []);
});

test("auto-start targets fresh locked and selectable deployments but not established clients", () => {
  const { shouldAutoStartClientSetup } = loadWizardHelper();

  const freshLocked = configuredBusiness("home_renovation");
  freshLocked.businessName = "Your Renovation Business";
  freshLocked.hours.general = "Business hours not configured yet";
  freshLocked.services = [];
  const freshLockedDecorated = withSetupStatus(freshLocked);

  assert.equal(shouldAutoStartClientSetup(freshLockedDecorated, null), true);
  assert.equal(shouldAutoStartClientSetup(freshLockedDecorated, { started: true, dismissed: true }), false);
  assert.equal(shouldAutoStartClientSetup(freshLockedDecorated, { started: true, completed: true }), false);

  const selectableProfile = {
    ...freshLocked,
    businessType: "aesthetic_clinic",
    businessName: "Your Clinic",
    industrySetup: {
      selectable: true,
      locked: false,
      source: "default",
    },
  };
  assert.equal(shouldAutoStartClientSetup(withSetupStatus(selectableProfile), null), true);

  const existing = withSetupStatus(configuredBusiness("home_renovation"));
  assert.equal(shouldAutoStartClientSetup(existing, null), false);

  const legacyPlaceholder = withSetupStatus({
    ...freshLocked,
    industrySetup: { ...freshLocked.industrySetup, source: "legacy" },
  });
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

test("client setup is admin-only, discoverable, and login passes through first-run routing", () => {
  const app = read("portal-frontend/src/App.jsx");
  const login = read("portal-frontend/src/pages/Login.jsx");
  const settingsLayout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(app, /path="\/settings\/client-setup"/);
  assert.match(app, /<ProtectedRoute adminOnly>/);
  assert.match(app, /shouldAutoStartClientSetup/);
  assert.match(app, /setupDecision\.key !== adminDecisionKey/);
  assert.match(login, /<Navigate to="\/" replace \/>/);
  assert.match(settingsLayout, /Client Setup/);
  assert.match(settings, /label: "Client Setup", to: "\/settings\/client-setup"/);
});

test("wizard protects unsaved edits and reuses existing business-profile selector", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");

  assert.match(wizard, /hasUnsavedChanges\(screen, draft, config\)/);
  assert.match(wizard, /window\.confirm\("You have unsaved changes/);
  assert.match(wizard, /setDraft\(cloneConfig\(config\)\)/);
  assert.match(wizard, /api\.selectBusinessProfile\(profileChoice\)/);
  assert.match(wizard, /Confirm business profile/);
  assert.match(wizard, /businessDescription/);
assert.match(wizard, /Confirm the business profile to unlock client-specific business fields/);
assert.equal((wizard.match(/disabled=\{!locked\}/g) || []).length, 4);
});

test("wizard and Settings use separate service areas, stronger field validation, and promo upload", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  for (const source of [wizard, settings]) {
    assert.match(source, /serviceAreas/);
    assert.match(source, /Every FAQ needs both a question and an answer/);
    assert.match(source, /must map to a service/);
    assert.match(source, /cannot be before its start date/);
    assert.match(source, /api\.uploadPromoImage\(file\)/);
  }
  assert.match(wizard, /type=\{field\.type \|\| "text"\}/);
  assert.match(settings, /type=\{f\.type \|\| "text"\}/);
});

test("wizard separates normal health from strict live messaging proof and never messages customers", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");

  assert.match(wizard, /Live messaging proof/);
  assert.match(wizard, /roundTripCorrelated/);
  assert.match(wizard, /lastVerifiedAutomatedReplyAt/);
  assert.match(wizard, /messaging channels were purchased/);
  assert.match(wizard, /does not send a test message to a real customer/);
  assert.match(wizard, /api\.getSetupStatus\(\)/);
  assert.match(wizard, /api\.runSetupChecks\(\)/);
  assert.doesNotMatch(wizard, /api\.(?:sendMessage|sendImage|sendVoice|takeOver|returnToAi)\(/);
});

test("AI behaviour is progressive-disclosure and built-in guardrails are protected", () => {
  const wizard = read("portal-frontend/src/pages/ClientSetupWizard.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(wizard, /Advanced AI instructions/);
  assert.match(wizard, /Built-in safety rules/);
  assert.match(settings, /Built-in industry safety rules/);
  assert.match(settings, /config\.clientSetup\?\.protectedGuardrails/);

  const protectedSourceMatches = wizard.match(
    /setProtectedGuardrails\(cleanStrings\(loaded\.clientSetup\?\.protectedGuardrails \|\| \[\]\)\)/g,
  ) || [];
  assert.equal(protectedSourceMatches.length, 2);
  assert.doesNotMatch(wizard, /setProtectedGuardrails\(cleanStrings\(loaded\.guardrails\)\)/);
});

test("config API decorates reads and writes with server-derived setup status", () => {
  const configRoute = read("src/routes/config.js");
  assert.match(configRoute, /evaluateClientSetup/);
  assert.match(configRoute, /industrySetup:\s*normalizeIndustrySetup\(config\?\.industrySetup\)/);
  assert.match(configRoute, /clientSetup: evaluateClientSetup\(normalizedConfig\)/);
  assert.match(configRoute, /res\.json\(decorateConfig\(configRepo\.getConfig\(\)\)\)/);
  assert.match(configRoute, /res\.json\(decorateConfig\(updated\)\)/);
});
