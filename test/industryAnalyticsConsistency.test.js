const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  getPipelineProfile,
} = require("../src/config/pipelineProfiles");
const {
  milestoneTimesCte,
} = require("../src/db/analyticsPipelineProfile");

test("renovation analytics use stage history consistently across dashboard views", () => {
  const renovation = getPipelineProfile({ businessType: "home_renovation" }).analytics;

  assert.equal(renovation.primarySystemKey, "next_step");
  assert.equal(renovation.secondarySystemKey, "decision");
  assert.equal(renovation.appointmentStatusFallback, false);

  const sql = milestoneTimesCte({
    businessType: "home_renovation",
    configuredBusinessType: "home_renovation",
    legacyStageFallback: false,
    ...renovation,
  });

  assert.match(sql, /stage\.system_key = 'next_step'/);
  assert.match(sql, /stage\.system_key = 'decision'/);
  assert.doesNotMatch(sql, /j\.appointment_status IN \('set', 'visited'\)/);
  assert.doesNotMatch(sql, /j\.appointment_status = 'visited'/);
});

test("Analytics UI follows the effective backend pipeline profile for legacy installs", () => {
  const root = path.join(__dirname, "..");
  const analyticsPage = fs.readFileSync(
    path.join(root, "portal-frontend/src/pages/Analytics.jsx"),
    "utf8"
  );
  const pipelineRoute = fs.readFileSync(
    path.join(root, "src/routes/pipeline.js"),
    "utf8"
  );

  assert.match(
    pipelineRoute,
    /analyticsBusinessType:\s*getAnalyticsPipelineProfile\(\)\.businessType/
  );
  assert.match(analyticsPage, /data\?\.analyticsBusinessType/);
  assert.match(
    analyticsPage,
    /businessType:\s*data\.analyticsBusinessType/
  );
  assert.match(
    analyticsPage,
    /getBusinessTerminology\(effectiveAnalyticsConfig\)\.analytics/
  );
});
