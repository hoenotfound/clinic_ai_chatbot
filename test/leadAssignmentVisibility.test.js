const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { effectivePermissions, roleDefaults } = require("../src/utils/permissions");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("Sales users can see all leads by default while explicit access overrides remain respected", () => {
  assert.equal(roleDefaults("sales").view_all_leads, true);
  assert.equal(effectivePermissions({ role: "sales", permissions: {} }).view_all_leads, true);
  assert.equal(
    effectivePermissions({ role: "sales", permissions: { view_all_leads: false } }).view_all_leads,
    false
  );
});

test("Inbox and Contacts derive assignment from the same current lead used by access control", () => {
  const contactsRepo = source("src/db/contactsRepo.js");
  const accessControl = source("src/utils/accessControl.js");

  for (const content of [contactsRepo, accessControl]) {
    assert.match(
      content,
      /ORDER BY (?:l\.)?is_closed ASC, (?:l\.)?created_at DESC, (?:l\.)?id DESC/i
    );
    assert.match(content, /LIMIT 1/i);
  }

  assert.match(contactsRepo, /current_lead\.owner_username AS lead_owner_username/i);
  assert.match(contactsRepo, /AS lead_owner_display_name/i);
  assert.match(contactsRepo, /LEFT JOIN users lead_owner/i);
});

test("Inbox keeps AI control separate from lead assignment and supports owner filters", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");
  const badge = source("portal-frontend/src/components/LeadAssignmentBadge.jsx");

  assert.match(inbox, /control: "all"/);
  assert.match(inbox, /assignment: "all"/);
  assert.match(inbox, /Filter by conversation control/);
  assert.match(inbox, /Filter by lead assignment/);
  assert.match(inbox, /matchesLeadAssignment/);
  assert.match(inbox, /lead_owner_display_name/);
  assert.match(inbox, /<LeadAssignmentBadge/);

  assert.match(badge, /Assigned to me/);
  assert.match(badge, /Unassigned/);
  assert.match(badge, /value === "mine"/);
  assert.match(badge, /value === "unassigned"/);
  assert.match(badge, /value\?\.startsWith\("owner:"\)/);
});

test("Contacts exposes the same assignment filter and refreshes assignment badges only on pipeline changes", () => {
  const contacts = source("portal-frontend/src/pages/Contacts.jsx");

  assert.match(contacts, /buildLeadAssignmentFilterOptions/);
  assert.match(contacts, /matchesLeadAssignment/);
  assert.match(contacts, /Filter contacts by lead assignment/);
  assert.match(contacts, /<LeadAssignmentBadge/);
  assert.match(contacts, /lead_owner_username/);
  assert.match(contacts, /new EventSource\("\/api\/conversations\/events"/);
  assert.match(contacts, /addEventListener\("pipeline_changed"/);
  assert.doesNotMatch(contacts, /addEventListener\("conversation_changed"/);
});
