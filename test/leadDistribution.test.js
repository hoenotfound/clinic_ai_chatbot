const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_LEAD_DISTRIBUTION,
  normalizeLeadDistributionConfig,
} = require("../src/utils/leadDistribution");

test("lead distribution defaults to paused round robin", () => {
  assert.deepEqual(DEFAULT_LEAD_DISTRIBUTION, {
    enabled: false,
    strategy: "round_robin",
  });
});

test("lead distribution accepts only a boolean switch and round robin", () => {
  assert.deepEqual(
    normalizeLeadDistributionConfig({ enabled: true, strategy: "round_robin" }),
    { enabled: true, strategy: "round_robin" }
  );
  assert.equal(normalizeLeadDistributionConfig({ enabled: "true", strategy: "round_robin" }), null);
  assert.equal(normalizeLeadDistributionConfig({ enabled: true, strategy: "random" }), null);
  assert.equal(normalizeLeadDistributionConfig(null), null);
});

test("access-control schema installs branch-first atomic Sales assignment", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS branch_name TEXT/i);
  assert.match(sql, /owner_assignment_source/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_distribution_cursors/i);
  assert.match(sql, /detect_configured_branch_preference/i);
  assert.match(sql, /route_lead_owner_by_branch/i);
  assert.match(sql, /lower\(btrim\(COALESCE\(branch_name/i);
  assert.match(sql, /eligible_count = 1/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /routing_scope := 'global'/i);
  assert.match(sql, /BEFORE INSERT ON leads/i);
  assert.match(sql, /BEFORE UPDATE OF branch_name, owner_username ON leads/i);
  assert.match(sql, /AFTER INSERT ON messages/i);
  assert.match(sql, /AFTER UPDATE OF content ON messages/i);
  assert.match(sql, /view_assigned_leads/i);
  assert.match(sql, /reply_to_assigned_leads/i);
  assert.match(sql, /leadDistribution,enabled/i);
});

test("branch routing preserves manual owners and excludes migration backfill", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /owner_assignment_source := 'manual'/i);
  assert.match(sql, /COALESCE\(OLD\.owner_assignment_source, 'manual'\) <> 'automatic'/i);
  assert.match(sql, /NEW\.created_by = 'Migration'/i);
  assert.match(sql, /NEW\.owner_assignment_source := 'automatic'/i);
});
