// Normal follow-up anchors must have a provider-assigned message identifier.
// Saving a staff draft is not proof Meta accepted delivery. The provider-ID
// check also supports WhatsApp Business App / Meta echoes (NULL status) and
// WhatsApp-accepted pending sends without relying on a later receipt.
// Never treat unknown, failed or cancelled delivery as acceptance.
function acceptedNormalOutboundSql(alias = "anchor") {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) {
    throw new TypeError("Invalid SQL normal-outbound alias");
  }
  return `(${alias}.whatsapp_message_id IS NOT NULL
    AND (${alias}.delivery_status IS NULL
      OR ${alias}.delivery_status IN ('pending', 'sent', 'delivered', 'read')))`;
}

module.exports = { acceptedNormalOutboundSql };
