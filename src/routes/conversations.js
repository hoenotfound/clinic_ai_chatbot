const express = require("express");
const multer = require("multer");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const conversationStore = require("../utils/conversationStore");
const whatsapp = require("../services/whatsappService");

const router = express.Router();

// Staff image uploads from the Inbox — kept in memory (never written to
// disk) since we immediately forward the bytes to WhatsApp and to Postgres.
// 16MB matches WhatsApp Cloud API's own image size limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

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

// POST /api/conversations/:contactId/media — staff uploads an image file
// from their computer and sends it as a WhatsApp image message. Same
// implicit-takeover behavior as the text-send route above. multipart/form-data
// with a single "image" file field and an optional "caption" text field.
router.post("/:contactId/media", upload.single("image"), async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const caption = (req.body?.caption || "").trim();

    // Implicit takeover — same as the text-send route.
    if (contact.mode !== "human") {
      await contactsRepo.takeOver(contact.id, req.session.username);
    } else {
      await contactsRepo.setAttention(contact.id, false);
    }

    // Upload the bytes to WhatsApp first to get a media ID, then send the
    // actual message referencing it — no public hosting needed for
    // one-off staff uploads (contrast with the promo graphic, which is
    // sent by public link — see whatsappService.sendImage).
    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype);
    if (!mediaId) {
      return res.status(502).json({ error: "Failed to upload image to WhatsApp. Please try again." });
    }

    const delivered = await whatsapp.sendImageById(contact.whatsapp_number, mediaId, caption || undefined);

    // Persist it either way (even if delivery failed) so it's never lost
    // from the thread, same reasoning as the text-send route. Stored as
    // base64 — same field the Inbox already renders for patient-sent
    // photos and for the promo graphic's media_url case.
    const saved = await conversationStore.appendMessage(
      contact.whatsapp_number,
      "assistant",
      caption,
      null,
      req.session.username,
      null,
      { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") }
    );

    res.status(201).json({ ...saved, delivered });
  } catch (err) {
    console.error("Failed to send staff image:", err);
    if (err.message === "Only image files are allowed.") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Something went wrong sending this image." });
  }
});

module.exports = router;
