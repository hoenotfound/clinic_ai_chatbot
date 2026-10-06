const express = require("express");
const multer = require("multer");
const { pipeline } = require("node:stream/promises");
const { canAccessContact } = require("../utils/accessControl");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const pipelineRepo = require("../db/pipelineRepo");
const leadAttributionRepo = require("../db/leadAttributionRepo");
const telegramImmediateAlertRepo = require("../db/telegramImmediateAlertRepo");
const conversationStore = require("../utils/conversationStore");
const realtimeEvents = require("../utils/realtimeEvents");
const whatsapp = require("../services/whatsappService");
const channelMessaging = require("../services/channelMessagingService");
const mediaStorage = require("../services/mediaStorageService");
const { convertToWhatsAppVoice } = require("../services/audioConvertService");
const { transcribeStaffAudio } = require("../services/transcriptionService");
const whatsappPolicy = require("../services/whatsappPolicyService");
const whatsappTemplate = require("../services/whatsappTemplateService");
const aiReplyCancellation = require("../services/aiReplyCancellationService");
const { AI_HANDOFF_OWNER } = require("../services/aiHandoffService");
const { claimAiHandoffOwnership } = require("../services/staffOwnershipService");
const {
  hasPartialCaptionMarker,
  deliveryErrorForSend,
  publicDeliveryError,
} = require("../utils/socialDeliveryError");

const router = express.Router();
const STAFF_TRANSCRIPTION_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_INCREMENTAL_PAGE_SIZE = 100;
const SSE_HEARTBEAT_MS = 25 * 1000;
const SEND_REJECTED_ERROR =
  "WhatsApp did not accept this message. Check the reply window or connection and try again.";
const MAX_DELIVERY_STATUS_IDS = 500;
const WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const WHATSAPP_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

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

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("audio/")) {
      return cb(new Error("Only audio recordings are allowed."));
    }
    cb(null, true);
  },
});

async function resolveWithin(promise, timeoutMs, fallbackValue) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallbackValue),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parsePositiveInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}

async function resolveReplyTarget(contact, rawMessageId, res) {
  if (rawMessageId == null || rawMessageId === "") {
    return { ok: true, target: null };
  }

  const messageId = parsePositiveInt(rawMessageId);
  if (!messageId) {
    res.status(400).json({ error: "Invalid reply message id." });
    return { ok: false, target: null };
  }

  if ((contact.channel || "whatsapp") !== "whatsapp") {
    res.status(400).json({
      error: "Quoted replies are currently available for WhatsApp conversations only.",
    });
    return { ok: false, target: null };
  }

  const target = await messagesRepo.getMessageForReplyContext(contact.id, messageId);
  if (!target) {
    res.status(404).json({ error: "The message you are replying to could not be found." });
    return { ok: false, target: null };
  }
  if (!target.whatsapp_message_id) {
    res.status(409).json({ error: "That message is not available to quote on WhatsApp yet." });
    return { ok: false, target: null };
  }

  const targetDeliveryStatus = String(target.delivery_status || "").toLowerCase();
  if (
    target.role !== "user" &&
    ["failed", "unknown"].includes(targetDeliveryStatus)
  ) {
    res.status(409).json({
      error:
        "That outbound message was not confirmed delivered, so it cannot be used as a WhatsApp quote.",
    });
    return { ok: false, target: null };
  }

  return { ok: true, target };
}

function normalizeSingleByteRange(value) {
  if (!value) return { valid: true, range: null };

  const range = String(value).trim();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    return { valid: false, range: null };
  }

  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if (
    (start !== null && (!Number.isSafeInteger(start) || start < 0)) ||
    (end !== null && (!Number.isSafeInteger(end) || end < 0)) ||
    (start !== null && end !== null && end < start) ||
    (start === null && end === 0)
  ) {
    return { valid: false, range: null };
  }

  return { valid: true, range };
}

function publishDeliveryStatus(message) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason: "delivery_status",
  });
}

function rejectedErrorFor(contact) {
  return channelMessaging.rejectedError(contact?.channel || "whatsapp");
}


async function requireFreeformPolicy(contact, res, purpose = "service") {
  try {
    const policy = await whatsappPolicy.checkFreeformAllowed(contact, new Date(), {
      purpose,
    });
    if (policy.allowed) return true;

    res.status(403).json({
      error: policy.message,
      code: policy.code,
      policyBlocked: true,
    });
    return false;
  } catch (err) {
    const label = channelMessaging.labelForChannel(contact?.channel || "whatsapp");
    console.error(`Failed to pre-check ${label} messaging policy:`, err);
    res.status(503).json({
      error: `${label} messaging status could not be verified. Please try again shortly.`,
      code: "policy_state_unavailable",
      policyBlocked: true,
    });
    return false;
  }
}

async function prepareStaffSend(contact, username) {
  // Cancel immediately from the route snapshot, then refresh ownership before
  // making any durable Staff Assist decision. The route-level contact can be
  // stale after policy checks or media preparation.
  aiReplyCancellation.cancelForContact(contact);

  let preparedContact = await contactsRepo.getContactById(contact.id);
  if (!preparedContact) {
    throw new Error("Contact disappeared before the staff send could be prepared.");
  }
  aiReplyCancellation.cancelForContact(preparedContact);

  if (
    preparedContact.mode === "human" &&
    preparedContact.takeover_by === AI_HANDOFF_OWNER
  ) {
    const claimed = await claimAiHandoffOwnership(
      preparedContact.id,
      username
    );
    if (claimed) {
      preparedContact = claimed;
    } else {
      // Ownership may have changed while the claim was waiting on its DB lock.
      // Re-read once and only fail if the synthetic handoff still exists.
      const latest = await contactsRepo.getContactById(preparedContact.id);
      if (
        latest?.mode === "human" &&
        latest?.takeover_by === AI_HANDOFF_OWNER
      ) {
        throw new Error("AI handoff ownership could not be claimed safely.");
      }
      if (!latest) {
        throw new Error("Contact disappeared while claiming the AI handoff.");
      }
      preparedContact = latest;
    }
  }

  return preparedContact;
}

async function finalizeStaffSendState(contactId, username) {
  let latest = await contactsRepo.getContactById(contactId);
  if (!latest) return null;

  // Catch a synthetic handoff that began after prepareStaffSend() but before
  // the staff-authored row was persisted.
  if (
    latest.mode === "human" &&
    latest.takeover_by === AI_HANDOFF_OWNER
  ) {
    const claimed = await claimAiHandoffOwnership(latest.id, username);
    if (claimed) latest = claimed;
    else {
      latest = await contactsRepo.getContactById(contactId);
      if (!latest) return null;
    }
  }

  if (!latest.needs_attention && !latest.is_unread) return latest;

  const cleared = await contactsRepo.clearStaffAssistStateIfUnchanged(latest);
  if (cleared) return cleared;

  // A newer inbound message, safety handoff, or attention reason won the race.
  // Return the current state without clearing it.
  return await contactsRepo.getContactById(contactId) || latest;
}

async function persistSendOutcome(
  savedMessage,
  sendResult,
  errorText = SEND_REJECTED_ERROR,
  channel = "whatsapp"
) {
  let updated = null;
  if (sendResult.wamid) {
    updated = await messagesRepo.setWhatsappMessageId(savedMessage.id, sendResult.wamid);
  } else if (sendResult.externalMessageId && channel !== "whatsapp") {
    updated = await messagesRepo.setSocialProviderMessageId(
      savedMessage.id,
      `${channel}:${sendResult.externalMessageId}`,
      null
    );
  } else if (sendResult.unknown === true) {
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, "unknown", errorText);
  } else if (!sendResult.success) {
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, "failed", errorText);
  } else {
    // Facebook/Instagram accepted sends intentionally have no WhatsApp WAMID.
    // Keep their delivery state neutral instead of entering WhatsApp's async
    // sent/delivered/read status pipeline.
    updated = await messagesRepo.setDeliveryStatusById(savedMessage.id, null, null);
  }
  publishDeliveryStatus(updated);
  return updated || savedMessage;
}

async function markLeadContacted(contactId, actor, sendResult) {
  if (!sendResult?.success) return;
  try {
    await pipelineRepo.markContactedForContact(contactId, actor);
  } catch (err) {
    // A pipeline update must never change the result of a successful send.
    console.error(`Failed to mark lead ${contactId} as contacted:`, err);
  }
}

function socialProviderSendOptions(message, contact, options = {}) {
  const recorder = messagesRepo.socialProviderAliasRecorder(
    message?.id,
    contact?.channel
  );
  return recorder
    ? { ...options, onProviderMessageId: recorder }
    : options;
}

async function sendStoredMessage(contact, message, options = {}) {
  const mimeType = String(message.media_mime_type || "").toLowerCase();
  const channel = contact.channel || "whatsapp";
  const skipCaption = hasPartialCaptionMarker(message.delivery_error);
  if (message.reply_to_provider_message_id) {
    options = {
      ...options,
      replyToProviderMessageId: message.reply_to_provider_message_id,
    };
  }

  const storedSticker =
    mimeType === "image/webp" &&
    /(?:sent a sticker|forwarded sticker|sticker sent from)/i.test(
      String(message.content || "")
    );

  // Normal stored images can stay entirely inside R2. Create a disposable
  // provider-facing copy and let Meta fetch it instead of downloading the
  // permanent object into Render and uploading those bytes again.
  if (
    mimeType.startsWith("image/") &&
    !storedSticker &&
    message.media_key
  ) {
    try {
      const temporaryMedia = await mediaStorage.copyStoredMediaToTemporary(
        message.media_key,
        mimeType,
        {
          contactId: contact.id,
          expiresSeconds: 10 * 60,
        }
      );
      mediaStorage.scheduleTemporaryMediaDelete(temporaryMedia.key);
      return await channelMessaging.sendImageByUrl(
        contact,
        temporaryMedia.url,
        skipCaption ? undefined : (message.content || undefined),
        socialProviderSendOptions(message, contact, { ...options, skipCaption })
      );
    } catch (copyErr) {
      console.warn(
        `[Inbox stored image] R2 provider-copy fast path failed for contact ${contact.id}; falling back to buffered send:`,
        copyErr
      );
      const storedBuffer = await mediaStorage.downloadMedia(message.media_key);
      return channelMessaging.sendImageBuffer(
        contact,
        storedBuffer,
        mimeType,
        skipCaption ? undefined : (message.content || undefined),
        "image",
        socialProviderSendOptions(message, contact, { ...options, skipCaption })
      );
    }
  }

  // Voice notes and stickers need provider-specific upload semantics, so only
  // those uncommon stored media types are materialized into Render memory.
  if (
    message.media_key &&
    !message.media_base64 &&
    (mimeType.startsWith("audio/") || storedSticker)
  ) {
    const storedBuffer = await mediaStorage.downloadMedia(message.media_key);
    message = {
      ...message,
      media_base64: storedBuffer.toString("base64"),
    };
  }

  if (mimeType.startsWith("audio/") && message.media_base64) {
    const storedBuffer = Buffer.from(message.media_base64, "base64");
    if (channel === "whatsapp") {
      const converted = await convertToWhatsAppVoice(storedBuffer, mimeType);
      if (!converted) {
        return { success: false, wamid: null, error: "The saved voice recording could not be processed." };
      }
      return channelMessaging.sendAudioBuffer(
        contact,
        converted.whatsapp.buffer,
        converted.whatsapp.mimeType,
        converted.whatsapp.filename,
        socialProviderSendOptions(message, contact, options)
      );
    }
    return channelMessaging.sendAudioBuffer(
      contact,
      storedBuffer,
      mimeType,
      "voice.mp3",
      socialProviderSendOptions(message, contact, options)
    );
  }

  if (storedSticker && message.media_base64 && channel === "whatsapp") {
    return channelMessaging.sendStickerBuffer(
      contact,
      Buffer.from(message.media_base64, "base64"),
      mimeType,
      "sticker.webp",
      socialProviderSendOptions(message, contact, options)
    );
  }

  if (mimeType.startsWith("image/") && message.media_base64) {
    return channelMessaging.sendImageBuffer(
      contact,
      Buffer.from(message.media_base64, "base64"),
      mimeType,
      skipCaption ? undefined : (message.content || undefined),
      "image",
      socialProviderSendOptions(message, contact, { ...options, skipCaption })
    );
  }

  if (message.media_url) {
    return channelMessaging.sendImageByUrl(
      contact,
      message.media_url,
      skipCaption ? undefined : (message.content || undefined),
      socialProviderSendOptions(message, contact, { ...options, skipCaption })
    );
  }

  if (message.content?.trim()) {
    return channelMessaging.sendText(
      contact,
      message.content.trim(),
      socialProviderSendOptions(message, contact, options)
    );
  }

  return { success: false, wamid: null, error: "This message has no retryable content." };
}

router.get("/", async (req, res) => {
  try {
    const conversations = await contactsRepo.listConversations();
    res.json(conversations);
  } catch (err) {
    console.error("Failed to list conversations:", err);
    res.status(500).json({ error: "Something went wrong loading conversations." });
  }
});

router.get("/:contactId/attribution", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const context = await leadAttributionRepo.getForContactCurrentLead(contactId);
    if (!context) return res.json({ lead: null, attribution: null });

    res.json({
      lead: {
        id: context.lead_id,
        contactId: context.contact_id,
        temperature: context.temperature || null,
        treatmentInterest: context.treatment_interest || null,
        appointmentStatus: context.appointment_status || null,
        estimatedValue: context.estimated_value == null ? null : Number(context.estimated_value),
        ownerUsername: context.owner_username || null,
        branchName: context.branch_name || null,
        stageName: context.stage_name || null,
        stageType: context.stage_type || null,
      },
      attribution: context.source ? {
        source: context.source,
        channel: context.attribution_channel || null,
        platform: context.platform || null,
        meta_ad_id: context.meta_ad_id || null,
        meta_account_id: context.meta_account_id || null,
        campaign_id: context.campaign_id || null,
        campaign_name: context.campaign_name || null,
        adset_id: context.adset_id || null,
        adset_name: context.adset_name || null,
        ad_name: context.ad_name || null,
        ctwa_clid: context.ctwa_clid || null,
        headline: context.headline || null,
        body: context.body || null,
        media_type: context.media_type || null,
        media_url: context.media_url || null,
        enrichment_status: context.enrichment_status || null,
        enriched_at: context.enriched_at || null,
        attributed_at: context.attributed_at || null,
      } : null,
    });
  } catch (err) {
    console.error("Failed to load conversation attribution:", err);
    res.status(500).json({ error: "Something went wrong loading acquisition details." });
  }
});

// Authenticated server-sent event stream for the Inbox. Events contain only
// tiny contact/message identifiers; the browser then asks for lightweight
// incremental data only when something actually changed. This replaces idle
// polling without putting message or media payloads on the SSE connection.
router.get("/events", (req, res) => {
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  const removeClient = realtimeEvents.addClient(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
      removeClient();
    }
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient();
  });
});

// Portal message history is cursor-paginated. The first request returns only
// the newest 50 messages. beforeId loads older history, while afterId fetches
// only messages newer than the browser's current cursor.
router.get("/:contactId/messages", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const beforeId = parsePositiveInt(req.query.beforeId);
    const afterId = parsePositiveInt(req.query.afterId);
    if (beforeId && afterId) {
      return res.status(400).json({ error: "Use beforeId or afterId, not both." });
    }

    const requestedLimit = parsePositiveInt(req.query.limit) || DEFAULT_MESSAGE_PAGE_SIZE;
    const limit = Math.min(
      requestedLimit,
      afterId ? MAX_INCREMENTAL_PAGE_SIZE : DEFAULT_MESSAGE_PAGE_SIZE
    );
    const includeMedia = req.query.includeMedia === "true";

    const page = await messagesRepo.getMessagePageForContact(contactId, {
      limit,
      beforeId,
      afterId,
      includeMedia,
    });

    res.json({
      messages: page.rows,
      hasMore: page.hasMore,
      oldestId: page.rows[0]?.id || null,
      newestId: page.rows[page.rows.length - 1]?.id || null,
    });
  } catch (err) {
    console.error("Failed to load conversation thread:", err);
    res.status(500).json({ error: "Something went wrong loading the conversation." });
  }
});

router.get("/:contactId/messages/:messageId/media", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    const messageId = parsePositiveInt(req.params.messageId);
    if (!contactId || !messageId) {
      return res.status(400).json({ error: "Invalid contact or message id." });
    }

    const mediaRef = await messagesRepo.getMessageMediaReferenceForContact(
      contactId,
      messageId
    );
    if (!mediaRef) {
      return res.status(404).json({ error: "Message attachment not found." });
    }

    const requestedRange = normalizeSingleByteRange(req.headers.range);
    if (!requestedRange.valid) {
      return res.sendStatus(416);
    }

    const media = await mediaStorage.openMediaStream(mediaRef.media_key, {
      range: requestedRange.range,
    });
    const mimeType =
      mediaRef.media_mime_type || media.contentType || "application/octet-stream";

    res.set({
      "Accept-Ranges": media.acceptRanges || "bytes",
      "Cache-Control": "private, max-age=3600, immutable",
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    });
    if (media.contentLength !== null) {
      res.set("Content-Length", String(media.contentLength));
    }
    if (media.contentRange) {
      res.set("Content-Range", media.contentRange);
    }
    if (media.etag) {
      res.set("ETag", media.etag);
    }
    if (media.lastModified instanceof Date && !Number.isNaN(media.lastModified.getTime())) {
      res.set("Last-Modified", media.lastModified.toUTCString());
    }

    res.status(media.contentRange ? 206 : 200);
    await pipeline(media.body, res);
  } catch (err) {
    if (mediaStorage.isRangeNotSatisfiableError(err)) {
      if (!res.headersSent) return res.sendStatus(416);
      return;
    }

    if (
      req.aborted ||
      res.destroyed ||
      err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      err?.code === "ECONNRESET"
    ) {
      return;
    }

    console.error("Failed to stream message attachment:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Something went wrong loading this attachment." });
    }
    res.destroy(err);
  }
});

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

router.patch("/:contactId/read-state", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { unread } = req.body || {};
    if (typeof unread !== "boolean") {
      return res.status(400).json({ error: "unread (boolean) is required." });
    }

    const updated = await contactsRepo.setUnread(contact.id, unread);
    res.json(updated);
  } catch (err) {
    console.error("Failed to update conversation read state:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

router.patch("/:contactId/follow-up", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { needsFollowUp } = req.body || {};
    if (typeof needsFollowUp !== "boolean") {
      return res.status(400).json({ error: "needsFollowUp (boolean) is required." });
    }

    const updated = await contactsRepo.setFollowUp(contact.id, needsFollowUp);
    res.json(updated);
  } catch (err) {
    console.error("Failed to update follow-up state:", err);
    res.status(500).json({ error: "Something went wrong updating this conversation." });
  }
});

router.post("/:contactId/messages/delivery-statuses", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const rawMessageIds = req.body?.messageIds;
    if (!Array.isArray(rawMessageIds) || rawMessageIds.length > MAX_DELIVERY_STATUS_IDS) {
      return res.status(400).json({
        error: `messageIds must be an array of at most ${MAX_DELIVERY_STATUS_IDS} ids.`,
      });
    }

    const messageIds = rawMessageIds.map(parsePositiveInt);
    if (messageIds.some((id) => id == null)) {
      return res.status(400).json({ error: "Every message id must be a positive integer." });
    }

    const uniqueMessageIds = [...new Set(messageIds)];
    const statuses = await messagesRepo.getDeliveryStatusesForContact(contactId, uniqueMessageIds);
    res.json(statuses);
  } catch (err) {
    console.error("Failed to resync delivery statuses:", err);
    res.status(500).json({ error: "Something went wrong refreshing delivery statuses." });
  }
});

router.get("/:contactId/whatsapp-templates", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if ((contact.channel || "whatsapp") !== "whatsapp") {
      return res.status(400).json({ error: "WhatsApp templates are only available for WhatsApp contacts." });
    }

    let eligibility;
    try {
      eligibility = await whatsappPolicy.checkTemplateAllowed(contact);
    } catch (err) {
      console.error("Failed to verify WhatsApp template eligibility:", err);
      return res.status(503).json({
        error: "WhatsApp template eligibility could not be verified. Please try again shortly.",
        code: "policy_state_unavailable",
      });
    }

    const forceRefresh = String(req.query?.refresh || "").toLowerCase() === "true";
    const catalog = await whatsappTemplate.listApprovedTemplates({
      force: forceRefresh,
    });
    if (!catalog.success) {
      const status = catalog.code === "template_catalog_not_configured" ? 503 : 502;
      return res.status(status).json({
        error: catalog.error,
        code: catalog.code,
      });
    }

    res.json({
      templates: catalog.templates,
      eligibility: {
        allowed: eligibility.allowed === true,
        code: eligibility.code || null,
        message: eligibility.message || null,
        optInAt: eligibility.state?.whatsapp_opt_in_at || null,
        marketingOptOutAt:
          eligibility.state?.whatsapp_marketing_opt_out_at || null,
        marketingOptOutSource:
          eligibility.state?.whatsapp_marketing_opt_out_source || null,
      },
      cached: catalog.cached === true,
    });
  } catch (err) {
    console.error("Failed to load WhatsApp templates:", err);
    res.status(500).json({ error: "Something went wrong loading WhatsApp templates." });
  }
});

router.post("/:contactId/whatsapp-opt-in", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if ((contact.channel || "whatsapp") !== "whatsapp") {
      return res.status(400).json({ error: "WhatsApp opt-in can only be recorded for WhatsApp contacts." });
    }

    if (req.body?.confirmed !== true) {
      return res.status(400).json({
        error: "Confirm that the customer explicitly agreed to receive WhatsApp messages before recording opt-in.",
        code: "opt_in_confirmation_required",
      });
    }

    const source = String(req.body?.source || "").trim();
    if (source.length < 3 || source.length > 240) {
      return res.status(400).json({
        error: "Enter a clear opt-in source between 3 and 240 characters.",
      });
    }

    const updated = await whatsappPolicy.recordOptIn(contact.id, source);
    realtimeEvents.publish("conversation_changed", {
      contactId: updated.id,
      reason: "whatsapp_opt_in",
    });
    res.json({
      contactId: updated.id,
      whatsapp_opt_in_at: updated.whatsapp_opt_in_at,
      whatsapp_opt_in_source: updated.whatsapp_opt_in_source,
      whatsapp_opt_out_at: updated.whatsapp_opt_out_at,
      whatsapp_opt_out_source: updated.whatsapp_opt_out_source,
      whatsapp_marketing_opt_out_at: updated.whatsapp_marketing_opt_out_at,
      whatsapp_marketing_opt_out_source: updated.whatsapp_marketing_opt_out_source,
    });
  } catch (err) {
    console.error("Failed to record WhatsApp opt-in:", err);
    res.status(500).json({ error: "Something went wrong recording WhatsApp opt-in." });
  }
});

router.post("/:contactId/whatsapp-templates/send", async (req, res) => {
  try {
    const contactId = parsePositiveInt(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contact id." });

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if ((contact.channel || "whatsapp") !== "whatsapp") {
      return res.status(400).json({ error: "WhatsApp templates are only available for WhatsApp contacts." });
    }

    let policy;
    try {
      policy = await whatsappPolicy.checkTemplateAllowed(contact);
    } catch (err) {
      console.error("Failed to verify WhatsApp template policy:", err);
      return res.status(503).json({
        error: "WhatsApp template policy could not be verified. Please try again shortly.",
        code: "policy_state_unavailable",
        policyBlocked: true,
      });
    }
    if (!policy.allowed) {
      return res.status(403).json({
        error: policy.message,
        code: policy.code,
        policyBlocked: true,
      });
    }

    const templateName = String(req.body?.templateName || "").trim();
    const languageCode = String(req.body?.languageCode || "").trim();
    if (!templateName || !languageCode) {
      return res.status(400).json({ error: "Template name and language are required." });
    }

    const resolved = await whatsappTemplate.resolveApprovedTemplate(
      templateName,
      languageCode,
      { force: true }
    );
    if (!resolved.success) {
      const status = resolved.code === "template_not_available" ? 400 : 502;
      return res.status(status).json({
        error: resolved.error,
        code: resolved.code,
      });
    }

    const built = whatsappTemplate.buildTemplateComponents(
      resolved.template,
      req.body?.values || {}
    );
    if (!built.valid) {
      return res.status(400).json({
        error: built.error,
        code: "invalid_template_values",
      });
    }

    const preview = whatsappTemplate.renderTemplatePreview(
      resolved.template,
      built.values
    );
    if (!preview) {
      return res.status(400).json({
        error: "This template does not contain a text preview that Inbox can send safely.",
        code: "template_preview_unavailable",
      });
    }

    const marketingConsentConfirmed =
      resolved.template.category !== "MARKETING" ||
      req.body?.marketingConsentConfirmed === true;
    if (!marketingConsentConfirmed) {
      return res.status(400).json({
        error:
          "Confirm that the customer's WhatsApp opt-in covers marketing or promotional messages before sending this marketing template.",
        code: "marketing_consent_confirmation_required",
      });
    }

    let templatePolicy;
    try {
      templatePolicy = await whatsappPolicy.checkTemplateAllowed(contact, {
        category: resolved.template.category,
      });

      if (
        templatePolicy.code === "marketing_opted_out" &&
        resolved.template.category === "MARKETING" &&
        marketingConsentConfirmed
      ) {
        const latestOptInAt = whatsappTemplate.policyTimestamp(
          templatePolicy.state?.whatsapp_opt_in_at
        );
        const marketingOptOutAt = whatsappTemplate.policyTimestamp(
          templatePolicy.state?.whatsapp_marketing_opt_out_at
        );
        const hasNewerExplicitOptIn =
          latestOptInAt &&
          marketingOptOutAt &&
          new Date(latestOptInAt).getTime() > new Date(marketingOptOutAt).getTime();

        if (hasNewerExplicitOptIn) {
          await whatsappPolicy.recordMarketingOptIn(contact.id);
          templatePolicy = await whatsappPolicy.checkTemplateAllowed(contact, {
            category: resolved.template.category,
          });
        }
      }
    } catch (err) {
      console.error("Failed to verify category-specific WhatsApp template policy:", err);
      return res.status(503).json({
        error: "WhatsApp template policy could not be verified. Please try again shortly.",
        code: "policy_state_unavailable",
        policyBlocked: true,
      });
    }

    if (!templatePolicy.allowed) {
      return res.status(403).json({
        error: templatePolicy.message,
        code: templatePolicy.code,
        policyBlocked: true,
      });
    }

    policy = templatePolicy;

    const consentOptInAt =
      resolved.template.category === "MARKETING"
        ? whatsappTemplate.policyTimestamp(policy.state?.whatsapp_opt_in_at)
        : null;
    if (resolved.template.category === "MARKETING" && !consentOptInAt) {
      return res.status(409).json({
        error:
          "The customer's WhatsApp marketing consent could not be tied to the current opt-in record. Record or reconfirm opt-in and try again.",
        code: "marketing_consent_snapshot_unavailable",
        policyBlocked: true,
      });
    }

    const metadata = {
      name: resolved.template.name,
      language: resolved.template.language,
      category: resolved.template.category,
      components: built.components,
      values: built.values,
      templateSignature: whatsappTemplate.templateSignature(resolved.template),
      marketingConsentConfirmed:
        resolved.template.category === "MARKETING"
          ? true
          : null,
      consentOptInAt,
    };
    const prepared = await telegramImmediateAlertRepo.withContactAlertLock(
      contact.id,
      async () => {
        const preparedContact = await prepareStaffSend(
          contact,
          req.session.username
        );
        const saved = await conversationStore.appendMessageForContact(
          preparedContact.id,
          "assistant",
          preview,
          null,
          req.session.username,
          null,
          null,
          {
            whatsappTemplate: metadata,
            initialDeliveryStatus: "unknown",
            initialDeliveryError:
              "Template send started, but delivery has not been confirmed. Check WhatsApp before retrying.",
            publish: false,
          }
        );
        const finalContact =
          await finalizeStaffSendState(preparedContact.id, req.session.username);
        return { preparedContact: finalContact || preparedContact, saved };
      }
    );

    const { preparedContact, saved } = prepared;
    const sendResult = await whatsappTemplate.sendApprovedTemplate(preparedContact, {
      templateName: metadata.name,
      languageCode: metadata.language,
      components: metadata.components,
      expectedOptInAt: metadata.consentOptInAt,
      templateCategory: metadata.category,
    });
    const errorText =
      sendResult.error || "WhatsApp did not accept this approved template.";
    const finalMessage = await persistSendOutcome(
      saved,
      sendResult,
      errorText,
      "whatsapp"
    );

    if (sendResult.success) {
      await contactsRepo.clearDeliveryAttentionIfNoFailedMessages(preparedContact.id).catch(() => {});
      await markLeadContacted(preparedContact.id, req.session.username, sendResult);
    } else {
      await contactsRepo.setDeliveryAttention(
        preparedContact.id,
        `${sendResult.unknown === true ? "Delivery unconfirmed" : "Delivery failed"}: ${publicDeliveryError(errorText)}`
      );
    }

    res.status(201).json({
      ...finalMessage,
      whatsapp_template: saved.whatsapp_template || metadata,
      delivery_error: publicDeliveryError(finalMessage.delivery_error),
      delivered: sendResult.success,
      template: {
        name: metadata.name,
        language: metadata.language,
        category: metadata.category,
      },
    });
  } catch (err) {
    console.error("Failed to send WhatsApp template:", err);
    res.status(500).json({ error: "Something went wrong sending this WhatsApp template." });
  }
});

router.post("/:contactId/messages/:messageId/retry", async (req, res) => {
  const contactId = parsePositiveInt(req.params.contactId);
  const messageId = parsePositiveInt(req.params.messageId);
  if (!contactId || !messageId) {
    return res.status(400).json({ error: "Invalid contact or message id." });
  }

  let releaseRetryLock = null;

  try {
    releaseRetryLock = await messagesRepo.acquireMessageRetryLock(messageId);
    if (!releaseRetryLock) {
      return res.status(409).json({ error: "This message is already being retried." });
    }

    const contact = await contactsRepo.getContactById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const message = await messagesRepo.getMessageForRetry(contactId, messageId);
    if (!message) return res.status(404).json({ error: "Message not found." });
    if (message.role !== "assistant") {
      return res.status(400).json({ error: "Only outbound messages can be retried." });
    }
    if (!["failed", "unknown"].includes(message.delivery_status)) {
      return res.status(409).json({
        error: "Only failed or unconfirmed messages can be retried.",
      });
    }

    const isManualStaffRetry =
      Boolean(message.sent_by_username) &&
      message.is_automated_follow_up !== true &&
      message.is_scheduled_message !== true;
    let performRetrySend = null;

    if (message.whatsapp_template) {
      if ((contact.channel || "whatsapp") !== "whatsapp") {
        return res.status(409).json({
          error: "Saved WhatsApp templates can only be retried on WhatsApp contacts.",
        });
      }

      let templatePolicy;
      try {
        templatePolicy = await whatsappPolicy.checkTemplateAllowed(contact);
      } catch (err) {
        console.error("Failed to verify WhatsApp template retry policy:", err);
        return res.status(503).json({
          error: "WhatsApp template policy could not be verified. Please try again shortly.",
          code: "policy_state_unavailable",
          policyBlocked: true,
        });
      }
      if (!templatePolicy.allowed) {
        return res.status(403).json({
          error: templatePolicy.message,
          code: templatePolicy.code,
          policyBlocked: true,
        });
      }

      const currentTemplate = await whatsappTemplate.resolveApprovedTemplate(
        message.whatsapp_template.name,
        message.whatsapp_template.language,
        { force: true }
      );
      if (!currentTemplate.success) {
        return res.status(409).json({
          error:
            currentTemplate.code === "template_not_available"
              ? "This WhatsApp template is no longer approved or available. Choose another approved template instead."
              : currentTemplate.error,
          code: currentTemplate.code,
        });
      }

      try {
        templatePolicy = await whatsappPolicy.checkTemplateAllowed(contact, {
          category: currentTemplate.template.category,
        });
      } catch (err) {
        console.error("Failed to verify category-specific WhatsApp template retry policy:", err);
        return res.status(503).json({
          error: "WhatsApp template policy could not be verified. Please try again shortly.",
          code: "policy_state_unavailable",
          policyBlocked: true,
        });
      }
      if (!templatePolicy.allowed) {
        return res.status(403).json({
          error:
            templatePolicy.code === "marketing_opted_out"
              ? "This customer opted out of WhatsApp marketing. Record a new explicit opt-in that covers marketing and send the template again from the picker."
              : templatePolicy.message,
          code: templatePolicy.code,
          policyBlocked: true,
        });
      }

      const savedTemplateSignature = String(
        message.whatsapp_template.templateSignature || ""
      );
      const currentTemplateSignature = whatsappTemplate.templateSignature(
        currentTemplate.template
      );
      if (
        !savedTemplateSignature ||
        savedTemplateSignature !== currentTemplateSignature
      ) {
        return res.status(409).json({
          error:
            "This WhatsApp template changed since the failed send. Open the template picker, review the current approved version, and send it again.",
          code: "template_definition_changed",
        });
      }

      const rebuiltTemplate = whatsappTemplate.buildTemplateComponents(
        currentTemplate.template,
        message.whatsapp_template.values || {}
      );
      if (!rebuiltTemplate.valid) {
        return res.status(409).json({
          error:
            "The saved template values no longer fit the current approved template. Send it again from the template picker.",
          code: "template_values_changed",
        });
      }

      if (currentTemplate.template.category === "MARKETING") {
        const savedConsentOptInAt = whatsappTemplate.policyTimestamp(
          message.whatsapp_template.consentOptInAt
        );
        const currentConsentOptInAt = whatsappTemplate.policyTimestamp(
          templatePolicy.state?.whatsapp_opt_in_at
        );
        if (
          message.whatsapp_template.marketingConsentConfirmed !== true ||
          !savedConsentOptInAt ||
          !currentConsentOptInAt ||
          savedConsentOptInAt !== currentConsentOptInAt
        ) {
          return res.status(409).json({
            error:
              "The customer's WhatsApp marketing consent has changed since this template was first attempted. Send it again from the template picker and reconfirm marketing consent.",
            code: "marketing_consent_reconfirmation_required",
          });
        }
      }

      performRetrySend = (activeContact) =>
        whatsappTemplate.sendApprovedTemplate(activeContact, {
          templateName: message.whatsapp_template.name,
          languageCode: message.whatsapp_template.language,
          components: rebuiltTemplate.components,
          expectedOptInAt:
            currentTemplate.template.category === "MARKETING"
              ? message.whatsapp_template.consentOptInAt
              : null,
          templateCategory: currentTemplate.template.category,
        });
    } else {
      const retryPurpose =
        message.sent_by_username &&
        message.is_automated_follow_up !== true &&
        message.is_scheduled_message !== true
          ? whatsappPolicy.manualStaffPurpose(contact)
          : "service";
      if (!(await requireFreeformPolicy(contact, res, retryPurpose))) return;

      performRetrySend = (activeContact) =>
        sendStoredMessage(activeContact, message, {
          purpose: retryPurpose,
          ...(isManualStaffRetry
            ? { requireStaffMode: activeContact.mode === "human" }
            : {}),
        });
    }

    let sendResult;
    let updated;
    let sendContact = contact;

    const executeRetry = async (activeContact) => {
      const result = await performRetrySend(activeContact);
      const errorText = deliveryErrorForSend(
        result,
        result.error || rejectedErrorFor(activeContact),
        message.delivery_error
      );
      const persisted = await persistSendOutcome(
        message,
        result,
        errorText,
        activeContact.channel || "whatsapp"
      );
      return { result, errorText, persisted };
    };

    if (isManualStaffRetry) {
      const retried = await telegramImmediateAlertRepo.withContactAlertLock(
        contact.id,
        async () => {
          const preparedContact = await prepareStaffSend(
            contact,
            req.session.username
          );

          // A failed row is intentionally ignored by the durable Staff Assist
          // guard. Mark this retry unconfirmed before contacting the provider
          // so concurrent/restarted AI work sees that staff is actively handling
          // this turn. If the request is interrupted, "unknown" is also the
          // safest delivery state because blindly retrying could duplicate it.
          const retryPending = await messagesRepo.setDeliveryStatusById(
            message.id,
            "unknown",
            "Retry started; delivery has not been confirmed yet."
          );
          publishDeliveryStatus(retryPending);

          const outcome = await executeRetry(preparedContact);
          let finalContact = preparedContact;
          if (outcome.result.success) {
            finalContact =
              await finalizeStaffSendState(
                preparedContact.id,
                req.session.username
              ) || preparedContact;
          }
          return { ...outcome, sendContact: finalContact };
        }
      );

      sendResult = retried.result;
      updated = retried.persisted;
      sendContact = retried.sendContact;
    } else {
      const retried = await executeRetry(contact);
      sendResult = retried.result;
      updated = retried.persisted;
    }

    const errorText = deliveryErrorForSend(
      sendResult,
      sendResult.error || rejectedErrorFor(sendContact),
      message.delivery_error
    );

    if (sendResult.success) {
      await contactsRepo.clearDeliveryAttentionIfNoFailedMessages(sendContact.id);
      await markLeadContacted(sendContact.id, req.session.username, sendResult);
    } else {
      await contactsRepo.setDeliveryAttention(
        sendContact.id,
        `${sendResult.unknown === true ? "Delivery unconfirmed" : "Delivery failed"}: ${publicDeliveryError(errorText)}`
      );
    }

    res.json({
      ...updated,
      accepted: !!sendResult.success,
      retry_error: sendResult.success ? null : publicDeliveryError(errorText),
    });
  } catch (err) {
    console.error("Failed to retry message:", err);
    res.status(500).json({ error: "Something went wrong retrying this message." });
  } finally {
    if (releaseRetryLock) {
      try {
        await releaseRetryLock();
      } catch (lockErr) {
        console.error("Failed to release message retry lock:", lockErr);
      }
    }
  }
});

async function forwardStoredMessage(sourceMessage, targetContact, username) {
  const forwardStartedAt = Date.now();
  const policy = await whatsappPolicy.checkFreeformAllowed(targetContact, new Date(), {
    purpose: whatsappPolicy.manualStaffPurpose(targetContact),
  });
  if (!policy.allowed) {
    return {
      contactId: targetContact.id,
      delivered: false,
      policyBlocked: true,
      code: policy.code || null,
      error: policy.message || "Messaging is not currently allowed for this contact.",
    };
  }

  const sourceMimeType = String(sourceMessage.media_mime_type || "").toLowerCase();
  const sourceContent = String(sourceMessage.content || "");
  const sourceIsSticker =
    sourceMimeType === "image/webp" &&
    /(?:sent a sticker|sticker sent from)/i.test(sourceContent);
  let forwardedContent = sourceContent;
  if (sourceIsSticker) {
    forwardedContent = "🙂 [Forwarded sticker]";
  } else if (
    sourceMimeType.startsWith("image/") &&
    /^📷\s*\[[^\]]+sent a photo\]\s*$/iu.test(sourceContent.trim())
  ) {
    forwardedContent = "";
  } else if (sourceMimeType.startsWith("image/")) {
    forwardedContent = sourceContent.replace(/^📷\s*/u, "");
  }

  let targetMediaKey = null;
  let fallbackMediaAttachment = null;
  let mediaCopyMs = null;
  const canUseZeroCopyImageForward =
    Boolean(sourceMessage.media_key) &&
    sourceMimeType.startsWith("image/") &&
    !sourceIsSticker;
  const providerTempPromise = canUseZeroCopyImageForward
    ? mediaStorage
        .copyStoredMediaToTemporary(
          sourceMessage.media_key,
          sourceMessage.media_mime_type,
          {
            contactId: targetContact.id,
            expiresSeconds: 10 * 60,
          }
        )
        .then((temporaryMedia) => {
          mediaStorage.scheduleTemporaryMediaDelete(temporaryMedia.key);
          return temporaryMedia;
        })
        .catch((err) => {
          console.warn(
            `[Inbox forward] provider R2 copy failed for message ${sourceMessage.id}; falling back to stored-media send:`,
            err
          );
          return null;
        })
    : null;

  if (sourceMessage.media_key) {
    const copyStartedAt = Date.now();
    try {
      targetMediaKey = await mediaStorage.copyStoredMediaToMessage(
        sourceMessage.media_key,
        sourceMessage.media_mime_type,
        { contactId: targetContact.id }
      );
      mediaCopyMs = Date.now() - copyStartedAt;
    } catch (copyErr) {
      // Keep forwarding available if R2's server-side copy is temporarily
      // unavailable. This fallback is intentionally the only path that
      // downloads the original bytes into Render.
      console.warn(
        `[Inbox forward] R2 server-side copy failed for message ${sourceMessage.id}; falling back to buffered copy:`,
        copyErr
      );
      const buffer = await mediaStorage.downloadMedia(sourceMessage.media_key);
      fallbackMediaAttachment = {
        mimeType: sourceMessage.media_mime_type,
        buffer,
      };
      mediaCopyMs = Date.now() - copyStartedAt;
    }
  }

  let prepared;
  try {
    prepared = await telegramImmediateAlertRepo.withContactAlertLock(
      targetContact.id,
      async () => {
        const preparedContact = await prepareStaffSend(targetContact, username);
        const saved = await conversationStore.appendMessageForContact(
          preparedContact.id,
          "assistant",
          forwardedContent,
          null,
          username,
          sourceMessage.media_url || null,
          fallbackMediaAttachment ||
            (targetMediaKey
              ? { mimeType: sourceMessage.media_mime_type }
              : null),
          {
            isForwarded: true,
            mediaKey: targetMediaKey,
          }
        );
        const finalContact =
          await finalizeStaffSendState(preparedContact.id, username);
        return { preparedContact: finalContact || preparedContact, saved };
      }
    );
  } catch (err) {
    if (targetMediaKey) {
      await mediaStorage.deleteMedia(targetMediaKey).catch((cleanupErr) => {
        console.error(
          `Failed to clean up copied forward media ${targetMediaKey}:`,
          cleanupErr
        );
      });
    }
    throw err;
  }

  const { preparedContact, saved } = prepared;
  const messageForSend = {
    ...sourceMessage,
    id: saved.id,
    contact_id: saved.contact_id,
    content: forwardedContent,
    media_key: targetMediaKey,
    media_base64: fallbackMediaAttachment
      ? fallbackMediaAttachment.buffer.toString("base64")
      : null,
    delivery_error: null,
    reply_to_provider_message_id: null,
    is_forwarded: true,
  };

  const preparedTemporaryMedia = providerTempPromise
    ? await providerTempPromise
    : null;
  const providerStartedAt = Date.now();
  const sendResult = preparedTemporaryMedia
    ? await channelMessaging.sendImageByUrl(
        preparedContact,
        preparedTemporaryMedia.url,
        forwardedContent || undefined,
        socialProviderSendOptions(saved, preparedContact, {
          purpose: whatsappPolicy.manualStaffPurpose(preparedContact),
        })
      )
    : await sendStoredMessage(preparedContact, messageForSend, {
        purpose: whatsappPolicy.manualStaffPurpose(preparedContact),
      });
  const providerMs = Date.now() - providerStartedAt;

  const errorText = deliveryErrorForSend(
    sendResult,
    sendResult.error || rejectedErrorFor(preparedContact)
  );
  const finalMessage = await persistSendOutcome(
    saved,
    sendResult,
    errorText,
    preparedContact.channel || "whatsapp"
  );

  if (sendResult.success) {
    await markLeadContacted(preparedContact.id, username, sendResult);
  } else {
    await contactsRepo.setDeliveryAttention(
      preparedContact.id,
      `Delivery failed: ${publicDeliveryError(errorText)}`
    );
  }

  const totalMs = Date.now() - forwardStartedAt;
  if (sourceMimeType.startsWith("image/") && totalMs >= 1000) {
    console.info(
      `[Inbox forward timing] source=${sourceMessage.id} target=${preparedContact.id} copy=${mediaCopyMs ?? "n/a"}ms provider=${providerMs}ms total=${totalMs}ms`
    );
  }

  return {
    contactId: preparedContact.id,
    delivered: sendResult.success,
    error: sendResult.success ? null : publicDeliveryError(errorText),
    message: {
      ...finalMessage,
      delivery_error: publicDeliveryError(finalMessage.delivery_error),
      is_forwarded: true,
    },
  };
}

router.post("/:contactId/messages/:messageId/forward", async (req, res) => {
  try {
    const sourceContactId = parsePositiveInt(req.params.contactId);
    const sourceMessageId = parsePositiveInt(req.params.messageId);
    if (!sourceContactId || !sourceMessageId) {
      return res.status(400).json({ error: "Invalid message." });
    }

    const requestedTargets = Array.isArray(req.body?.targetContactIds)
      ? req.body.targetContactIds
      : [];
    const targetContactIds = [
      ...new Set(requestedTargets.map(parsePositiveInt).filter(Boolean)),
    ];
    if (!targetContactIds.length) {
      return res.status(400).json({ error: "Choose at least one conversation to forward to." });
    }
    if (targetContactIds.length > 10) {
      return res.status(400).json({ error: "You can forward to up to 10 conversations at a time." });
    }

    const sourceMessage = await messagesRepo.getMessageForForward(
      sourceContactId,
      sourceMessageId
    );
    if (!sourceMessage) {
      return res.status(404).json({ error: "Message not found." });
    }
    const hasForwardableContent =
      Boolean(String(sourceMessage.content || "").trim()) ||
      Boolean(sourceMessage.media_key) ||
      Boolean(sourceMessage.media_url);
    if (!hasForwardableContent) {
      return res.status(400).json({ error: "This message cannot be forwarded." });
    }

    const targetChecks = await Promise.all(
      targetContactIds.map(async (contactId) => {
        const allowed = await canAccessContact(req.user, contactId);
        if (!allowed) return { contactId, allowed: false, target: null };
        return {
          contactId,
          allowed: true,
          target: await contactsRepo.getContactById(contactId),
        };
      })
    );

    if (targetChecks.some((item) => !item.allowed)) {
      return res.status(403).json({
        error: "One of the selected conversations is not assigned to you.",
      });
    }
    if (targetChecks.some((item) => !item.target)) {
      return res.status(404).json({
        error: "One of the selected conversations no longer exists.",
      });
    }

    const targets = targetChecks.map((item) => item.target);
    const results = await mapWithConcurrency(targets, 3, async (target) => {
      try {
        return await forwardStoredMessage(
          sourceMessage,
          target,
          req.session.username
        );
      } catch (err) {
        console.error(
          `Failed to forward message ${sourceMessageId} to contact ${target.id}:`,
          err
        );
        return {
          contactId: target.id,
          delivered: false,
          error: "Something went wrong forwarding this message.",
        };
      }
    });

    const deliveredCount = results.filter((result) => result.delivered).length;
    res.status(200).json({
      deliveredCount,
      requestedCount: results.length,
      results,
    });
  } catch (err) {
    console.error("Failed to forward Inbox message:", err);
    res.status(500).json({ error: "Something went wrong forwarding this message." });
  }
});

router.post("/:contactId/messages", async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const { text, replyToMessageId } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message text is required." });
    }
    const reply = await resolveReplyTarget(contact, replyToMessageId, res);
    if (!reply.ok) return;
    const replyTarget = reply.target;
    if (!(await requireFreeformPolicy(contact, res, whatsappPolicy.manualStaffPurpose(contact)))) return;

    const prepared = await telegramImmediateAlertRepo.withContactAlertLock(
      contact.id,
      async () => {
        const preparedContact = await prepareStaffSend(
          contact,
          req.session.username
        );
        const saved = await conversationStore.appendMessageForContact(
          preparedContact.id,
          "assistant",
          text.trim(),
          null,
          req.session.username,
          null,
          null,
          {
            replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
          }
        );
        const finalContact =
          await finalizeStaffSendState(preparedContact.id, req.session.username);
        return { preparedContact: finalContact || preparedContact, saved };
      }
    );

    const { preparedContact, saved } = prepared;
    const sendResult = await channelMessaging.sendText(
      preparedContact,
      text.trim(),
      socialProviderSendOptions(saved, preparedContact, {
        purpose: whatsappPolicy.manualStaffPurpose(preparedContact),
        replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
      })
    );
    const errorText = deliveryErrorForSend(
      sendResult,
      sendResult.error || rejectedErrorFor(preparedContact)
    );
    const finalMessage = await persistSendOutcome(
      saved,
      sendResult,
      errorText,
      preparedContact.channel || "whatsapp"
    );
    if (!sendResult.success) {
      await contactsRepo.setDeliveryAttention(
        preparedContact.id,
        `Delivery failed: ${publicDeliveryError(errorText)}`
      );
    } else {
      await markLeadContacted(preparedContact.id, req.session.username, sendResult);
    }

    res.status(201).json({
      ...finalMessage,
      delivery_error: publicDeliveryError(finalMessage.delivery_error),
      delivered: sendResult.success,
    });
  } catch (err) {
    console.error("Failed to send staff message:", err);
    res.status(500).json({ error: "Something went wrong sending this message." });
  }
});

function handleImageUpload(req, res, next) {
  const receiveStartedAt = Date.now();
  upload.single("image")(req, res, (err) => {
    req.inboxImageReceiveMs = Date.now() - receiveStartedAt;
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image is too large. Please choose a file under 16MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload image." });
  });
}

function handleVoiceUpload(req, res, next) {
  voiceUpload.single("voice")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Voice recording is too large. Please keep it under 16MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload voice recording." });
  });
}

router.post("/:contactId/media", handleImageUpload, async (req, res) => {
  const routeStartedAt = Date.now();

  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const channel = contact.channel || "whatsapp";
    const isWhatsApp = channel === "whatsapp";

    if (isWhatsApp) {
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!WHATSAPP_IMAGE_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({
          error: "WhatsApp images must be JPEG or PNG.",
          code: "unsupported_whatsapp_image_type",
        });
      }
      if (req.file.size > WHATSAPP_IMAGE_MAX_BYTES) {
        return res.status(400).json({
          error: "WhatsApp images must be 5MB or smaller.",
          code: "whatsapp_image_too_large",
        });
      }
    }

    const reply = await resolveReplyTarget(contact, req.body?.replyToMessageId, res);
    if (!reply.ok) return;
    const replyTarget = reply.target;
    if (!(await requireFreeformPolicy(contact, res, whatsappPolicy.manualStaffPurpose(contact)))) return;

    const caption = (req.body?.caption || "").trim();
    let preparedContact;
    let saved;
    let sendResult;
    let r2PersistMs = null;
    let providerSendMs = null;

    if (isWhatsApp) {
      // Save a lightweight message row before any provider call so a successful
      // WhatsApp send can never become an orphaned conversation event. The
      // expensive R2 write and Meta media upload then run in parallel.
      const prepared = await telegramImmediateAlertRepo.withContactAlertLock(
        contact.id,
        async () => {
          const initialContact = await prepareStaffSend(
            contact,
            req.session.username
          );
          const initialSaved = await conversationStore.appendMessageForContact(
            initialContact.id,
            "assistant",
            caption,
            null,
            req.session.username,
            null,
            { mimeType: req.file.mimetype },
            {
              publish: false,
              replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
            }
          );
          const finalContact =
            await finalizeStaffSendState(initialContact.id, req.session.username);
          return {
            preparedContact: finalContact || initialContact,
            saved: initialSaved,
          };
        }
      );

      preparedContact = prepared.preparedContact;
      saved = prepared.saved;
      const sendOptions = socialProviderSendOptions(saved, preparedContact, {
        purpose: whatsappPolicy.manualStaffPurpose(preparedContact),
        replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
      });

      const r2StartedAt = Date.now();
      const persistPromise = mediaStorage
        .uploadMedia(req.file.buffer, req.file.mimetype, {
          contactId: preparedContact.id,
        })
        .then((mediaKey) => {
          r2PersistMs = Date.now() - r2StartedAt;
          return mediaKey;
        });

      const providerStartedAt = Date.now();
      const providerPromise = channelMessaging
        .sendImageBuffer(
          preparedContact,
          req.file.buffer,
          req.file.mimetype,
          caption || undefined,
          req.file.originalname || "image",
          sendOptions
        )
        .then((result) => {
          providerSendMs = Date.now() - providerStartedAt;
          return result;
        });

      const [persistOutcome, providerOutcome] = await Promise.allSettled([
        persistPromise,
        providerPromise,
      ]);

      let mediaKey = null;
      if (persistOutcome.status === "fulfilled") {
        mediaKey = persistOutcome.value;
      } else {
        console.warn(
          `[Inbox image] initial R2 persistence failed for contact ${preparedContact.id}; retrying once:`,
          persistOutcome.reason
        );
        const retryStartedAt = Date.now();
        try {
          mediaKey = await mediaStorage.uploadMedia(
            req.file.buffer,
            req.file.mimetype,
            { contactId: preparedContact.id }
          );
          r2PersistMs = Date.now() - retryStartedAt;
        } catch (persistErr) {
          console.error(
            `[Inbox image] R2 persistence failed after retry for contact ${preparedContact.id}:`,
            persistErr
          );
        }
      }

      let mediaAttached = false;
      if (mediaKey) {
        for (let attempt = 1; attempt <= 2 && !mediaAttached; attempt += 1) {
          try {
            saved =
              (await conversationStore.attachStoredMediaForContact(
                preparedContact.id,
                saved.id,
                mediaKey,
                req.file.mimetype
              )) || saved;
            mediaAttached = true;
          } catch (attachErr) {
            console.error(
              `[Inbox image] failed to attach R2 media key to message ${saved.id} (attempt ${attempt}/2):`,
              attachErr
            );
          }
        }
      }

      if (!mediaAttached) {
        // Never turn a successful provider send into a browser-visible 500 just
        // because the post-upload DB attachment update had a transient problem.
        // Surface the lightweight row and flag attention instead.
        realtimeEvents.publish("conversation_changed", {
          contactId: preparedContact.id,
          messageId: saved.id,
          message: saved,
          reason: "message",
        });
      }

      sendResult =
        providerOutcome.status === "fulfilled"
          ? providerOutcome.value
          : {
              success: false,
              wamid: null,
              error:
                providerOutcome.reason?.message ||
                "WhatsApp image send failed unexpectedly.",
            };

      if (!mediaKey || !mediaAttached) {
        await contactsRepo.setDeliveryAttention(
          preparedContact.id,
          mediaKey
            ? "Image was sent, but its stored attachment could not be linked to the message. History/retry may be unavailable."
            : "Image storage failed after send attempt; attachment history/retry may be unavailable."
        );
      }
    } else {
      // Keep the existing social-channel path unchanged. Those providers have
      // different attachment semantics and already rely on stored media.
      const prepared = await telegramImmediateAlertRepo.withContactAlertLock(
        contact.id,
        async () => {
          const initialContact = await prepareStaffSend(
            contact,
            req.session.username
          );
          const initialSaved = await conversationStore.appendMessageForContact(
            initialContact.id,
            "assistant",
            caption,
            null,
            req.session.username,
            null,
            { mimeType: req.file.mimetype, buffer: req.file.buffer },
            {
              replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
            }
          );
          const finalContact =
            await finalizeStaffSendState(initialContact.id, req.session.username);
          return {
            preparedContact: finalContact || initialContact,
            saved: initialSaved,
          };
        }
      );

      preparedContact = prepared.preparedContact;
      saved = prepared.saved;
      const providerStartedAt = Date.now();
      sendResult = await channelMessaging.sendImageBuffer(
        preparedContact,
        req.file.buffer,
        req.file.mimetype,
        caption || undefined,
        req.file.originalname || "image",
        socialProviderSendOptions(saved, preparedContact, {
          purpose: whatsappPolicy.manualStaffPurpose(preparedContact),
          replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
        })
      );
      providerSendMs = Date.now() - providerStartedAt;
    }

    const errorText = deliveryErrorForSend(
      sendResult,
      sendResult.error || rejectedErrorFor(preparedContact)
    );
    const finalMessage = await persistSendOutcome(
      saved,
      sendResult,
      errorText,
      preparedContact.channel || "whatsapp"
    );

    if (!sendResult.success) {
      await contactsRepo.setDeliveryAttention(
        preparedContact.id,
        `Delivery failed: ${publicDeliveryError(errorText)}`
      );
    } else {
      await markLeadContacted(preparedContact.id, req.session.username, sendResult);
    }

    const totalRouteMs = Date.now() - routeStartedAt;
    if (
      totalRouteMs >= 2000 ||
      Number(req.inboxImageReceiveMs || 0) >= 1500 ||
      Number(r2PersistMs || 0) >= 1500 ||
      Number(providerSendMs || 0) >= 1500
    ) {
      console.info(
        `[Inbox image timing] contact=${preparedContact.id} bytes=${req.file.size} receive=${req.inboxImageReceiveMs ?? "n/a"}ms r2=${r2PersistMs ?? "n/a"}ms provider=${providerSendMs ?? "n/a"}ms route=${totalRouteMs}ms`
      );
    }

    res.status(201).json({
      ...finalMessage,
      delivery_error: publicDeliveryError(finalMessage.delivery_error),
      delivered: sendResult.success,
    });
  } catch (err) {
    console.error("Failed to send staff image:", err);
    res.status(500).json({ error: "Something went wrong sending this image." });
  }
});

router.post("/:contactId/voice", handleVoiceUpload, async (req, res) => {
  try {
    const contact = await contactsRepo.getContactById(req.params.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    if (!(await requireFreeformPolicy(contact, res, whatsappPolicy.manualStaffPurpose(contact)))) return;

    if (!req.file) {
      return res.status(400).json({ error: "A voice recording is required." });
    }

    const reply = await resolveReplyTarget(contact, req.body?.replyToMessageId, res);
    if (!reply.ok) return;
    const replyTarget = reply.target;

    // Stop an in-flight AI reply immediately; conversion/transcription below
    // can take several seconds. Ownership/attention state is changed only after
    // the recording is valid.
    aiReplyCancellation.cancelForContact(contact);

    const voicePreparation = await telegramImmediateAlertRepo.withContactAlertLock(
      contact.id,
      async () => {
        // Voice conversion/transcription can take several seconds. Hold the same
        // per-contact alert lock used by Staff Waiting so another conversation
        // event cannot validate/send a false reminder while Staff is actively
        // preparing this reply but the persisted voice-message row does not yet exist.
        const converted = await convertToWhatsAppVoice(req.file.buffer, req.file.mimetype);
        if (!converted) return { status: "conversion_failed" };

        const transcript = await resolveWithin(
          transcribeStaffAudio(converted.whatsapp.buffer, converted.whatsapp.mimeType),
          STAFF_TRANSCRIPTION_TIMEOUT_MS,
          null
        );

        const currentContact = await contactsRepo.getContactById(contact.id);
        if (!currentContact) {
          return { status: "contact_missing" };
        }

        // Match text/image sends: ordinary AI-owned chats remain AI-owned,
        // while a synthetic AI handoff is claimed as real Staff ownership.
        const preparedContact = await prepareStaffSend(
          currentContact,
          req.session.username
        );

        const content = transcript ? `🎤 ${transcript}` : "🎤 Staff sent a voice message";
        const saved = await conversationStore.appendMessageForContact(
          preparedContact.id,
          "assistant",
          content,
          null,
          req.session.username,
          null,
          {
            mimeType: converted.playback.mimeType,
            buffer: converted.playback.buffer,
          },
          {
            replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
          }
        );
        const finalContact =
          await finalizeStaffSendState(preparedContact.id, req.session.username);

        return {
          status: "ready",
          converted,
          transcript,
          currentContact: finalContact || preparedContact,
          saved,
        };
      }
    );

    if (voicePreparation.status === "conversion_failed") {
      return res.status(422).json({ error: "Couldn't process that recording. Please record it again." });
    }
    if (voicePreparation.status === "contact_missing") {
      return res.status(404).json({ error: "Contact not found." });
    }

    const {
      converted,
      transcript,
      currentContact,
      saved,
    } = voicePreparation;

    const channel = currentContact.channel || "whatsapp";
    const outboundAudio = channel === "whatsapp" ? converted.whatsapp : {
      buffer: converted.playback.buffer,
      mimeType: converted.playback.mimeType,
      filename: "voice.mp3",
    };
    const sendResult = await channelMessaging.sendAudioBuffer(
      currentContact,
      outboundAudio.buffer,
      outboundAudio.mimeType,
      outboundAudio.filename,
      socialProviderSendOptions(saved, currentContact, {
        purpose: whatsappPolicy.manualStaffPurpose(currentContact),
        requireStaffMode: currentContact.mode === "human",
        replyToProviderMessageId: replyTarget?.whatsapp_message_id || null,
      })
    );
    const errorText = sendResult.error || rejectedErrorFor(currentContact);
    const finalMessage = await persistSendOutcome(
      saved,
      sendResult,
      errorText,
      contact.channel || "whatsapp"
    );
    try {
      if (sendResult.success) {
        await contactsRepo.clearDeliveryAttentionIfNoFailedMessages(currentContact.id);
        await markLeadContacted(currentContact.id, req.session.username, sendResult);
      } else {
        await contactsRepo.setDeliveryAttention(
          currentContact.id,
          `Delivery failed: ${errorText}`
        );
      }
    } catch (attentionErr) {
      console.error("Failed to update attention after staff voice message:", attentionErr);
    }

    res.status(201).json({
      ...finalMessage,
      delivered: sendResult.success,
      transcribed: !!transcript,
    });
  } catch (err) {
    console.error("Failed to send staff voice message:", err);
    res.status(500).json({ error: "Something went wrong sending this voice message." });
  }
});

module.exports = router;