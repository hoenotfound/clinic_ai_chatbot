// Staff-portal alias only. Never use this label for sender identity or routing.
// Neutro's primary WhatsApp sender retains its existing Meta and database names.
export function inboxSenderDisplayName(contact) {
  if (contact?.channel === "whatsapp" && contact?.whatsapp_sender_key === "neutro") {
    return "DA";
  }
  return contact?.whatsapp_sender_display_name || "";
}
