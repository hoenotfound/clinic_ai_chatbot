const express = require("express");
const contactsRepo = require("../db/contactsRepo");
const contactNotesRepo = require("../db/contactNotesRepo");
const contactInsightsRepo = require("../db/contactInsightsRepo");
const pipelineRepo = require("../db/pipelineRepo");

const router = express.Router();
const SOCIAL_CHANNELS = new Set(["facebook", "instagram"]);

const UNIQUE_VIOLATION = "23505";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isPlausibleWhatsappNumber(v) {
  return isNonEmptyString(v) && contactsRepo.normalizeWhatsappNumber(v).length >= 8;
}

router.get("/", async (req, res) => {
  try {
    const contacts = await contactsRepo.listContacts(req.query.search);
    res.json(contacts);
  } catch (err) {
    console.error("Failed to list contacts:", err);
    res.status(500).json({ error: "Something went wrong loading contacts." });
  }
});

router.get("/:id/insights", async (req, res) => {
  try {
    const insights = await contactInsightsRepo.getContactInsights(req.params.id);
    if (!insights) return res.status(404).json({ error: "Contact not found." });
    res.json(insights);
  } catch (err) {
    console.error("Failed to load contact insights:", err);
    res.status(500).json({ error: "Something went wrong loading contact insights." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    res.json(contactsRepo.presentPortalContact(contact));
  } catch (err) {
    console.error("Failed to load contact:", err);
    res.status(500).json({ error: "Something went wrong loading this contact." });
  }
});

// Restricted staff who are explicitly allowed to create contacts immediately
// receive an owned pipeline lead for that contact. Without this, the contact
// would disappear from their assigned-only directory as soon as the list
// refreshes. Full-access admins keep the historical contact-only behavior.
router.post("/", async (req, res) => {
  try {
    const { name, whatsappNumber } = req.body || {};
    if (!isPlausibleWhatsappNumber(whatsappNumber)) {
      return res.status(400).json({ error: "A valid WhatsApp number is required." });
    }

    const contact = await contactsRepo.createContact({ name: name?.trim(), whatsappNumber });
    if (req.user?.permissions?.view_all_leads !== true) {
      await pipelineRepo.createLead(
        { contactId: contact.id, ownerUsername: req.user.username },
        req.user.username
      );
    }
    res.status(201).json(contact);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "That WhatsApp number is already linked to another contact." });
    }
    console.error("Failed to create contact:", err);
    res.status(500).json({ error: "Something went wrong adding this contact." });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await contactsRepo.getContactById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Contact not found." });

    const { name, whatsappNumber } = req.body || {};

    if (SOCIAL_CHANNELS.has(existing.channel)) {
      if (whatsappNumber !== undefined) {
        return res.status(400).json({
          error: "Facebook and Instagram account identifiers can't be edited manually.",
        });
      }

      const updated = await contactsRepo.updateContactName(
        existing.id,
        name?.trim() || null
      );
      return res.json(contactsRepo.presentPortalContact(updated));
    }

    if (!isPlausibleWhatsappNumber(whatsappNumber)) {
      return res.status(400).json({ error: "A valid WhatsApp number is required." });
    }

    const updated = await contactsRepo.updateContact(existing.id, {
      name: name?.trim(),
      whatsappNumber,
    });
    res.json(updated);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "That WhatsApp number is already linked to another contact." });
    }
    console.error("Failed to update contact:", err);
    res.status(500).json({ error: "Something went wrong saving this contact." });
  }
});

router.get("/:id/notes", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const notes = await contactNotesRepo.listNotes(contact.id);
    res.json(notes);
  } catch (err) {
    console.error("Failed to load contact notes:", err);
    res.status(500).json({ error: "Something went wrong loading notes." });
  }
});

router.post("/:id/notes", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { content } = req.body || {};
    if (!isNonEmptyString(content)) {
      return res.status(400).json({ error: "Note can't be empty." });
    }

    const note = await contactNotesRepo.addNote(contact.id, req.session.username, content.trim());
    res.status(201).json(note);
  } catch (err) {
    console.error("Failed to add contact note:", err);
    res.status(500).json({ error: "Something went wrong saving this note." });
  }
});

router.delete("/:id/notes/:noteId", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    await contactNotesRepo.deleteNote(contact.id, req.params.noteId);
    res.status(204).end();
  } catch (err) {
    console.error("Failed to delete contact note:", err);
    res.status(500).json({ error: "Something went wrong deleting this note." });
  }
});

module.exports = router;
