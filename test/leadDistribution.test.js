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

test("access-control schema installs atomic Sales assignment with stable ownership", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS branch_name TEXT/i);
  assert.match(sql, /owner_assignment_source/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_distribution_cursors/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION assign_new_lead_owner/i);
  assert.match(sql, /lower\(btrim\(COALESCE\(branch_name/i);
  assert.match(sql, /eligible_count = 1/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /routing_scope TEXT := 'global'/i);
  assert.match(sql, /BEFORE INSERT ON leads/i);
  assert.match(sql, /BEFORE UPDATE OF owner_username ON leads/i);
  assert.match(sql, /view_assigned_leads/i);
  assert.match(sql, /reply_to_assigned_leads/i);
  assert.match(sql, /leadDistribution,enabled/i);
});

test("customer message storage has no active branch-routing trigger", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.doesNotMatch(sql, /CREATE TRIGGER trg_customer_branch_after_message_insert/i);
  assert.doesNotMatch(sql, /CREATE TRIGGER trg_customer_branch_after_message_update/i);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION detect_configured_branch_preference/i);
});

test("AI summary softly fills only a blank branch without rerouting owner", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /fill_lead_branch_from_ai_summary/i);
  assert.match(sql, /summary_data ->> 'preferredBranch'/i);
  assert.match(sql, /lower\(btrim\(branch ->> 'name'\)\) = lower\(requested_branch\)/i);
  assert.match(sql, /NULLIF\(btrim\(COALESCE\(branch_name, ''\)\), ''\) IS NULL/i);
  assert.match(sql, /AFTER UPDATE OF status, summary_data ON lead_temperature_scores/i);
  assert.doesNotMatch(sql, /BEFORE UPDATE OF branch_name, owner_username ON leads/i);
});

test("AI branch enrichment writes an audit activity on a best-effort basis", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /INSERT INTO lead_activities/i);
  assert.match(sql, /AI summary recorded preferred branch/i);
  assert.match(sql, /'source', 'ai_summary'/i);
  assert.match(sql, /EXCEPTION WHEN OTHERS THEN\s+NULL;/i);
});

test("lead distribution status exposes branches and AI branch-recording availability", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/config.js"),
    "utf8"
  );

  assert.match(source, /configuredBranches/);
  assert.match(source, /aiBranchRecording/);
  assert.match(source, /leadScoringEnabled/);
  assert.match(source, /telegramSummaryEnabled/);
  assert.match(source, /branchName: user\.branch_name \|\| null/);
});

test("manual owners remain authoritative and migration backfill is excluded", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /NEW\.created_by = 'Migration'/i);
  assert.match(sql, /NEW\.owner_assignment_source := 'automatic'/i);
  assert.match(sql, /mark_manual_lead_owner_change/i);
  assert.match(sql, /ELSE 'manual'/i);
});
