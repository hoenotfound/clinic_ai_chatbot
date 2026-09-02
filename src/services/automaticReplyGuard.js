const contactsRepo = require("../db/contactsRepo");

/**
 * Re-checks the latest conversation owner immediately before any automatic
 * outbound reply. Media downloads, transcription, and AI generation can take
 * long enough for a staff member to take over while processing is in flight.
 * In that case the automatic reply must fail closed and leave the patient for
 * staff to answer.
 */
async function getAiOwnedContact(
  contact,
  { channel = "whatsapp", from = null, reason = "automated reply" } = {}
) {
  if (!contact?.id) {
    throw new Error("Cannot verify automatic-reply ownership without a contact id.");
  }

  const latest = await contactsRepo.getContactById(contact.id);
  if (!latest) {
    throw new Error(`Contact ${contact.id} disappeared before ${reason}.`);
  }

  if (latest.mode === "human") {
    const target = from ? `${channel}:${from}` : `${channel}:contact-${contact.id}`;
    console.log(`Skipping ${reason} for ${target} — conversation is in human mode.`);
    return null;
  }

  return latest;
}

module.exports = { getAiOwnedContact };
