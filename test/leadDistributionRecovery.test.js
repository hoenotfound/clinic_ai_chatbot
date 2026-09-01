const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("recovery only targets never-owned open leads", () => {
  const sql = source("src/db/accessControlSchema.sql");
  assert.match(sql, /CREATE OR REPLACE FUNCTION recover_unassigned_open_leads/i);
  assert.match(
    sql,
    /WHERE is_closed = false[\s\S]*owner_username IS NULL[\s\S]*owner_assignment_source IS NULL/i
  );
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /owner_assignment_source = 'automatic'/i);
  assert.match(sql, /lead_distribution_recovery/i);
});

test("manual owner clears remain manual so recovery cannot take them", () => {
  const sql = source("src/db/accessControlSchema.sql");
  assert.match(sql, /CREATE OR REPLACE FUNCTION mark_manual_lead_owner_change/i);
  assert.match(sql, /NEW\.owner_assignment_source := 'manual'/i);
  assert.match(
    sql,
    /NEW\.owner_assignment_source = 'automatic'[\s\S]*IS DISTINCT FROM OLD\.owner_assignment_source/i
  );
});

test("status and recovery endpoints expose recoverable unassigned leads", () => {
  const repo = source("src/db/leadDistributionRepo.js");
  const route = source("src/routes/config.js");
  const frontendApi = source("portal-frontend/src/api.js");
  const page = source("portal-frontend/src/pages/LeadDistribution.jsx");

  assert.match(repo, /recoverable_unassigned_count/i);
  assert.match(repo, /manual_unassigned_count/i);
  assert.match(repo, /recover_unassigned_open_leads\(\$1\)/i);
  assert.match(route, /lead-distribution\/recover-unassigned/i);
  assert.match(route, /Enable Automatic Lead Distribution/i);
  assert.match(frontendApi, /recoverUnassignedLeads/);
  assert.match(page, /Assign never-owned leads/);
  assert.match(page, /manually unassigned by staff will stay unassigned/i);
});
