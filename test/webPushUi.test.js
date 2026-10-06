const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Web Push UI is per-device and excludes ordinary new customer messages", () => {
  const page = read("portal-frontend/src/pages/Notifications.jsx");
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const worker = read("portal-frontend/public/sw.js");

  assert.match(app, /path="\/notifications"/);
  assert.match(sidebar, /to: "\/notifications", label: "Notifications"/);
  assert.match(page, /Enable notifications on this device/);
  assert.match(page, /Booking Ready/);
  assert.match(page, /Needs Human Attention/);
  assert.match(page, /Delivery Failed/);
  assert.match(page, /Ordinary new customer messages do not send push notifications/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /event\.notification\.data\?\.url/);
  assert.match(worker, /showNotification/);
});

test("service worker is registered by the portal entry point", () => {
  const main = read("portal-frontend/src/main.jsx");
  assert.match(main, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});
