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
  assert.match(route, /consentOptInAt/);
  assert.match(route, /expectedOptInAt/);
  assert.match(route, /forceRefresh/);
  assert.match(route, /resolveApprovedTemplate[\s\S]*\{ force: true \}/);
  assert.match(route, /templateSignature/);
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
  assert.match(service, /format === "IMAGE" \|\| format === "VIDEO"/);
  assert.match(service, /\[format\.toLowerCase\(\)\]: \{ id:/);
  assert.match(route, /handleTemplateMediaUpload/);
  assert.match(route, /ensureWhatsAppCompatible: true/);
  assert.match(route, /mediaStorage\.uploadReusableTemplateMedia\(/);
  assert.match(route, /whatsapp\.uploadMedia\(buffer, mediaMimeType/);
  assert.match(route, /mediaKey,/);
  assert.match(api, /form\.append\("media", mediaFile\)/);
  assert.match(modal, /type="file"/);
  assert.match(modal, /mediaFileValid/);

  assert.match(api, /listWhatsAppTemplates/);
  assert.match(api, /refresh=true/);
  assert.match(api, /recordWhatsAppOptIn/);
  assert.match(api, /sendWhatsAppTemplate/);
  assert.match(inbox, /Send WhatsApp template/);
  assert.match(inbox, /canReplyToLeads/);
  assert.match(inbox, /delivery_status === "unknown"/);
  assert.match(inbox, /delivery is unconfirmed/);
  assert.match(inbox, /whatsapp_template\.name/);
  assert.match(modal, /AI, scheduled messages and automated follow-ups do not use this template path/);
  assert.match(modal, /Do not use this to bypass an opt-out/);
  assert.match(modal, /explicitly agreed to receive WhatsApp messages/);
  assert.match(modal, /consent covers WhatsApp marketing/);
  assert.match(modal, /marketingReconsentNeeded/);
  assert.match(modal, /opted out of WhatsApp marketing/);
  assert.match(modal, /loadCatalog\(true\)/);
  assert.match(route, /billingAdvisory/);
  assert.match(route, /getTemplateBillingAdvisory/);
  assert.match(route, /validateBillingAcknowledgment/);
  assert.match(route, /billingEvidenceAtSend/);
  assert.match(api, /billingReviewToken/);
  assert.match(api, /billingAcknowledged/);
  assert.match(modal, /billing_review_expired|billing_/);
  assert.match(modal, /recent_billable_message/);
  assert.match(modal, /billingReviewToken/);
  assert.match(modal, /billingAcknowledged/);
  assert.match(modal, /Meta billing.*this template may cost money/);
  assert.match(modal, /I understand Meta may charge for this manual template send/);
  assert.match(inbox, /initialTemplate=\{whatsappTemplatePrefill\}/);
  assert.match(route, /template_retry_requires_billing_review/);
  // Template retries must stop before provider upload; non-template retries still use policy gating.
  assert.match(route, /if \(message\.whatsapp_template\) \{/);
  assert.doesNotMatch(route, /const rebuiltTemplate =/);
  assert.doesNotMatch(route, /const retryFormat =/);
  assert.match(route, /const retryPurpose =/);
  assert.match(route, /sendStoredMessage\(activeContact, message/);
  assert.match(route, /Check WhatsApp delivery before reviewing a new template send/);
  assert.match(inbox, /Review & send new template/);
  assert.doesNotMatch(inbox, /You can retry it from the message/);
  assert.match(modal, /initialTemplateKey/);
  assert.match(modal, /originalTemplate \|\| firstSendable/);
  assert.match(modal, /No prior attachment or values are reused automatically/);
  assert.match(modal, /await loadCatalog\(\);/);

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
