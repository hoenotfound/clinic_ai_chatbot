const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("manual owner choices and database writes use serviceable staff only", () => {
  const usersRepo = read("src/db/usersRepo.js");
  const pipelineRoute = read("src/routes/pipeline.js");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");

  assert.match(usersRepo, /async function listAssignableLeadOwners/);
  assert.match(usersRepo, /effectivePermissions\(user\)/);
  assert.match(usersRepo, /permissions\.reply_to_assigned_leads === true/);
  assert.match(pipelineRoute, /usersRepo\.listAssignableLeadOwners\(\)/);
  assert.match(safetySchema, /validate_lead_owner_eligibility/);
  assert.match(safetySchema, /FOR SHARE/);
  assert.match(safetySchema, /cannot currently view and reply to assigned leads/);
});

test("new and edited lead branch options are separated from historical branch filters", () => {
  const pipelineRoute = read("src/routes/pipeline.js");
  const requireAuth = read("src/middleware/requireAuth.js");
  const api = read("portal-frontend/src/api.js");
  const addLead = read("portal-frontend/src/components/pipeline/AddLeadModal.jsx");
  const leadDrawer = read("portal-frontend/src/components/pipeline/LeadDrawer.jsx");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");

  assert.match(pipelineRoute, /router\.get\("\/configured-branches"/);
  assert.match(pipelineRoute, /branches: distinctNames\(\[\.\.\.configuredBranches, \.\.\.savedBranches\]\)/);
  assert.match(requireAuth, /parts\[0\] === "configured-branches"/);
  assert.match(requireAuth, /Pipeline access is disabled for this account/);
  assert.match(api, /getConfiguredBranches: \(\) => request\("\/pipeline\/configured-branches"\)/);
  assert.match(addLead, /api\.getConfiguredBranches\(\)/);
  assert.doesNotMatch(addLead, /api\.getPipeline\(\)/);
  assert.match(addLead, /You can still add an unassigned lead/);
  assert.match(leadDrawer, /api\.getConfiguredBranches\(\)/);
  assert.match(leadDrawer, /no longer configured/);
  assert.match(leadDrawer, /historical \{ui\.locationSingular\} data/i);
  assert.match(safetySchema, /validate_current_lead_branch/);
  assert.match(safetySchema, /no longer configured/);
});

test("Inbox refresh signals are emitted only when lead visibility can change", () => {
  const realtimeEvents = read("src/utils/realtimeEvents.js");
  const pipelineRepo = read("src/db/pipelineRepo.js");
  const recoveryRepo = read("src/db/leadDistributionRepo.js");

  assert.doesNotMatch(realtimeEvents, /if \(event === "pipeline_changed"\)/);
  assert.match(pipelineRepo, /refreshInbox = false/);
  assert.match(pipelineRepo, /reason: "lead_assignment_changed"/);
  assert.match(pipelineRepo, /refreshInbox: outcome\.created && Boolean\(outcome\.lead\.owner_username\)/);
  assert.match(pipelineRepo, /refreshInbox: Object\.hasOwn\(patch, "ownerUsername"\)/);
  assert.match(recoveryRepo, /reason: "lead_assignment_recovered"/);
});

test("lead distribution mutations require both Tools and Assign leads permissions", () => {
  const requireAuth = read("src/middleware/requireAuth.js");
  assert.match(requireAuth, /const canAssign = hasCapability\(user, "manage_lead_assignment"\)/);
  assert.match(requireAuth, /changesLeadDistribution && \(!canTools \|\| !canAssign\)/);
  assert.match(requireAuth, /Changing lead distribution requires both Manage automation tools and Assign leads permissions/);
  assert.match(requireAuth, /req\.method !== "GET" && !canAssign/);
});

test("Lead Distribution is selected from inside Tools rather than the main sidebar", () => {
  const app = read("portal-frontend/src/App.jsx");
  const toolsRoute = read("portal-frontend/src/pages/ToolsRoute.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(app, /import ToolsRoute from "\.\/pages\/ToolsRoute"/);
  assert.match(app, /<ToolsRoute \/>/);
  assert.match(toolsRoute, /import Tools from "\.\/Tools"/);
  assert.match(toolsRoute, /<Tools \/>/);
  assert.doesNotMatch(app, /ToolsWithNavigation/);
  assert.match(app, /to="\/tools\?tool=lead-distribution"/);
  assert.doesNotMatch(sidebar, /label: "Lead Distribution"/);
  assert.match(tools, /useSearchParams/);
  assert.match(tools, /value === "lead-distribution"/);
  assert.match(tools, /onSelect\("leadDistribution"\)/);
  assert.match(tools, /title="Lead distribution"/);
  assert.match(tools, /<LeadDistribution/);
  assert.match(tools, /distributionActive/);
});

test("Tools route stays focused and does not render the redundant channel banner", () => {
  const toolsRoute = read("portal-frontend/src/pages/ToolsRoute.jsx");

  assert.match(toolsRoute, /<Tools \/>/);
  assert.doesNotMatch(toolsRoute, /WhatsApp · Messenger · Instagram/);
  assert.doesNotMatch(toolsRoute, /24-hour messaging window/);
  assert.doesNotMatch(toolsRoute, /useSearchParams/);
});

test("Lead Distribution UI exposes a simple location/global choice and view-only state", () => {
  const page = read("portal-frontend/src/pages/LeadDistribution.jsx");
  assert.match(page, /const ui = getBusinessTerminology\(businessConfig \|\| \{\}\)/);
  assert.match(page, /assignByBranch: true/);
  assert.match(page, /How should leads be shared\?/);
  assert.match(page, /title=\{`By \$\{ui\.locationSingular\}`\}/);
  assert.match(page, /Across all Sales staff/);
  assert.match(page, /The \{ui\.locationSingular\} is still recorded for CRM, reporting and \{ui\.conversionCountPlural\}/);
  assert.match(page, /canManageDistribution/);
  assert.match(page, /View only/);
  assert.match(page, /View team & \{ui\.locationSingular\} pools/);
  assert.match(page, /How it works & advanced behavior/);
  assert.doesNotMatch(page, /Back to Tools/);
});

test("Tools UX keeps advanced details out of the main setup flow", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /Review translations/);
  assert.match(tools, /Language versions will refresh automatically when you save/);
  assert.match(tools, /api\.translateFollowUp\(message\)/);
  assert.match(tools, /Advanced timing settings/);
  assert.match(tools, /Booking intent → Hot/);
  assert.match(tools, /Clear rejection → Cold/);
  assert.match(tools, /Staff changes always win/);
  assert.match(tools, /You have unsaved changes in this tool\. Leave without saving them\?/);
  assert.doesNotMatch(tools, /function OverviewItem/);
});

test("manual staff sends cancel synthetic AI handoff before clearing Needs Attention", () => {
  const route = read("src/routes/conversations.js");

  const helperStart = route.indexOf("async function prepareStaffSend");
  const helperEnd = route.indexOf("async function persistSendOutcome", helperStart);
  const helper = route.slice(helperStart, helperEnd);

  const claimIndex = helper.indexOf("claimAiHandoffOwnership");
  const clearIndex = helper.indexOf("contactsRepo.setAttention(preparedContact.id, false)");
  assert.ok(claimIndex >= 0 && clearIndex > claimIndex);
  assert.match(helper, /contact\.takeover_by === AI_HANDOFF_OWNER/);
  assert.match(helper, /AI handoff ownership could not be claimed safely/);
  assert.match(helper, /aiReplyCancellation\.cancelForContact\(contact\)/);
  assert.doesNotMatch(helper, /contactsRepo\.takeOver/);

  const textRouteStart = route.indexOf('router.post("/:contactId/messages"');
  const imageRouteStart = route.indexOf('router.post("/:contactId/media"');
  const voiceRouteStart = route.indexOf('router.post("/:contactId/voice"');
  const textRoute = route.slice(textRouteStart, imageRouteStart);
  const imageRoute = route.slice(imageRouteStart, voiceRouteStart);

  assert.ok(
    textRoute.indexOf("prepareStaffSend") <
      textRoute.indexOf("conversationStore.appendMessageForContact")
  );
  assert.ok(
    imageRoute.indexOf("prepareStaffSend") <
      imageRoute.indexOf("conversationStore.appendMessageForContact")
  );
});

test("Follow-up UI explains promotion overrides, sequence stops, and manual follow-up naming", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");
  const inbox = read("portal-frontend/src/pages/Inbox.jsx");

  assert.match(tools, /Promotion override is available/);
  assert.match(tools, /If AI decides to skip or request human review/);
  assert.match(tools, /A real staff takeover cancels an older AI-started sequence/);
  assert.match(tools, /Sent scheduled staff messages count as staff replies/);
  assert.match(settings, /Requires Tools → Automated follow-up to be on/);
  assert.match(settings, /Language-specific follow-up copy/);
  assert.match(settings, /image, caption, and first follow-up offer/);
  assert.match(inbox, /Needs follow-up/);
});

test("leaving a dirty tool discards its local draft consistently", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /function discardCurrentToolChanges\(\)/);
  assert.match(tools, /setForm\(saved\)/);
  assert.match(tools, /setScoringForm\(scoringFormFromSettings\(config\?\.leadScoring\)\)/);
  assert.match(tools, /discardCurrentToolChanges\(\)/);
  assert.match(tools, /setDistributionDirty\(false\)/);
});

test("automatic translation refresh preserves manual language edits made after the latest source change", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /manualTranslationEdits/);
  assert.match(tools, /setManualTranslationEdits\(\[\]\)/);
  assert.match(tools, /manualTranslationEdits\.includes\(key\)/);
  assert.match(tools, /preserveManual \? manualValue : generated\[key\]/);
  assert.match(tools, /onTranslationChange\(translationLanguage, event\.target\.value\)/);
});

test("production migrations load ownership, routing, and social follow-up safeguards", () => {
  const db = read("src/db/db.js");
  const runner = read("src/db/migrationRunner.js");
  const safetySchema = read("src/db/leadDistributionSafetySchema.sql");
  const followUpSchema = read("src/db/followUpMultiChannelSchema.sql");

  assert.match(db, /runMigrations\(pool(?:\s*,|\s*\))/);
  assert.match(runner, /name: "follow_up_multi_channel"/);
  assert.match(runner, /file: "followUpMultiChannelSchema\.sql"/);
  assert.match(followUpSchema, /normalize_social_automated_follow_up_retry_status/);
  assert.match(followUpSchema, /c\.channel IN \('facebook', 'instagram'\)/);
  assert.match(runner, /name: "lead_distribution_safety"/);
  assert.match(runner, /file: "leadDistributionSafetySchema\.sql"/);
  assert.match(safetySchema, /lead_distribution_initial/);
  assert.match(safetySchema, /Automatically assigned to %s when the lead was created/);
  assert.match(safetySchema, /choose_lead_distribution_owner/);
  assert.match(safetySchema, /leadDistribution,assignByBranch/);
});

test("Tools navigation focuses on available automations without future-tool clutter", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /Choose and manage the automations your team uses/);
  assert.match(tools, /title="Lead temperature"/);
  assert.match(tools, /title="Lead distribution"/);
  assert.doesNotMatch(tools, /function ToolStatus\(/);
  assert.doesNotMatch(tools, /More coming/);
  assert.doesNotMatch(tools, /ComingSoonTool/);
  assert.doesNotMatch(tools, /Appointment reminders/);
  assert.doesNotMatch(tools, /Promotional campaigns/);
  assert.doesNotMatch(tools, /Review requests/);
  assert.doesNotMatch(tools, /function StatusBadge\(/);
});


test("Tools cleanup keeps mobile navigation contained and Lead Distribution visually aligned", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");
  const distribution = read("portal-frontend/src/pages/LeadDistribution.jsx");

  assert.match(tools, /w-full min-w-0 max-w-full shrink-0 overflow-hidden/);
  assert.doesNotMatch(tools, /min-w-\[11\.75rem\]/);
  assert.doesNotMatch(tools, /block truncate text-\[13px\] font-semibold/);
  assert.match(tools, /min-h-16.*flex-col.*xl:flex-row/);
  assert.match(tools, /\{enabled \? "On" : "Off"\}/);
  assert.match(tools, /shortTitle="Follow-up"/);
  assert.match(tools, /shortTitle="Comments"/);
  assert.match(tools, /shortTitle="Temperature"/);
  assert.match(tools, /shortTitle="Routing"/);
  assert.match(tools, /grid min-w-0 max-w-full grid-cols-4 gap-1/);
  assert.match(distribution, />Lead distribution<\/h1>/);
  assert.doesNotMatch(distribution, /function ToolStatus\(/);
  assert.doesNotMatch(distribution, /function StatusBadge\(/);
  assert.doesNotMatch(distribution, /shadow-\[0_8px_30px/);
  assert.doesNotMatch(distribution, /shadow-\[0_-8px_24px/);
});


test("Comment Automation uses the same flattened visual system as the rest of Tools", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.doesNotMatch(tools, /group rounded-2xl border border-\[var\(--color-border\)\] bg-white shadow/);
  assert.doesNotMatch(tools, /shadow-\[0_8px_30px_rgba\(24,39,33,0\.035\)\]/);
  assert.match(tools, /group rounded-xl border border-\[var\(--color-border\)\] bg-white/);
});


test("Tools desktop sidebar keeps clear title-description hierarchy", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(tools, /xl:w-72/);
  assert.match(tools, /xl:whitespace-nowrap xl:text-sm xl:font-bold xl:leading-5/);
  assert.match(tools, /text-xs leading-4 text-\[var\(--color-text-muted\)\] xl:block/);
  assert.match(tools, /Remind leads who stop replying/);
  assert.match(tools, /Reply to comments and open DMs/);
  assert.match(tools, /Assign new leads to Sales staff/);
  assert.doesNotMatch(tools, /bottom-3 left-0 top-3 hidden w-0\.5 rounded-full xl:block/);
  assert.match(tools, /\{enabled \? "On" : "Off"\}<\/span>/);
});


test("Tools save bars only occupy space while changes are pending", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");
  const distribution = read("portal-frontend/src/pages/LeadDistribution.jsx");

  assert.match(tools, /\{\(hasUnsavedChanges \|\| saving\) && \(/);
  assert.match(tools, /Saving changes…/);
  assert.doesNotMatch(tools, /All changes saved/);
  assert.doesNotMatch(tools, /Currently paused/);
  assert.doesNotMatch(tools, /Currently active/);

  assert.match(distribution, /\{\(hasUnsavedChanges \|\| saving\) && \(/);
  assert.match(distribution, /Saving routing…/);
  assert.doesNotMatch(distribution, /All routing changes saved/);
  assert.doesNotMatch(distribution, /Currently paused/);
  assert.doesNotMatch(distribution, /Currently active/);
});


test("Tools headers distinguish draft enable state from the saved live state", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");
  const distribution = read("portal-frontend/src/pages/LeadDistribution.jsx");

  assert.match(tools, /enabledStateChanged = enabled !== savedEnabled/);
  assert.match(tools, /"On after save"/);
  assert.match(tools, /"Off after save"/);
  assert.match(tools, /\{enabledLabel\}<\/span>/);

  assert.match(distribution, /enabledStateChanged = settings\.enabled !== savedEnabled/);
  assert.match(distribution, /"On after save"/);
  assert.match(distribution, /"Off after save"/);
  assert.match(distribution, /\{enabledLabel\}<\/span>/);
});
