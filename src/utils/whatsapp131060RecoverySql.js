"use strict";

// A verified 131060 first-contact recovery message is the only permissible
// outbound row between Meta's unreadable placeholder and a subsequently
// verified, readable CTWA first message. It has no customer meaning and
// must not block ad attribution. All other rows still block the exception.
function is131060RecoveryAssistantSql(messageAlias, initialAlias) {
  for (const alias of [messageAlias, initialAlias]) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias || "")))
      throw new TypeError("Invalid SQL alias");
  }
  return "(" + messageAlias + ".role='assistant' AND EXISTS (" +
    " SELECT 1 FROM inbound_outbound_attempts recovery_out" +
    " WHERE recovery_out.assistant_message_id=" + messageAlias + ".id" +
    " AND recovery_out.inbound_message_id=" + initialAlias + ".id" +
    " AND recovery_out.contact_id=" + initialAlias + ".contact_id" +
    " AND recovery_out.origin='system_fallback'" +
    "))";
}

module.exports = { is131060RecoveryAssistantSql };
