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
  assert.match(analytics, /function MetricCard\([\s\S]*rounded-xl border border-\[var\(--color-border\)\] bg-white p-3 sm:p-4/);
  assert.doesNotMatch(analytics, /shadow-sm/);
});


test("Analytics conversion summary keeps each rate definition visible", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /labels\[0\]\?\.detail \|\| labels\[0\]\?\.label/);
  assert.match(analytics, /labels\[1\]\?\.detail \|\| labels\[1\]\?\.label/);
  assert.match(analytics, /labels\[2\]\?\.detail \|\| labels\[2\]\?\.label/);
  assert.match(analytics, /\{definition\} <strong/);
});


test("Analytics mobile layout keeps filters compact and conversion rates structured", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /data-testid="analytics-scroll"/);
  assert.match(analytics, /overflow-x-hidden overflow-y-auto/);
  assert.match(analytics, /Track leads, conversion and sales outcomes\./);
  assert.match(analytics, /col-span-2 flex h-10 w-full items-center justify-between rounded-xl border[\s\S]*More filters/);
  assert.match(analytics, /hasPendingChanges \|\| filterActionPending \? "inline-flex" : "hidden sm:inline-flex"/);
  assert.match(analytics, /<div className="sm:hidden">[\s\S]*Overall conversion/);
  assert.match(analytics, /mt-3 grid min-w-0 grid-cols-3 gap-2/);
});


test("Analytics mobile chart scales to the content column instead of forcing horizontal scroll", () => {
  const css = read("portal-frontend/src/index.css");

  assert.match(css, /svg\[aria-label\$="over time"\][\s\S]*width: 100%;[\s\S]*min-width: 0;[\s\S]*max-width: 100%;/);
  assert.doesNotMatch(css, /svg\[aria-label\$="over time"\][\s\S]*min-width: 360px/);
});


test("Analytics keeps filter loading feedback visible until refreshed data arrives", () => {
  const analytics = read("portal-frontend/src/pages/Analytics.jsx");

  assert.match(analytics, /const \[filterActionPending, setFilterActionPending\] = useState\(false\)/);
  assert.match(analytics, /setFilterActionPending\(true\);[\s\S]*setAppliedFilters\(\{ \.\.\.draftFilters \}\)/);
  assert.match(analytics, /setFilterActionPending\(false\)/);
  assert.match(analytics, /\{filterActionPending \? "Loading…" : "Apply filters"\}/);
});

test("Analytics responsive smoke fixture renders the trend chart that previously overflowed", () => {
  const smoke = read("portal-frontend/e2e/portal-smoke.spec.js");

  assert.doesNotMatch(smoke, /trend: \[\],/);
  assert.match(smoke, /newLeads: 6, appointments: 3, visits: 2, won: 1/);
  assert.match(smoke, /getByRole\("img", \{ name: "New leads over time" \}\)/);
});
