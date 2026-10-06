const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("customer deletion has a dedicated admin-default capability", () => {
  const permissions = source("src/utils/permissions.js");
  const auth = source("src/middleware/requireAuth.js");

  assert.match(permissions, /key: "delete_customer_data"/);
  assert.match(
    permissions,
    /key: "delete_customer_data"[\s\S]*defaults: \{ admin: true, sales: false \}/
  );
  assert.match(
    auth,
    /req\.method === "DELETE" && parts\.length === 1[\s\S]*hasCapability\(user, "delete_customer_data"\)/
  );
});

test("manual customer deletion requires explicit confirmation and durable lifecycle service", () => {
  const route = source("src/routes/contacts.js");

  assert.match(route, /router\.delete\("\/:id"/);
  assert.match(route, /req\.body\?\.confirm !== "DELETE"/);
  assert.match(route, /customerDataLifecycle\.purgeCustomerData/);
  assert.match(route, /reason: "manual"/);
  assert.match(route, /mediaCleanupPending/);
});

test("Contacts UI keeps destructive deletion in a typed-confirmation danger flow", () => {
  const contacts = source("portal-frontend/src/pages/Contacts.jsx");
  const api = source("portal-frontend/src/api.js");

  assert.match(contacts, /permissions\.delete_customer_data === true/);
  assert.match(contacts, /Delete customer data/);
  assert.match(contacts, /Type DELETE to confirm/);
  assert.match(contacts, /confirmation\.trim\(\) === "DELETE"/);
  assert.match(api, /deleteCustomerData/);
  assert.match(api, /body: JSON\.stringify\(\{ confirm: "DELETE" \}\)/);
});

test("automatic customer retention is opt-in and defaults to disabled", () => {
  const env = source(".env.example");
  const service = source("src/services/customerDataLifecycleService.js");

  assert.match(env, /CUSTOMER_DATA_RETENTION_DAYS=0/);
  assert.match(service, /if \(!raw \|\| raw === "0"\) return 0/);
  assert.match(service, /days < 30 \|\| days > 3650/);
});
