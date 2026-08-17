const express = require("express");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");

const router = express.Router();

// GET /api/conversations — list every conversation, most recently active first.
router.get("/", (req, res) => {
  const conversations = contactsRepo.listConversations();
  res.json(conversations);
});

// GET /api/conversations/:contactId/messages — full thread for one contact.
router.get("/:contactId/messages", (req, res) => {
  const contact = contactsRepo.getContactById(req.params.contactId);
  if (!contact) return res.status(404).json({ error: "Contact not found." });

  const messages = messagesRepo.getMessagesForContact(contact.id, 500);
  res.json({ contact, messages });
});

module.exports = router;
