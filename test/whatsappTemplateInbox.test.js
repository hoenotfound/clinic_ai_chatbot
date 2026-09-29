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

  assert.match(route, /router\.get\("\/:contactId\/whatsapp-templates"/);
  assert.match(route, /router\.post\("\/:contactId\/whatsapp-opt-in"/);
  assert.match(route, /router\.post\("\/:contactId\/whatsapp-templates\/send"/);
  assert.match(route, /whatsappPolicy\.checkTemplateAllowed\(contact\)/);
  assert.match(route, /whatsappTemplate\.resolveApprovedTemplate/);
  assert.match(route, /whatsappTemplate\.buildTemplateComponents/);
  assert.match(route, /opt_in_confirmation_required/);
  assert.match(route, /marketing_consent_confirmation_required/);
  assert.match(route, /whatsappTemplate: metadata/);
  assert.match(route, /if \(message\.whatsapp_template\)/);
  assert.match(route, /sendApprovedTemplate\(contact/);

  assert.match(service, /\/message_templates/);
  assert.match(service, /status === "APPROVED"/);
  assert.match(service, /category.*AUTHENTICATION/);
  assert.match(service, /Dynamic URL button variables/);

  assert.match(api, /listWhatsAppTemplates/);
  assert.match(api, /recordWhatsAppOptIn/);
  assert.match(api, /sendWhatsAppTemplate/);
  assert.match(inbox, /Send WhatsApp template/);
  assert.match(inbox, /whatsapp_template\.name/);
  assert.match(modal, /AI, scheduled messages and automated follow-ups do not use this template path/);
  assert.match(modal, /Do not use this to bypass an opt-out/);
  assert.match(modal, /explicitly agreed to receive WhatsApp messages/);
  assert.match(modal, /consent covers WhatsApp marketing/);
});

test("WhatsApp template message metadata uses a forward migration instead of editing baseline schema", () => {
  const migration = read("src/db/migrations/023_whatsapp_template_messages.sql");
  const messagesRepo = read("src/db/messagesRepo.js");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS whatsapp_template JSONB/);
  assert.match(messagesRepo, /whatsapp_template/);
  assert.match(messagesRepo, /options\?\.whatsappTemplate/);
});
