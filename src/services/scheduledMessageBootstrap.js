require("dotenv").config();

const conversationsRouter = require("../routes/conversations");
const contactsRepo = require("../db/contactsRepo");
const scheduledRepo = require("../db/scheduledMessageRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { startScheduledMessages, scheduleValidation } = require("./scheduledMessageService");

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validationError(code, windowEndsAt) {
  const suffix = windowEndsAt ? ` Reply window ends ${windowEndsAt.toISOString()}.` : "";
  const messages = {
    invalid_time: "Choose a valid date and time.",
    no_customer_message: "This customer has not sent a message yet, so a reply window is not available.",
    not_future: "Scheduled time must be in the future.",
    outside_window: `Scheduled time must stay inside the 24-hour customer reply window.${suffix}`,
  };
  return messages[code] || "This scheduled time is not allowed.";
}

function publishScheduleChange(contactId) {
  realtimeEvents.publish("conversation_changed", {
    contactId,
    reason: "scheduled_message",
  });
}

function requireStaffMode(contact, res) {
  if (contact.mode === "human") return true;
  res.status(409).json({
    error: "Take over this conversation before scheduling a staff message.",
    code: "staff_mode_required",
  });
  return false;
}

async function buildWindow(contactId) {
  const latestInboundAt = await scheduledRepo.getLatestInboundAt(contactId);
  const probe = scheduleValidation({
    scheduledFor: new Date(Date.now() + 60 * 1000),
    lastInboundAt: latestInboundAt,
  });
  return {
    lastInboundAt,
    windowEndsAt: probe.windowEndsAt,
  };
}

conversationsRouter.get("/:contactId/scheduled-messages", async (req, res) => {
  try {
    const contactId = positiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });
    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const [items, window] = await Promise.all([
      scheduledRepo.listForContact(contactId),
      buildWindow(contactId),
    ]);
    res.json({
      items,
      lastInboundAt: window.lastInboundAt,
      windowEndsAt: window.windowEndsAt,
      staffMode: contact.mode === "human",
    });
  } catch (err) {
    console.error("Failed to list scheduled messages:", err);
    res.status(500).json({ error: "Something went wrong loading scheduled messages." });
  }
});

conversationsRouter.post("/:contactId/scheduled-messages", async (req, res) => {
  try {
    const contactId = positiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });
    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if (!requireStaffMode(contact, res)) return;

    const content = String(req.body?.content || "").trim();
    if (!content) return res.status(400).json({ error: "Message text is required." });
    if (content.length > 4096) {
      return res.status(400).json({ error: "Scheduled message is too long." });
    }

    const lastInboundAt = await scheduledRepo.getLatestInboundAt(contactId);
    const validation = scheduleValidation({
      scheduledFor: req.body?.scheduledFor,
      lastInboundAt,
    });
    if (!validation.valid) {
      return res.status(400).json({
        error: validationError(validation.code, validation.windowEndsAt),
        code: validation.code,
        windowEndsAt: validation.windowEndsAt,
      });
    }

    const item = await scheduledRepo.create({
      contactId,
      content,
      scheduledFor: new Date(req.body.scheduledFor),
      username: req.session.username,
    });
    publishScheduleChange(contactId);
    res.status(201).json({ item, windowEndsAt: validation.windowEndsAt });
  } catch (err) {
    console.error("Failed to create scheduled message:", err);
    res.status(500).json({ error: "Something went wrong scheduling this message." });
  }
});

conversationsRouter.patch("/:contactId/scheduled-messages/:scheduledId", async (req, res) => {
  try {
    const contactId = positiveInt(req.params.contactId);
    const scheduledId = positiveInt(req.params.scheduledId);
    if (!contactId || !scheduledId) {
      return res.status(400).json({ error: "Invalid contact or scheduled message id." });
    }
    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if (!requireStaffMode(contact, res)) return;

    const content = String(req.body?.content || "").trim();
    if (!content) return res.status(400).json({ error: "Message text is required." });
    if (content.length > 4096) {
      return res.status(400).json({ error: "Scheduled message is too long." });
    }

    const lastInboundAt = await scheduledRepo.getLatestInboundAt(contactId);
    const validation = scheduleValidation({
      scheduledFor: req.body?.scheduledFor,
      lastInboundAt,
    });
    if (!validation.valid) {
      return res.status(400).json({
        error: validationError(validation.code, validation.windowEndsAt),
        code: validation.code,
        windowEndsAt: validation.windowEndsAt,
      });
    }

    const item = await scheduledRepo.updateScheduled({
      id: scheduledId,
      contactId,
      content,
      scheduledFor: new Date(req.body.scheduledFor),
    });
    if (!item) {
      return res.status(409).json({ error: "Only pending scheduled messages can be edited." });
    }
    publishScheduleChange(contactId);
    res.json({ item, windowEndsAt: validation.windowEndsAt });
  } catch (err) {
    console.error("Failed to update scheduled message:", err);
    res.status(500).json({ error: "Something went wrong updating this scheduled message." });
  }
});

conversationsRouter.delete("/:contactId/scheduled-messages/:scheduledId", async (req, res) => {
  try {
    const contactId = positiveInt(req.params.contactId);
    const scheduledId = positiveInt(req.params.scheduledId);
    if (!contactId || !scheduledId) {
      return res.status(400).json({ error: "Invalid contact or scheduled message id." });
    }

    const item = await scheduledRepo.cancel(scheduledId, contactId);
    if (!item) {
      return res.status(409).json({ error: "Only pending scheduled messages can be cancelled." });
    }
    publishScheduleChange(contactId);
    res.json({ item });
  } catch (err) {
    console.error("Failed to cancel scheduled message:", err);
    res.status(500).json({ error: "Something went wrong cancelling this scheduled message." });
  }
});

let schedulerStarted = false;

async function startSchedulerWhenSchemaIsReady() {
  if (schedulerStarted) return;
  try {
    // The preload runs before server.js calls initSchema(). Wait until the base
    // contacts/messages tables exist, then create this feature's table once and
    // start the worker. If the database is still booting, retry without
    // crashing or delaying the main chatbot server.
    await scheduledRepo.ensureSchema();
    if (schedulerStarted) return;
    schedulerStarted = true;
    startScheduledMessages();
  } catch (err) {
    console.warn("Scheduled-message worker is waiting for database schema:", err?.message || err);
    const retryTimer = setTimeout(startSchedulerWhenSchemaIsReady, 5000);
    retryTimer.unref?.();
  }
}

const startTimer = setTimeout(startSchedulerWhenSchemaIsReady, 1000);
startTimer.unref?.();