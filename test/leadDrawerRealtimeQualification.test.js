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

test("LeadDrawer refreshes activities from pipeline_changed and cleans up its realtime connection", () => {
  const drawer = fs.readFileSync(
    path.join(
      __dirname,
      "../portal-frontend/src/components/pipeline/LeadDrawer.jsx"
    ),
    "utf8"
  );

  assert.match(drawer, /new EventSource\("\/api\/conversations\/events"/);
  assert.match(drawer, /source\.addEventListener\("pipeline_changed", refreshForPipelineEvent\)/);
  assert.match(drawer, /shouldRefreshLeadActivities\(event\?\.data, lead\.id\)/);
  assert.match(drawer, /refreshTimer = setTimeout\(\(\) => \{/);
  assert.match(drawer, /loadActivities\(\);/);
  assert.match(drawer, /source\.removeEventListener\("pipeline_changed", refreshForPipelineEvent\)/);
  assert.match(drawer, /source\.close\(\)/);
  assert.match(drawer, /version === requestVersion/);
});
