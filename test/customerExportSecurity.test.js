const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("customer export keeps a dedicated permission and lead-view gate", () => {
  const permissions = source("src/utils/permissions.js");
  const auth = source("src/middleware/requireAuth.js");

  assert.match(permissions, /key: "export_customer_data"/);
  assert.match(permissions, /defaults: \{ admin: true, sales: false \}/);
  assert.match(auth, /parts\[0\] === "export"/);
  assert.match(auth, /hasCapability\(user, "export_customer_data"\)/);
  assert.match(auth, /hasAnyLeadView\(user\)/);
});

test("customer export applies accessible-contact scoping and no-store delivery", () => {
  const route = source("src/routes/contacts.js");
  const repo = source("src/db/customerExportRepo.js");

  assert.match(route, /getAccessibleContactIds\(req\.user\)/);
  assert.match(route, /allowedContactIds/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(repo, /c\.id = ANY\(/);
  assert.match(repo, /CASE WHEN c\.channel = 'whatsapp' THEN c\.whatsapp_number ELSE NULL END/);
});

test("customer export audit does not persist raw customer search text", () => {
  const route = source("src/routes/contacts.js");

  assert.match(route, /searchApplied: Boolean\(search\.trim\(\)\)/);
  assert.doesNotMatch(route, /filters:\s*scope === "current"\s*\?\s*\{ search, assignment \}/);
});
