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

test("access-control schema installs atomic Sales-only lead assignment", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../src/db/accessControlSchema.sql"),
    "utf8"
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_distribution_state/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /is_active = true[\s\S]*role = 'sales'/i);
  assert.match(sql, /view_assigned_leads/i);
  assert.match(sql, /reply_to_assigned_leads/i);
  assert.match(sql, /BEFORE INSERT ON leads/i);
  assert.match(sql, /NEW\.owner_username/i);
  assert.match(sql, /leadDistribution,enabled/i);
});
