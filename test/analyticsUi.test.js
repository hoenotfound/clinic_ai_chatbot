const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Analytics keeps the primary sales story above secondary diagnostics", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.doesNotMatch(analytics, />Sales<\/span>/);
  assert.match(analytics, /xl:grid-cols-4/);
  assert.match(analytics, /function ConversionSummary\(/);
  assert.doesNotMatch(analytics, /function RateStrip\(/);

  const performance = analytics.indexOf('title="Performance Breakdown"');
  const leadQuality = analytics.indexOf('title="Lead Quality"');
  assert.ok(performance > 0 && leadQuality > performance, "Performance Breakdown should appear before Lead Quality");
});

test("Analytics filters stay compact and only apply when the draft changed", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /More filters/);
  assert.match(analytics, /Hide filters/);
  assert.match(analytics, /disabled=\{loading \|\| !hasPendingChanges\}/);
  assert.match(analytics, /activeAdvancedFilterCount = ADVANCED_FILTERS/);
  assert.match(analytics, /More filters"\}\{activeAdvancedFilterCount/);
  assert.match(analytics, /rounded-xl border border-\[var\(--color-border\)\] bg-\[var\(--color-bg\)\] p-3/);
});

test("Analytics cards use the flatter visual system", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /function Panel\([\s\S]*rounded-xl border border-\[var\(--color-border\)\] bg-white p-4 sm:p-5/);
  assert.match(analytics, /function MetricCard\([\s\S]*rounded-xl border border-\[var\(--color-border\)\] bg-white p-3\.5 sm:p-4/);
  assert.doesNotMatch(analytics, /shadow-sm/);
});


test("Analytics conversion summary keeps each rate definition visible", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /labels\[0\]\?\.detail \|\| labels\[0\]\?\.label/);
  assert.match(analytics, /labels\[1\]\?\.detail \|\| labels\[1\]\?\.label/);
  assert.match(analytics, /labels\[2\]\?\.detail \|\| labels\[2\]\?\.label/);
  assert.match(analytics, /\{definition\} <strong/);
});
