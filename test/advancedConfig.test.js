const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  prepareConfigUpdatePayload,
} = require("../src/routes/config");
const {
  EDITABLE_KEYS,
  buildConfigDiff,
  configFingerprint,
  editableConfigView,
  prepareAdvancedConfigPayload,
} = require("../src/routes/advancedConfig");
const {
  MAX_CONFIG_IMPORT_SNAPSHOTS,
  pruneOldSnapshots,
} = require("../src/db/configImportHistoryRepo");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function currentConfig() {
  return {
    businessName: "Test Clinic",
    clinicName: "Test Clinic",
    businessDescription: "Clinic description",
    aiAssistantName: "Ava",
    introMessage: "Hello",
    tone: "Warm",
    messagingStyle: "Short replies",
    closingPlaybook: "Guide naturally",
    sop: "Follow SOP",
    hours: { general: "Mon-Fri", closed: "Sun" },
    contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
    branches: [{ name: "HQ", address: "KL", phone: "" }],
    serviceAreas: [],
    promotions: [],
    services: [{ name: "Consultation", description: "", priceRange: "", duration: "" }],
    serviceAliases: [],
    faqs: [],
    escalation: { outOfScopeTriggers: ["Complaint"], handoffMessage: "Staff will help.", handoffNote: "" },
    guardrails: ["Do not invent facts."],
    automatedFollowUp: {
      enabled: false,
      delayMinutes: 10,
      triggerMode: "all",
      message: "Following up",
      translations: { en: "Following up", ms: "Following up", zh: "Following up" },
      imageUrl: "",
      activatedAt: null,
    },
    commentAutomation: {
      enabled: false,
      facebookEnabled: false,
      instagramEnabled: false,
      publicReplyEnabled: false,
      privateReplyEnabled: false,
      publicReplyStyle: "ai",
      fixedPublicReply: "",
      skipEmojiOnly: true,
      skipNestedReplies: true,
      activatedAt: null,
    },
    leadScoring: {
      enabled: false,
      inactivityMinutes: 10,
      maxConversationMinutes: 60,
      maxMessages: 40,
      activatedAt: null,
    },
    leadDistribution: {
      enabled: false,
      strategy: "round_robin",
      assignByBranch: true,
    },
    businessType: "aesthetic_clinic",
    industrySetup: { locked: true },
    clientSetup: { requiredComplete: true },
  };
}

test("shared config preparation accepts partial editable JSON and rejects internal keys", () => {
  const current = currentConfig();

  const partial = prepareConfigUpdatePayload(
    { tone: "Short and friendly", faqs: [{ q: "Price?", a: "Ask us for the latest price." }] },
    current
  );
  assert.equal(partial.ok, true);
  assert.equal(partial.updates.tone, "Short and friendly");
  assert.deepEqual(partial.updates.faqs, [{ q: "Price?", a: "Ask us for the latest price." }]);

  const internal = prepareConfigUpdatePayload(
    { businessType: "tcm_clinic", industrySetup: { locked: false } },
    current
  );
  assert.equal(internal.ok, false);
  assert.deepEqual(internal.unknownKeys, ["businessType", "industrySetup"]);
});

test("Advanced Config exposes business and AI content only", () => {
  const current = currentConfig();
  const editable = editableConfigView(current);

  assert.equal(editable.businessName, "Test Clinic");
  for (const excludedKey of [
    "clinicName",
    "businessType",
    "industrySetup",
    "clientSetup",
    "automatedFollowUp",
    "commentAutomation",
    "leadScoring",
    "leadDistribution",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(editable, excludedKey),
      false,
      `${excludedKey} must stay out of Advanced Config`
    );
    assert.equal(EDITABLE_KEYS.includes(excludedKey), false);
  }

  const changes = buildConfigDiff(current, { businessName: "New Clinic" });
  assert.deepEqual(changes.map((change) => change.key), ["businessName"]);

  for (const excludedKey of [
    "automatedFollowUp",
    "commentAutomation",
    "leadScoring",
    "leadDistribution",
    "clinicName",
  ]) {
    const rejected = prepareAdvancedConfigPayload(
      { [excludedKey]: excludedKey === "clinicName" ? "Legacy Name" : current[excludedKey] },
      current
    );
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.unknownKeys, [excludedKey]);
  }
});

test("Advanced Config fingerprint is stable for equivalent nested object key order", () => {
  const left = currentConfig();
  const right = currentConfig();
  left.hours = { general: "Mon-Fri", closed: "Sun" };
  right.hours = { closed: "Sun", general: "Mon-Fri" };

  assert.equal(configFingerprint(left), configFingerprint(right));
});

test("Advanced Config snapshot retention keeps at most 50 newest backups", async () => {
  assert.equal(MAX_CONFIG_IMPORT_SNAPSHOTS, 50);
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await pruneOldSnapshots(database);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM config_import_snapshots/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(calls[0].sql, /OFFSET \$1/);
  assert.deepEqual(calls[0].params, [50]);

  const repo = read("src/db/configImportHistoryRepo.js");
  assert.match(repo, /await client\.query\("BEGIN"\)/);
  assert.match(repo, /await pruneOldSnapshots\(client\)/);
  assert.match(repo, /await client\.query\("COMMIT"\)/);
});

test("Advanced Config is admin-only, snapshots imports, and rejects stale previews", () => {
  const route = read("src/routes/advancedConfig.js");
  const migration = read("src/db/migrations/026_config_import_snapshots.sql");
  const createApp = read("src/createApp.js");

  assert.match(route, /router\.use\(requireAdministrator\)/);
  assert.match(route, /req\.user\?\.role !== "admin"/);
  assert.match(route, /CONFIG_PREVIEW_STALE/);
  assert.match(route, /reason: "before_json_import"/);
  assert.match(route, /reason: "before_restore"/);
  assert.match(route, /configImportHistoryRepo\.createSnapshot/);
  assert.match(route, /configRepo\.updateConfig\(prepared\.updates\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS config_import_snapshots/);
  assert.match(createApp, /app\.use\("\/api\/advanced-config", requireAuth, advancedConfigRoutes\)/);
  assert.match(createApp, /createAdvancedConfigJsonParser/);
  assert.match(createApp, /req\.path === "\/advanced-config"/);
  assert.match(createApp, /req\.path\.startsWith\("\/advanced-config\/"\)/);
});

test("Advanced Config portal route stays admin-only and exposes validate, apply, and restore APIs", () => {
  const app = read("portal-frontend/src/App.jsx");
  const page = read("portal-frontend/src/pages/AdvancedConfig.jsx");
  const api = read("portal-frontend/src/api.js");
  const layout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(app, /path="\/settings\/advanced-config"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(layout, /label: "Advanced Config"/);
  assert.match(settings, /label: "Advanced Config", to: "\/settings\/advanced-config"/);
  assert.match(page, /Partial JSON is supported/);
  assert.match(page, /Validate & review/);
  assert.match(page, /Import history/);
  assert.match(page, /Automation Tools settings are intentionally excluded/);
  assert.match(page, /Up to 50 snapshots are retained/);
  assert.match(page, /refreshUser/);
  assert.match(api, /getAdvancedConfig/);
  assert.match(api, /previewAdvancedConfig/);
  assert.match(api, /applyAdvancedConfig/);
  assert.match(api, /restoreAdvancedConfig/);
});
