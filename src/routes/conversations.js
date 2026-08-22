const express = require("express");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");

const router = express.Router();

// GET /api/conversations — list every conversation, most recently active first.
router.get("/", async (req, res) => {
  try {
    const conversations = await contactsRepo.listConversations();
    res.json(conversations);
  } catch (err) {
    console.error("Failed to list conversations:", err);
    res.status(500).json({ error: "Something went wrong loading conversations." });
  }
});

// GET /api/conversations/:contactId/messages — full thread for one contact.
router.get("/:contactId/messages", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const messages = await messagesRepo.getMessagesForContact(contact.id, 500);
    res.json({ contact, messages });
  } catch (err) {
    console.error("Failed to load conversation thread:", err);
    res.status(500).json({ error: "Something went wrong loading the conversation." });
  }
});

module.exports = router;
