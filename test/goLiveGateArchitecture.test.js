const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("go-live API is authenticated and administrator-only", () => {
  const server = source("src/server.js");
  const route = source("src/routes/goLive.js");

  assert.match(server, /app\.use\("\/api\/go-live", requireAuth, goLiveRoutes\)/);
  assert.match(route, /router\.use\(requireAdministrator\)/);
  assert.match(route, /req\.user\?\.role !== "admin"/);
});

test("go-live gate reuses Setup Status and never introduces a customer send path", () => {
  const route = source("src/routes/goLive.js");
  const loader = source("src/services/goLiveGateLoaderService.js");
  const page = source("portal-frontend/src/pages/GoLive.jsx");

  assert.match(route, /goLiveGateLoaderService/);
  assert.match(loader, /setupStatus\.getOverview/);
  assert.match(loader, /setupStatus\.runAll/);
  assert.match(loader, /setupStatusOverviewService/);
  assert.doesNotMatch(route, /require\("\.\/setupStatus"\)/);
  assert.doesNotMatch(`${route}\n${loader}`, /send(?:Text|Message|Image|Voice)|channelMessaging|whatsappService|metaMessagingService/);
  assert.match(page, /never sends a synthetic customer message/i);
});

test("go-live dashboard is admin-only and available from Settings", () => {
  const app = source("portal-frontend/src/App.jsx");
  const settingsLayout = source("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const api = source("portal-frontend/src/api.js");

  assert.match(app, /path="\/settings\/go-live"/);
  assert.match(app, /<ProtectedRoute adminOnly>[\s\S]*?<SettingsSectionLayout><GoLive \/><\/SettingsSectionLayout>[\s\S]*?<\/ProtectedRoute>/);
  assert.match(settingsLayout, /label: "Go Live"/);
  assert.match(api, /getGoLiveGate: \(\) => request\("\/go-live"\)/);
  assert.match(api, /runGoLiveGate: \(\) => request\("\/go-live\/run", \{ method: "POST" \}\)/);
});


test("go-live page exposes actionable remediation and explicit profile alignment", () => {
  const page = source("portal-frontend/src/pages/GoLive.jsx");
  const service = source("src/services/goLiveGateService.js");

  assert.match(page, /Business profile alignment/);
  assert.match(page, /How to complete the live test/);
  assert.match(page, /item\.remediationRoute/);
  assert.match(service, /schemaVersion: GO_LIVE_SCHEMA_VERSION/);
  assert.match(service, /reason === "live_evidence_pending"/);
  assert.doesNotMatch(service, /PASSIVE_CHANNEL_WARNING/);
});
