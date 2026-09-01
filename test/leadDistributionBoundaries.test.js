const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("manual owner choices and database writes use serviceable staff only", () => {
  const usersRepo = read("src/db/usersRepo.js");
  const pipelineRoute = read("src/routes/pipeline.js");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");

  assert.match(usersRepo, /async function listAssignableLeadOwners/);
  assert.match(usersRepo, /effectivePermissions\(user\)/);
  assert.match(usersRepo, /permissions\.reply_to_assigned_leads === true/);
  assert.match(pipelineRoute, /usersRepo\.listAssignableLeadOwners\(\)/);
  assert.match(safetySchema, /validate_lead_owner_eligibility/);
  assert.match(safetySchema, /FOR SHARE/);
  assert.match(safetySchema, /cannot currently view and reply to assigned leads/);
});

test("new and edited lead branch options are separated from historical branch filters", () => {
  const pipelineRoute = read("src/routes/pipeline.js");
  const requireAuth = read("src/middleware/requireAuth.js");
  const api = read("portal-frontend/src/api.js");
  const addLead = read("portal-frontend/src/components/pipeline/AddLeadModal.jsx");
  const leadDrawer = read("portal-frontend/src/components/pipeline/LeadDrawer.jsx");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");

  assert.match(pipelineRoute, /router\.get\("\/configured-branches"/);
  assert.match(pipelineRoute, /branches: distinctNames\(\[\.\.\.configuredBranches, \.\.\.savedBranches\]\)/);
  assert.match(requireAuth, /parts\[0\] === "configured-branches"/);
  assert.match(requireAuth, /Pipeline access is disabled for this account/);
  assert.match(api, /getConfiguredBranches: \(\) => request\("\/pipeline\/configured-branches"\)/);
  assert.match(addLead, /api\.getConfiguredBranches\(\)/);
  assert.doesNotMatch(addLead, /api\.getPipeline\(\)/);
  assert.match(addLead, /You can still add an unassigned lead/);
  assert.match(leadDrawer, /api\.getConfiguredBranches\(\)/);
  assert.match(leadDrawer, /no longer configured/);
  assert.match(leadDrawer, /historical branch data/i);
  assert.match(safetySchema, /validate_current_lead_branch/);
  assert.match(safetySchema, /no longer configured/);
});

test("Inbox refresh signals are emitted only when lead visibility can change", () => {
  const realtimeEvents = read("src/utils/realtimeEvents.js");
  const pipelineRepo = read("src/db/pipelineRepo.js");
  const recoveryRepo = read("src/db/leadDistributionRepo.js");

  assert.doesNotMatch(realtimeEvents, /if \(event === "pipeline_changed"\)/);
  assert.match(pipelineRepo, /refreshInbox = false/);
  assert.match(pipelineRepo, /reason: "lead_assignment_changed"/);
  assert.match(pipelineRepo, /refreshInbox: outcome\.created && Boolean\(outcome\.lead\.owner_username\)/);
  assert.match(pipelineRepo, /refreshInbox: Object\.hasOwn\(patch, "ownerUsername"\)/);
  assert.match(recoveryRepo, /reason: "lead_assignment_recovered"/);
});

test("lead distribution mutations require both Tools and Assign leads permissions", () => {
  const requireAuth = read("src/middleware/requireAuth.js");
  assert.match(requireAuth, /const canAssign = hasCapability\(user, "manage_lead_assignment"\)/);
  assert.match(requireAuth, /changesLeadDistribution && \(!canTools \|\| !canAssign\)/);
  assert.match(requireAuth, /Changing lead distribution requires both Manage automation tools and Assign leads permissions/);
  assert.match(requireAuth, /req\.method !== "GET" && !canAssign/);
});

test("Lead Distribution is selected from inside Tools rather than the main sidebar", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(app, /import Tools from "\.\/pages\/Tools"/);
  assert.doesNotMatch(app, /ToolsWithNavigation/);
  assert.match(app, /to="\/tools\?tool=lead-distribution"/);
  assert.doesNotMatch(sidebar, /label: "Lead Distribution"/);
  assert.match(tools, /useSearchParams/);
  assert.match(tools, /value === "lead-distribution"/);
  assert.match(tools, /onSelect\("leadDistribution"\)/);
  assert.match(tools, /Automatic Lead Distribution/);
  assert.match(tools, /<LeadDistribution/);
  assert.match(tools, /distributionActive/);
});

test("Lead Distribution UI exposes a simple branch/global choice and view-only state", () => {
  const page = read("portal-frontend/src/pages/LeadDistribution.jsx");
  assert.match(page, /assignByBranch: true/);
  assert.match(page, /How should leads be shared\?/);
  assert.match(page, /By branch/);
  assert.match(page, /Across all Sales staff/);
  assert.match(page, /The branch is still recorded for CRM, reporting and appointments/);
  assert.match(page, /canManageDistribution/);
  assert.match(page, /View only/);
  assert.match(page, /View team & branch pools/);
  assert.match(page, /How it works & advanced behavior/);
  assert.doesNotMatch(page, /Back to Tools/);
});

test("Tools UX keeps advanced details out of the main setup flow", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /Review translations/);
  assert.match(tools, /Language versions will refresh automatically when you save/);
  assert.match(tools, /api\.translateFollowUp\(message\)/);
  assert.match(tools, /Advanced timing settings/);
  assert.match(tools, /Booking intent → Hot/);
  assert.match(tools, /Clear rejection → Cold/);
  assert.match(tools, /Staff changes always win/);
  assert.match(tools, /You have unsaved changes in this tool\. Leave without saving them\?/);
  assert.doesNotMatch(tools, /function OverviewItem/);
});

test("leaving a dirty tool discards its local draft consistently", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /function discardCurrentToolChanges\(\)/);
  assert.match(tools, /setForm\(saved\)/);
  assert.match(tools, /setScoringForm\(scoringFormFromSettings\(config\?\.leadScoring\)\)/);
  assert.match(tools, /discardCurrentToolChanges\(\)/);
  assert.match(tools, /setDistributionDirty\(false\)/);
});

test("automatic translation refresh preserves manual language edits made after the latest source change", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /manualTranslationEdits/);
  assert.match(tools, /setManualTranslationEdits\(\[\]\)/);
  assert.match(tools, /manualTranslationEdits\.includes\(key\)/);
  assert.match(tools, /preserveManual \? manualValue : generated\[key\]/);
  assert.match(tools, /onTranslationChange\(translationLanguage, event\.target\.value\)/);
  assert.match(tools, /enabledStateChanged = enabled !== savedEnabled/);
});

test("production schema loads ownership/branch safeguards and initial assignment audit", () => {
  const db = read("src/db/db.js");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");
  assert.match(db, /leadDistributionSafetySchema\.sql/);
  assert.match(db, /await pool\.query\(leadDistributionSafetySchema\)/);
  assert.match(safetySchema, /lead_distribution_initial/);
  assert.match(safetySchema, /Automatically assigned to %s when the lead was created/);
  assert.match(safetySchema, /choose_lead_distribution_owner/);
  assert.match(safetySchema, /leadDistribution,assignByBranch/);
});