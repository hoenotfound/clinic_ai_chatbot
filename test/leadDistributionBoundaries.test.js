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

test("new lead branch options are separated from historical branch filters", () => {
  const pipelineRoute = read("src/routes/pipeline.js");
  const addLead = read("portal-frontend/src/components/pipeline/AddLeadModal.jsx");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");

  assert.match(pipelineRoute, /configuredBranches,/);
  assert.match(pipelineRoute, /branches: distinctNames\(\[\.\.\.configuredBranches, \.\.\.savedBranches\]\)/);
  assert.match(addLead, /pipelineData\?\.configuredBranches/);
  assert.match(addLead, /Only branches that currently exist in Clinic Settings/);
  assert.match(safetySchema, /validate_current_lead_branch/);
  assert.match(safetySchema, /no longer configured/);
});

test("Pipeline changes wake the Inbox so new ownership appears immediately", () => {
  const realtimeEvents = read("src/utils/realtimeEvents.js");
  assert.match(realtimeEvents, /if \(event === "pipeline_changed"\)/);
  assert.match(
    realtimeEvents,
    /writeEvent\(client, "conversation_changed", \{ reason: "pipeline_changed" \}\)/
  );
});

test("lead distribution mutations require both Tools and Assign leads permissions", () => {
  const requireAuth = read("src/middleware/requireAuth.js");
  assert.match(requireAuth, /const canAssign = hasCapability\(user, "manage_lead_assignment"\)/);
  assert.match(requireAuth, /changesLeadDistribution && \(!canTools \|\| !canAssign\)/);
  assert.match(requireAuth, /Changing lead distribution requires both Manage automation tools and Assign leads permissions/);
  assert.match(requireAuth, /req\.method !== "GET" && !canAssign/);
});

test("Lead Distribution is discoverable from within the Tools page", () => {
  const app = read("portal-frontend/src/App.jsx");
  const wrapper = read("portal-frontend/src/pages/ToolsWithNavigation.jsx");
  assert.match(app, /ToolsWithNavigation/);
  assert.match(wrapper, /to="\/tools\/lead-distribution"/);
  assert.match(wrapper, /Automatic Lead Distribution/);
});

test("Lead Distribution UI exposes a clear branch routing choice and view-only state", () => {
  const page = read("portal-frontend/src/pages/LeadDistribution.jsx");
  assert.match(page, /assignByBranch: true/);
  assert.match(page, /Assign leads by branch/);
  assert.match(page, /Global only/);
  assert.match(page, /The branch is still recorded for CRM, reporting and appointments/);
  assert.match(page, /canManageDistribution/);
  assert.match(page, /View only/);
  assert.match(page, /Advanced behavior & safeguards/);
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
