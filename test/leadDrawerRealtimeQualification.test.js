const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("realtime qualification refresh targets the open lead without leaking restricted lead ids", async () => {
  const { shouldRefreshLeadActivities } = await import(
    "../portal-frontend/src/components/pipeline/realtimeQualification.js"
  );

  assert.equal(shouldRefreshLeadActivities('{"leadId":42}', 42), true);
  assert.equal(shouldRefreshLeadActivities({ leadId: 42 }, 42), true);
  assert.equal(shouldRefreshLeadActivities('{"leadId":43}', 42), false);
  assert.equal(shouldRefreshLeadActivities({}, 42), true);
  assert.equal(shouldRefreshLeadActivities("{}", 42), true);
  assert.equal(shouldRefreshLeadActivities("not-json", 42), true);
  assert.equal(shouldRefreshLeadActivities('{"leadId":"42"}', 42), true);
  assert.equal(shouldRefreshLeadActivities('{"leadId":"bad"}', 42), false);
  assert.equal(shouldRefreshLeadActivities('{"leadId":42}', null), false);
});

test("Pipeline reuses one realtime connection to refresh the open drawer activities", () => {
  const pipeline = fs.readFileSync(
    path.join(__dirname, "../portal-frontend/src/pages/Pipeline.jsx"),
    "utf8"
  );
  const drawer = fs.readFileSync(
    path.join(
      __dirname,
      "../portal-frontend/src/components/pipeline/LeadDrawer.jsx"
    ),
    "utf8"
  );

  assert.equal((pipeline.match(/new EventSource/g) || []).length, 1);
  assert.equal((drawer.match(/new EventSource/g) || []).length, 0);
  assert.match(pipeline, /source\.addEventListener\("pipeline_changed", handlePipelineChanged\)/);
  assert.match(pipeline, /shouldRefreshLeadActivities\(event\?\.data, openLeadId\)/);
  assert.match(pipeline, /pendingActivityRefreshRef\.current = true/);
  assert.match(pipeline, /setActivityRefreshToken\(\(value\) => value \+ 1\)/);
  assert.match(pipeline, /activityRefreshToken=\{activityRefreshToken\}/);
  assert.match(pipeline, /source\.removeEventListener\("pipeline_changed", handlePipelineChanged\)/);
  assert.match(pipeline, /source\.close\(\)/);

  assert.match(drawer, /activityRefreshToken = 0/);
  assert.match(drawer, /api\.listLeadActivities\(lead\.id\)/);
  assert.match(drawer, /\[activityRefreshToken, lead\.id, onToast\]/);
  assert.match(drawer, /if \(!cancelled\) setActivities\(data\)/);
});
