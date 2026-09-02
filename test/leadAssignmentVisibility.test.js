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

test("Lead Distribution uses the same all-lead default as the Sales permission model", () => {
  const usersRepo = source("src/db/usersRepo.js");
  const safetySchema = source("src/db/leadDistributionSafetySchema.sql");

  assert.match(
    usersRepo,
    /COALESCE\(permissions ->> 'view_all_leads', 'true'\) = 'true'/
  );
  assert.doesNotMatch(
    usersRepo,
    /COALESCE\(permissions ->> 'view_all_leads', 'false'\) = 'true'/
  );
  assert.match(
    safetySchema,
    /COALESCE\(permissions ->> 'view_all_leads', 'true'\) = 'true'/
  );
  assert.match(
    safetySchema,
    /COALESCE\(\(selected_permissions ->> 'view_all_leads'\)::boolean, true\)/
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

test("Inbox keeps AI handling separate from lead assignment with a clear filter hierarchy", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");
  const badge = source("portal-frontend/src/components/LeadAssignmentBadge.jsx");

  assert.match(inbox, /control: "all"/);
  assert.match(inbox, /assignment: "all"/);
  assert.match(inbox, /label="Lead owner"/);
  assert.match(inbox, /label="Channel"/);
  assert.match(inbox, /label="Handled by"/);
  assert.match(inbox, /\["all", "Any"\]/);
  assert.match(inbox, /matchesLeadAssignment/);
  assert.match(inbox, /lead_owner_display_name/);
  assert.match(inbox, /<LeadAssignmentBadge/);
  assert.match(inbox, /<ControlIndicator/);

  assert.match(badge, /\["all", "All leads"\]/);
  assert.match(badge, /\["mine", "My leads"\]/);
  assert.match(badge, /\["unassigned", "Unassigned"\]/);
  assert.match(badge, /value === "mine"/);
  assert.match(badge, /value === "unassigned"/);
  assert.match(badge, /value\?\.startsWith\("owner:"\)/);
});

test("Inbox keeps advanced filters collapsed behind one compact control", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");

  assert.match(inbox, /const \[filtersOpen, setFiltersOpen\] = useState\(false\)/);
  assert.match(inbox, /aria-controls="inbox-filter-panel"/);
  assert.match(inbox, />Filters</);
  assert.match(inbox, /activeFilterCount/);
  assert.match(inbox, /filtersOpen && \(/);
  assert.match(inbox, /id="inbox-filter-panel"/);
  assert.match(inbox, /label="Status"/);
  assert.match(inbox, /activeFilterChips/);
  assert.doesNotMatch(inbox, /aria-label="Conversation status filters"/);
  assert.doesNotMatch(inbox, /Narrow the Inbox only when you need to/);
});

test("Inbox keeps normal states quiet and emphasizes actionable exceptions", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");
  const styles = source("portal-frontend/src/index.css");

  assert.match(inbox, /function ControlIndicator\(\{ mode \}\) \{\s*if \(mode !== "human"\) return null/);
  assert.match(inbox, /title="Handled by staff"/);
  assert.doesNotMatch(inbox, /last_message_role === "assistant" \? "You: "/);
  assert.doesNotMatch(inbox, /function ChannelBadge/);
  assert.doesNotMatch(inbox, /function ModeBadge/);
  assert.doesNotMatch(inbox, /Enter to send · Shift \+ Enter for a new line/);
  assert.doesNotMatch(styles, /radial-gradient\(/);

  assert.match(inbox, /<StatusBadge tone="accent">Follow-up<\/StatusBadge>/);
  assert.match(inbox, /<StatusBadge tone="danger">Attention<\/StatusBadge>/);
  assert.match(inbox, /contact\.needs_attention && \(/);
});

test("Inbox thread header stays compact while keeping owner and channel context", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");

  assert.match(inbox, /currentUsername=\{username\}/);
  assert.match(inbox, /function contactMeta\(contact\)/);
  assert.match(inbox, /if \(channel === "facebook"\) return "Facebook Messenger"/);
  assert.match(inbox, /if \(channel === "instagram"\) return "Instagram"/);
  assert.match(inbox, /ownerUsername=\{contact\.lead_owner_username\}/);
  assert.match(inbox, /ownerDisplayName=\{contact\.lead_owner_display_name\}/);
  assert.match(inbox, /Message this patient…/);
  assert.match(inbox, /Message to take over from AI…/);
  assert.doesNotMatch(inbox, /Type a WhatsApp message to this patient/);
});

test("restricted Inbox scope hides irrelevant assignment choices and explains the visible workload", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");

  assert.match(inbox, /const \{ username, permissions \} = useAuth\(\)/);
  assert.match(inbox, /const canViewAllLeads = permissions\.view_all_leads === true/);
  assert.match(inbox, /canViewAllLeads \? \(/);
  assert.match(inbox, /My assigned leads/);
  assert.match(inbox, /No assigned conversations/);
  assert.match(inbox, /Leads assigned to you will appear here automatically/);
  assert.match(
    inbox,
    /canViewAllLeads &&\s*!matchesLeadAssignment\(conversation, filters\.assignment, currentUsername\)/
  );
});

test("Inbox returns to a safe list state when a selected restricted lead is reassigned away", () => {
  const inbox = source("portal-frontend/src/pages/Inbox.jsx");

  assert.match(inbox, /const stillAccessible = conversations\.some/);
  assert.match(inbox, /if \(stillAccessible\) return/);
  assert.match(inbox, /const nextConversation = conversations\[0\] \|\| null/);
  assert.match(inbox, /setSelectedId\(nextConversation\?\.contact_id \?\? null\)/);
  assert.match(inbox, /setContactDetailsOpen\(false\)/);
  assert.match(inbox, /setMobileThreadOpen\(false\)/);
  assert.match(inbox, /setSearchParams\(\{\}, \{ replace: true \}\)/);
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