const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Inbox WhatsApp template flow stays staff-only and policy-gated", () => {
  const route = read("src/routes/conversations.js");
  const service = read("src/services/whatsappTemplateService.js");
  const api = read("portal-frontend/src/api.js");
  const inbox = read("portal-frontend/src/pages/Inbox.jsx");
  const modal = read("portal-frontend/src/components/WhatsAppTemplateModal.jsx");
  const requireAuth = read("src/middleware/requireAuth.js");

  assert.match(route, /router\.get\("\/:contactId\/whatsapp-templates"/);
  assert.match(route, /router\.post\("\/:contactId\/whatsapp-opt-in"/);
  assert.match(route, /router\.post\("\/:contactId\/whatsapp-templates\/send"/);
  assert.match(route, /whatsappPolicy\.checkTemplateAllowed\(contact\)/);
  assert.match(route, /whatsappTemplate\.resolveApprovedTemplate/);
  assert.match(route, /whatsappTemplate\.buildTemplateComponents/);
  assert.match(route, /opt_in_confirmation_required/);
  assert.match(route, /marketing_consent_confirmation_required/);
  assert.match(route, /marketing_opted_out/);
  assert.match(route, /recordMarketingOptIn/);
  assert.match(route, /templateCategory/);
  assert.match(route, /whatsappTemplate: metadata/);
  assert.match(route, /if \(message\.whatsapp_template\)/);
  assert.match(route, /currentTemplate\.template\.category === "MARKETING"/);
  assert.match(route, /message\.whatsapp_template\.marketingConsentConfirmed !== true/);
  assert.match(route, /consentOptInAt/);
  assert.match(route, /marketing_consent_reconfirmation_required/);
  assert.match(route, /expectedOptInAt/);
  assert.match(route, /forceRefresh/);
  assert.match(route, /resolveApprovedTemplate[\s\S]*\{ force: true \}/);
  assert.match(route, /templateSignature/);
  assert.match(route, /template_definition_changed/);
  assert.match(route, /rebuiltTemplate\.components/);
  assert.match(route, /sendResult\.unknown === true/);
  assert.match(route, /initialDeliveryStatus: "unknown"/);
  assert.match(route, /publish: false/);
  assert.match(route, /sendApprovedTemplate\((?:preparedContact|activeContact)/);

  assert.match(requireAuth, /action === "whatsapp-opt-in"/);
  assert.match(requireAuth, /action === "whatsapp-templates" && subAction === "send"/);
  assert.match(requireAuth, /reply_to_assigned_leads/);

  assert.match(service, /\/message_templates/);
  assert.match(service, /status === "APPROVED"/);
  assert.match(service, /category.*AUTHENTICATION/);
  assert.match(service, /Dynamic URL button variables/);

  assert.match(api, /listWhatsAppTemplates/);
  assert.match(api, /refresh=true/);
  assert.match(api, /recordWhatsAppOptIn/);
  assert.match(api, /sendWhatsAppTemplate/);
  assert.match(inbox, /Send WhatsApp template/);
  assert.match(inbox, /canReplyToLeads/);
  assert.match(inbox, /delivery_status === "unknown"/);
  assert.match(inbox, /delivery could not be confirmed/);
  assert.match(inbox, /whatsapp_template\.name/);
  assert.match(modal, /AI, scheduled messages and automated follow-ups do not use this template path/);
  assert.match(modal, /Do not use this to bypass an opt-out/);
  assert.match(modal, /explicitly agreed to receive WhatsApp messages/);
  assert.match(modal, /consent covers WhatsApp marketing/);
  assert.match(modal, /marketingReconsentNeeded/);
  assert.match(modal, /opted out of WhatsApp marketing/);
  assert.match(modal, /loadCatalog\(true\)/);
});

test("WhatsApp template and marketing consent state use forward migrations instead of editing baseline schema", () => {
  const templateMigration = read("src/db/migrations/023_whatsapp_template_messages.sql");
  const marketingOptOutMigration = read("src/db/migrations/024_whatsapp_marketing_opt_out.sql");
  const messagesRepo = read("src/db/messagesRepo.js");

  assert.match(templateMigration, /ADD COLUMN IF NOT EXISTS whatsapp_template JSONB/);
  assert.match(marketingOptOutMigration, /whatsapp_marketing_opt_out_at/);
  assert.match(marketingOptOutMigration, /whatsapp_marketing_opt_out_source/);
  assert.match(messagesRepo, /whatsapp_template/);
  assert.match(messagesRepo, /options\?\.whatsappTemplate/);
});
