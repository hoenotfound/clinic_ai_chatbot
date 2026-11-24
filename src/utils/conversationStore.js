/**
 * Same getHistory/appendMessage interface as the old in-memory version,
 * but now backed by Postgres — so conversation history survives restarts
 * and the management portal can read the exact same data.
 */

const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const staffOwnershipService = require("../services/staffOwnershipService");
const realtimeEvents = require("./realtimeEvents");

const MAX_MESSAGES_FOR_AI_CONTEXT = 20; // bounds prompt size/cost, not what's shown in the portal
const MAX_PHOTOS_IN_AI_CONTEXT = 1;

function publishMessageChange(contactId, messageId, eventScope = {}) {
  realtimeEvents.publish("conversation_changed", {
    ...eventScope,
    contactId,
    messageId,
    reason: "message",
  });
}

function isStickerRow(row) {
  return /sent a sticker\]$/i.test(String(row?.content || "").trim());
}

function aiContextTextForRow(row) {
  const content = String(row?.content || "");
  const mimeType = String(row?.media_mime_type || "").toLowerCase();
  const trimmed = content.trim();
  const isVideoTurn =
    mimeType.startsWith("video/") ||
    /^🎥(?:\s|$)/u.test(trimmed);
  if (row?.role !== "user" || !isVideoTurn) {
    return content;
  }
  const captionless =
    /^🎥\s*\[[^\]]+ sent a video\]$/i.test(trimmed);
  if (captionless) {
    return "🎥 [Customer sent a video. The AI cannot inspect the video's visual or audio content. Do not infer what it shows or sounds like. If the customer refers to the video, say you cannot view its contents and ask them to describe the relevant part in text.]";
  }

  const caption = trimmed.replace(/^🎥\s*/u, "").trim();
  if (!caption) {
    return "🎥 [Customer sent a video. The AI cannot inspect the video's visual or audio content. Do not infer what it shows or sounds like.]";
  }

  return `🎥 [Customer sent a video. The AI cannot inspect the video's visual or audio content. Customer caption: ${caption}]`;
}

// Automated follow-ups are created by the follow-up repository with a
// recognizable, DB-verified marker. They are NOT human staff intervention,
// even though they have a sent_by_username for Inbox display.
function isVerifiedHumanStaffRow(row) {
  return row?.role === "assistant" && Boolean(row?.sent_by_username) &&
    !(row.is_automated_follow_up === true &&
      row.sent_by_username === "Follow-up automation");
}

// Prefix is applied only to authenticated outbound staff rows, never to customer text.
// Keep the model role as assistant for Claude/Gemini conversation compatibility.
const STAFF_HISTORY_PREFIX = "[Verified STAFF message] ";

// Verified pricing continuity uses database timestamps and staff authorship,
// but this metadata must not enter Gemini/Claude prompts, history JSON or
// user-facing message content. Non-enumerable fields survive the local
// pricing checks and disappear from normal serialization.
function withPricingHistoryMetadata(entry, row) {
  const rawTime = row?.created_at;
  const timestamp = rawTime instanceof Date
    ? rawTime.getTime() : Date.parse(String(rawTime ?? ""));
  Object.defineProperties(entry, {
    // Internal-only exact identity for safe 131060 prompt cleanup. The ID is
    // intentionally non-enumerable: it must not reach model prompts or the UI.
    contextMessageId: {
      value: Number.isSafeInteger(Number(row?.id)) ? Number(row.id) : null,
      enumerable: false,
    },
    pricingCreatedAtMs: {
      value: Number.isFinite(timestamp) ? timestamp : null,
      enumerable: false,
    },
    pricingStaffAuthored: {
      value: isVerifiedHumanStaffRow(row),
      enumerable: false,
    },
    // Local-only provenance for a narrow same-service pricing continuation.
    pricingDeliveredStaffImage: {
      value: isVerifiedHumanStaffRow(row) &&
        ["delivered","read"].includes(row?.delivery_status) &&
        typeof row?.whatsapp_message_id==="string" &&
        row.whatsapp_message_id.startsWith("wamid.") &&
        row.has_media_attachment===true &&
        String(row.media_mime_type||"").startsWith("image/"),
      enumerable:false,
    },
    // A readable, authenticated native-app echo establishes what staff
    // wrote, not proof that the recipient read it. It may preserve an
    // existing customer-named topic but never independently authorize a
    // quote or prove a package menu was delivered.
    pricingVerifiedStaffText: {
      value: isVerifiedHumanStaffRow(row) &&
        (["delivered","read"].includes(row?.delivery_status) ||
          (row.sent_by_username==="WhatsApp Business App" && row.delivery_status==null &&
            typeof row.whatsapp_message_id==="string" && row.whatsapp_message_id.startsWith("wamid."))) &&
        row.whatsapp_customer_mutation==null &&
        row.has_media_attachment!==true && !row.media_url && !row.media_mime_type &&
        typeof row.content==="string" && !!row.content.trim() &&
        !/\[unsupported|message deleted/iu.test(row.content),
      enumerable:false,
    },
    pricingBusinessAppPlaceholder: {
      value: isVerifiedHumanStaffRow(row) && row.sent_by_username==="WhatsApp Business App" &&
        typeof row.whatsapp_message_id==="string" && row.whatsapp_message_id.startsWith("wamid.") &&
        row.delivery_status==null && row.whatsapp_customer_mutation==null &&
        ["[unsupported sent from WhatsApp Business App]","🗑️ [Message deleted from WhatsApp Business App]"].includes(String(row.content||"").trim()) &&
        row.has_media_attachment!==true && !row.media_url && !row.media_mime_type,
      enumerable:false,
    },
    // Trusted outbound image identity is not serialized into model prompts;
    // it is used only to cross-check one-session results against the exact
    // clinic-configured media item, avoiding caption-only assumptions.
    verifiedOutboundImageUrl: {
      value: row?.role === "assistant" && typeof row?.media_url === "string"
        ? row.media_url : null,
      enumerable: false,
    },
  });
  return entry;
}

function aiVisibleRows(rows) {
  return (rows || []).filter(
    (row) =>
      !isStickerRow(row) &&
      !["revoke","edit_unavailable","unavailable_edit"].includes(
        row.whatsapp_customer_mutation
      ) &&
      (
        row.role !== "assistant" ||
        (
          !["failed", "unknown", "cancelled"].includes(row.delivery_status) &&
          // An unsent pricing claim exists briefly during the pre-send check.
          // Do not let any AI snapshot mistake the claim for a real send.
          !(row.pricing_reminder_anchor_id != null && row.delivery_status == null)
        )
      )
  );
}

async function getHistoryForContact(contactId, { throughMessageId = null } = {}) {
  let rows;
  if (throughMessageId != null) {
    const boundary = Number(throughMessageId);
    if (!Number.isSafeInteger(boundary) || boundary < 1) {
      throw new TypeError("throughMessageId must be a positive safe integer.");
    }

    // Inbound webhook payloads are now durably stored before the typing
    // debounce. A later customer message can therefore already exist in the DB
    // while the previous burst is generating its reply. Limit this AI snapshot
    // to the last message that belongs to the current burst so the model cannot
    // "see ahead" and answer the next burst twice.
    const page = await messagesRepo.getMessagePageForContact(contactId, {
      limit: MAX_MESSAGES_FOR_AI_CONTEXT,
      beforeId: boundary + 1,
      includeMedia: false,
    });
    rows = aiVisibleRows(page.rows);
  } else {
    rows = aiVisibleRows(
      await messagesRepo.getMessagesForContact(
        contactId,
        MAX_MESSAGES_FOR_AI_CONTEXT,
        false
      )
    );
  }

  // Only inbound CUSTOMER photos belong in AI vision context. Staff/AI media
  // attachments are previous outbound messages, not images the assistant may
  // claim to have inspected; Claude also prohibits image blocks in assistant turns.
  const isPhotoRow = (r) =>
    r.role === "user" && r.has_media_attachment &&
    r.media_mime_type?.startsWith("image/");
  const photoIndices = [];
  for (let i = rows.length - 1; i >= 0 && photoIndices.length < MAX_PHOTOS_IN_AI_CONTEXT; i--) {
    if (isPhotoRow(rows[i])) photoIndices.push(i);
  }

  const photoMedia = new Map();
  for (const i of photoIndices) {
    const media = await messagesRepo.getMessageMediaForContact(contactId, rows[i].id);
    if (media) photoMedia.set(i, media);
  }

  return rows.map((r, i) => {
    const media = photoMedia.get(i);
    const contextText = isVerifiedHumanStaffRow(r)
      ? `${STAFF_HISTORY_PREFIX}${aiContextTextForRow(r)}`
      : aiContextTextForRow(r);
    if (!media) return withPricingHistoryMetadata({ role: r.role, content: contextText }, r);
    return withPricingHistoryMetadata({
      role: r.role,
      content: [
        { type: "text", text: contextText },
        { type: "image", mimeType: media.media_mime_type, data: media.media_base64 },
      ],
    }, r);
  });
}

// Separate from the 20-turn AI prompt: pricing-only trusted history for
// Neutro returning customers. Never download media or enlarge normal prompts.
// One bounded page and a seven-day cut-off. If the relevant window is
// truncated, reject the recovery rather than overlooking older staff/topic
// messages. This does not authorize or send a message by itself.
async function getPricingHistoryForContact(contactId, { throughMessageId } = {}) {
  const boundary = Number(throughMessageId);
  if (!Number.isSafeInteger(boundary) || boundary < 1) return null;
  const page = await messagesRepo.getMessagePageForContact(contactId, {
    limit: 100, beforeId: boundary + 1, includeMedia: false,
  });
  const rows = page.rows || [];
  if (!rows.length || Number(rows.at(-1).id) !== boundary) return null;
  const earliest = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const oldestAt = new Date(rows[0].created_at).getTime();
  if (!Number.isFinite(oldestAt) || (page.hasMore && oldestAt >= earliest))
    return null;

  const recent = rows.filter(row => new Date(row.created_at).getTime() >= earliest);
  if (!recent.length || recent.length > 100 ||
      // An edited/revoked turn may have changed the original meaning; do not
      // silently skip a staff intervention or topic switch in this evidence.
      recent.some(row => row.whatsapp_customer_mutation ||
        !["assistant", "user"].includes(row.role) ||
        (row.role === "assistant" && (
          ["failed", "unknown", "cancelled"].includes(row.delivery_status) ||
          (row.pricing_reminder_anchor_id != null && row.delivery_status == null)
        )))) return null;

  return recent.map(row => withPricingHistoryMetadata({
    role: row.role,
    content: isVerifiedHumanStaffRow(row)
      ? STAFF_HISTORY_PREFIX + aiContextTextForRow(row)
      : aiContextTextForRow(row),
  }, row));
}

async function getHistory(waId) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  return getHistoryForContact(contact.id);
}

async function appendMessageForContact(
  contactId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaAttachment = null,
  options = {}
) {
  // Claim a synthetic AI handoff before the staff-authored row is
  // inserted. The ownership claim also writes the durable cancellation for the
  // previous AI anchor under the same conversation advisory lock used by the
  // follow-up worker. Keeping this before save prevents the new staff row from
  // replacing the AI anchor before it can be cancelled.
  //
  // Ownership bookkeeping remains best-effort: a transient failure must not
  // prevent staff from sending the message itself.
  if (sentByUsername) {
    try {
      await staffOwnershipService.claimAiHandoffOwnership(contactId, sentByUsername);
    } catch (err) {
      console.error(`Failed to claim AI handoff for contact ${contactId}:`, err);
    }
  }

  const saved = await messagesRepo.saveMessage(
    contactId,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment?.buffer || mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null,
    {
      whatsappTemplate: options.whatsappTemplate || null,
      initialDeliveryStatus: options.initialDeliveryStatus || null,
      initialDeliveryError: options.initialDeliveryError || null,
      replyToProviderMessageId: options.replyToProviderMessageId || null,
      isForwarded: options.isForwarded === true,
      mediaKey: options.mediaKey || null,
      mediaFilename: options.mediaFilename || null,
    }
  );

  if (options.publish !== false) {
    publishMessageChange(contactId, saved.id, options.eventScope);
  }
  return saved;
}

async function appendMessage(
  waId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaAttachment = null
) {
  const contact = await contactsRepo.getOrCreateContact(waId);
  return appendMessageForContact(
    contact.id,
    role,
    content,
    whatsappMessageId,
    sentByUsername,
    mediaUrl,
    mediaAttachment
  );
}

async function appendInboundMessageIfNew(contactId, content, whatsappMessageId) {
  const saved = await messagesRepo.saveInboundMessageIfNew(
    contactId,
    content,
    whatsappMessageId
  );
  if (saved) publishMessageChange(contactId, saved.id);
  return saved;
}

async function attachStoredMediaForContact(
  contactId,
  messageId,
  mediaKey,
  mediaMimeType,
  { publish = true } = {}
) {
  const updated = await messagesRepo.setMessageMediaKeyById(
    messageId,
    contactId,
    mediaKey,
    mediaMimeType
  );
  if (updated && publish) {
    realtimeEvents.publish("conversation_changed", {
      contactId,
      messageId: updated.id,
      message: updated,
      reason: "message_updated",
    });
  }
  return updated;
}

async function updateInboundMessage(contactId, messageId, content, mediaAttachment = null) {
  const updated = await messagesRepo.updateInboundMessage(
    messageId,
    contactId,
    content,
    mediaAttachment?.buffer || mediaAttachment?.data || null,
    mediaAttachment?.mimeType || null
  );
  if (updated) {
    // Include the lightweight row because an incremental `id > cursor` fetch
    // cannot see an update to a message the Inbox already loaded.
    realtimeEvents.publish("conversation_changed", {
      contactId,
      messageId: updated.id,
      message: updated,
      reason: "message_updated",
    });
  }
  return updated;
}

module.exports = {
  isVerifiedHumanStaffRow,
  withPricingHistoryMetadata,
  aiContextTextForRow,
  aiVisibleRows,
  getHistory,
  getHistoryForContact,
  getPricingHistoryForContact,
  appendMessage,
  appendMessageForContact,
  appendInboundMessageIfNew,
  attachStoredMediaForContact,
  updateInboundMessage,
};