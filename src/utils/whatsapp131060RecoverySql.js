"use strict";

// Only a provider-accepted 131060 recovery menu is neutral before a verified
// CTWA ad. The normal 24h inbound-job cleanup cascades outbound attempts,
// but independent accepted-send evidence can preserve the valid exception.
// An unaccepted draft, staff message or arbitrary system fallback is never
// treated as recovered first-contact customer intent.
function is131060RecoveryAssistantSql(messageAlias, initialAlias) {
  for (const alias of [messageAlias, initialAlias]) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias || "")))
      throw new TypeError("Invalid SQL alias");
  }
  return `(
  ${messageAlias}.role='assistant'
  AND ${messageAlias}.whatsapp_message_id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM inbound_outbound_attempts recovery_out
      WHERE recovery_out.assistant_message_id=${messageAlias}.id
        AND recovery_out.inbound_message_id=${initialAlias}.id
        AND recovery_out.contact_id=${initialAlias}.contact_id
        AND recovery_out.origin='system_fallback'
        AND recovery_out.outcome='accepted'
        AND recovery_out.provider_message_id=${messageAlias}.whatsapp_message_id
    )
    OR EXISTS (
      SELECT 1 FROM outbound_message_evidence accepted_menu
      WHERE accepted_menu.message_id=${messageAlias}.id
        AND accepted_menu.contact_id=${initialAlias}.contact_id
        AND accepted_menu.channel='whatsapp'
        AND accepted_menu.origin='system_fallback'
        AND accepted_menu.accepted=TRUE
        AND accepted_menu.provider_message_id=${messageAlias}.whatsapp_message_id
        AND ${initialAlias}.role='user'
        AND ${initialAlias}.content LIKE
          '📎 [% sent a WhatsApp message that could not be displayed]'
        AND ${messageAlias}.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
        AND ${messageAlias}.content LIKE '%可以点下面的选项%'
    )
  )
)`;
}

module.exports = { is131060RecoveryAssistantSql };
