const express = require("express");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const conversationStore = require("../utils/conversationStore");
const whatsapp = require("../services/whatsappService");

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

// POST /api/conversations/:contactId/takeover — staff explicitly takes
// ownership: AI stops auto-replying to this contact until "Return to AI".
router.post("/:contactId/takeover", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const updated = await contactsRepo.takeOver(contact.id, req.session.username);
    res.json(updated);
  } catch (err) {
    console.error("Failed to take over conversation:", err);
    res.status(500).json({ error: "Something went wrong taking over this conversation." });
  }
});

// POST /api/conversations/:contactId/return-to-ai — hands the conversation
// back to the bot for future inbound messages.
router.post("/:contactId/return-to-ai", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const updated = await contactsRepo.returnToAi(contact.id);
    res.json(updated);
  } catch (err) {
    console.error("Failed to return conversation to AI:", err);
    res.status(500).json({ error: "Something went wrong returning this conversation to the AI." });
  }
});

// PATCH /api/conversations/:contactId/attention — manually flag or dismiss
// the "needs a human" indicator without necessarily taking over.
router.patch("/:contactId/attention", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { needsAttention, reason } = req.body || {};
    if (typeof needsAttention !== "boolean") {
      return res.status(400).json({ error: "needsAttention (boolean) is required." });
    }

    const updated = await contactsRepo.setAttention(
      contact.id,
      needsAttention,
      needsAttention ? reason || "Flagged by staff." : null
    );
    res.json(updated);
  } catch (err) {
    console.error("Failed to update attention flag:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

// POST /api/conversations/:contactId/messages — staff sends a WhatsApp
// message directly from the Inbox. Implicitly takes over the conversation
// (mode -> 'human') so the AI doesn't reply on top of a staff member.
router.post("/:contactId/messages", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message text is required." });
    }

    // Implicit takeover — sending a message means staff now owns this
    // conversation, whether or not they clicked "Take Over" first.
    if (contact.mode !== "human") {
      await contactsRepo.takeOver(contact.id, req.session.username);
    } else {
      // Already staff-owned — sending a reply resolves the "needs
      // attention" flag (they're actively handling it now).
      await contactsRepo.setAttention(contact.id, false);
    }

    const saved = await conversationStore.appendMessage(
      contact.whatsapp_number,
      "assistant",
      text.trim(),
      null,
      req.session.username
    );

    // Message is already saved (so it's never lost from the thread even if
    // WhatsApp delivery fails), but we still tell the caller if the actual
    // send failed so staff know to retry rather than assuming it went out.
    const delivered = await whatsapp.sendMessage(contact.whatsapp_number, text.trim());

    res.status(201).json({ ...saved, delivered });
  } catch (err) {
    console.error("Failed to send staff message:", err);
    res.status(500).json({ error: "Something went wrong sending this message." });
  }
});

module.exports = router;
