const express = require("express");
const contactsRepo = require("../db/contactsRepo");
const contactNotesRepo = require("../db/contactNotesRepo");
const contactInsightsRepo = require("../db/contactInsightsRepo");

const router = express.Router();

// Postgres' unique_violation code — thrown when a WhatsApp number collides
// with an existing contact (see the UNIQUE constraint in schema.sql).
const UNIQUE_VIOLATION = "23505";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// A manually-entered WhatsApp number needs at least a plausible number of
// digits once non-digit characters are stripped — loose on purpose (staff
// may paste a number in any format: spaces, dashes, a leading "+", etc.),
// just enough to catch an empty or obviously-wrong value before it's saved.
function isPlausibleWhatsappNumber(v) {
  return isNonEmptyString(v) && contactsRepo.normalizeWhatsappNumber(v).length >= 8;
}

// GET /api/contacts?search=... — the full patient directory.
router.get("/", async (req, res) => {
  try {
    const contacts = await contactsRepo.listContacts(req.query.search);
    res.json(contacts);
  } catch (err) {
    console.error("Failed to list contacts:", err);
    res.status(500).json({ error: "Something went wrong loading contacts." });
  }
});

// GET /api/contacts/:id/insights — the latest lead state plus the structured
// AI conversation summary. This is read on demand so Inbox/contact list calls
// stay lightweight and opening the panel never triggers another AI request.
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

// GET /api/contacts/:id — one contact's profile.
router.get("/:id", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    res.json(contact);
  } catch (err) {
    console.error("Failed to load contact:", err);
    res.status(500).json({ error: "Something went wrong loading this contact." });
  }
});

// POST /api/contacts — staff manually adds a patient who hasn't messaged in yet.
router.post("/", async (req, res) => {
  try {
    const { name, whatsappNumber } = req.body || {};
    if (!isPlausibleWhatsappNumber(whatsappNumber)) {
      return res.status(400).json({ error: "A valid WhatsApp number is required." });
    }

    const contact = await contactsRepo.createContact({ name: name?.trim(), whatsappNumber });
    res.status(201).json(contact);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "That WhatsApp number is already linked to another contact." });
    }
    console.error("Failed to create contact:", err);
    res.status(500).json({ error: "Something went wrong adding this contact." });
  }
});

// PATCH /api/contacts/:id — edit a contact's name and/or WhatsApp number.
router.patch("/:id", async (req, res) => {
  try {
    const existing = await contactsRepo.getContactById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Contact not found." });

    const { name, whatsappNumber } = req.body || {};
    if (!isPlausibleWhatsappNumber(whatsappNumber)) {
      return res.status(400).json({ error: "A valid WhatsApp number is required." });
    }

    const updated = await contactsRepo.updateContact(existing.id, { name: name?.trim(), whatsappNumber });
    res.json(updated);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "That WhatsApp number is already linked to another contact." });
    }
    console.error("Failed to update contact:", err);
    res.status(500).json({ error: "Something went wrong saving this contact." });
  }
});

// GET /api/contacts/:id/notes — staff notes for one contact.
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

// POST /api/contacts/:id/notes — add a note. Author is always the logged-in
// staff member, never taken from the request body.
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

// DELETE /api/contacts/:id/notes/:noteId
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
