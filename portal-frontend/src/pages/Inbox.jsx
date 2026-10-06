import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Lightbox from "../components/Lightbox";
import ContactAvatar from "../components/ContactAvatar";
import ContactDetailsDrawer from "../components/ContactDetailsDrawer";
import WhatsAppTemplateModal from "../components/WhatsAppTemplateModal";
import LeadAssignmentBadge, {
  buildLeadAssignmentFilterOptions,
  matchesLeadAssignment,
} from "../components/LeadAssignmentBadge";
import { getBusinessTerminology } from "../utils/businessTerminology";
import {
  messagingPolicyStatus,
  policyFailureExplanation,
} from "../utils/whatsappPolicy";
import {
  AlertIcon,
  ArrowLeftIcon,
  BotIcon,
  ChatOutlineIcon,
  ChevronDownIcon,
  CloseIcon,
  FlagIcon,
  ImageIcon,
  MailIcon,
  MicrophoneIcon,
  MoreIcon,
  SearchIcon,
  SendIcon,
  UserIcon,
} from "../components/InboxIcons";

const MESSAGE_PAGE_SIZE = 50;
const MAX_INCREMENTAL_MESSAGES = 100;
const DELIVERY_STATUS_BATCH_SIZE = 500;
const REALTIME_DEBOUNCE_MS = 100;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const WHATSAPP_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const IMAGE_OPTIMIZE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
const IMAGE_OPTIMIZE_MAX_DIMENSION = 1920;
const IMAGE_JPEG_QUALITY = 0.82;
const IMAGE_PROGRESSIVE_JPEG_QUALITY = 0.92;
const IMAGE_PNG_TO_JPEG_QUALITY = 0.9;
const OPTIONAL_IMAGE_PREPARATION_BUDGET_MS = 1200;
const JPEG_INSPECTION_BYTES = 1024 * 1024;
const MAX_VOICE_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_SECONDS = 120;
const VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "unreplied", label: "Unreplied" },
  { key: "follow-up", label: "Needs follow-up" },
  { key: "unread", label: "Unread" },
  { key: "attention", label: "Needs attention" },
];

function displayDeliveryError(value) {
  const raw = String(value || "").trim();
  const prefix = "partial_caption_sent|";
  if (!raw.startsWith(prefix)) return raw;
  const detail = raw.slice(prefix.length).trim();
  return detail
    ? `The caption was sent, but the image failed to send. ${detail}`
    : "The caption was sent, but the image failed to send.";
}

const DELIVERY_STATUS_RANK = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  unknown: 4,
  failed: 5,
};

function mergeMessageState(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  const existingStatus = existing.delivery_status;
  const incomingStatus = incoming.delivery_status;
  const incomingHasWamid = Object.prototype.hasOwnProperty.call(incoming, "whatsapp_message_id");
  const deliveryAttemptChanged =
    incomingHasWamid && existing.whatsapp_message_id !== incoming.whatsapp_message_id;

  if (deliveryAttemptChanged) {
    return merged;
  }

  if (
    existingStatus &&
    (!incomingStatus ||
      (DELIVERY_STATUS_RANK[existingStatus] ?? -1) >
        (DELIVERY_STATUS_RANK[incomingStatus] ?? -1))
  ) {
    merged.delivery_status = existingStatus;
    merged.delivery_error = existing.delivery_error;
  }
  return merged;
}

function newestPersistedMessageId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Number.isInteger(messages[i]?.id)) return messages[i].id;
  }
  return null;
}

function mergeMessages(existing, incoming) {
  if (!incoming?.length) return existing;
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, mergeMessageState(byId.get(message.id), message));
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aId = Number.isInteger(a.id) ? a.id : Number.MAX_SAFE_INTEGER;
    const bId = Number.isInteger(b.id) ? b.id : Number.MAX_SAFE_INTEGER;
    return aId - bId;
  });
}

function buildReplyPreview(message) {
  if (!message) return null;
  return {
    id: message.id,
    role: message.role,
    content: message.content || "",
    sent_by_username: message.sent_by_username || null,
    media_mime_type: message.media_mime_type || null,
    has_media_attachment: Boolean(
      message.has_media_attachment || message.media_base64 || message.previewUrl
    ),
    media_url: message.media_url || null,
  };
}

function replyPreviewText(message) {
  if (!message) return "Original message unavailable";
  const mimeType = String(message.media_mime_type || "").toLowerCase();
  const content = String(message.content || "").trim();
  if (mimeType.startsWith("audio/")) return content || "Voice message";
  if (mimeType === "image/webp") return "Sticker";
  if (mimeType.startsWith("image/")) {
    const placeholder = /\[[^\]]+sent (?:a photo|a sticker)\]$/iu.test(content);
    if (content && !placeholder) return content.replace(/^(?:📷|🙂)\s*/u, "");
    return /sticker/i.test(content) ? "Sticker" : "Photo";
  }
  return content || "Message";
}

function isJpegFile(file) {
  const type = String(file?.type || "").toLowerCase();
  return type === "image/jpeg" || type === "image/jpg";
}

function shouldOptimizeImageUpload(file) {
  if (!file || file.size <= IMAGE_OPTIMIZE_THRESHOLD_BYTES) return false;
  const type = String(file.type || "").toLowerCase();
  return isJpegFile(file) || type === "image/png";
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);
const JPEG_PROGRESSIVE_SOF_MARKERS = new Set([0xc2, 0xc6, 0xca, 0xce]);

function jpegFrameEncoding(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    return null;
  }

  let offset = 2;
  while (offset < bytes.length - 1) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    if (JPEG_SOF_MARKERS.has(marker)) {
      return JPEG_PROGRESSIVE_SOF_MARKERS.has(marker)
        ? "progressive"
        : "non-progressive";
    }

    offset += segmentLength;
  }

  return null;
}

async function inspectJpegEncoding(file) {
  if (!isJpegFile(file)) return null;
  try {
    // JPEG frame metadata is normally near the beginning. Bound inspection so
    // a large phone photo does not get copied in full just to read its SOF marker.
    const inspectionSize = Math.min(file.size, JPEG_INSPECTION_BYTES);
    const bytes = new Uint8Array(
      await file.slice(0, inspectionSize).arrayBuffer()
    );
    return jpegFrameEncoding(bytes);
  } catch (err) {
    console.warn("Couldn't inspect JPEG encoding:", err);
    return null;
  }
}

async function isProgressiveJpeg(file) {
  return (await inspectJpegEncoding(file)) === "progressive";
}

function canvasHasTransparency(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) return true;
  }
  return false;
}

function optimizedImageFileName(name, outputType) {
  const fallbackName = name || "image";
  const withoutExtension = fallbackName.replace(/\.[^.]+$/, "");
  if (outputType === "image/jpeg") return `${withoutExtension || "image"}.jpg`;
  if (outputType === "image/png") return `${withoutExtension || "image"}.png`;
  return fallbackName;
}

async function decodeImageForCanvas(file) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close?.(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Browser could not decode the selected image."));
      image.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

async function optimizeImageUpload(
  file,
  { normalizeProgressiveJpeg = false, forceCompatibleFormat = false } = {}
) {
  if (
    !shouldOptimizeImageUpload(file) &&
    !normalizeProgressiveJpeg &&
    !forceCompatibleFormat
  ) {
    return file;
  }

  let decoded = null;
  try {
    decoded = await decodeImageForCanvas(file);
    const largestSide = Math.max(decoded.width, decoded.height);
    const scale = Math.min(1, IMAGE_OPTIMIZE_MAX_DIMENSION / largestSide);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return file;

    context.drawImage(decoded.source, 0, 0, width, height);

    const inputType = String(file.type || "").toLowerCase();
    let outputType = "image/jpeg";
    let quality = normalizeProgressiveJpeg
      ? IMAGE_PROGRESSIVE_JPEG_QUALITY
      : IMAGE_JPEG_QUALITY;

    if (inputType === "image/png" || forceCompatibleFormat) {
      // Most promo graphics and screenshots are opaque. Sending those as
      // high-quality JPEG dramatically reduces mobile upload time while keeping
      // transparent artwork as PNG so logos/cut-outs are not damaged. For
      // WhatsApp, browser-native formats such as WebP are normalized here
      // because normal image messages accept JPEG/PNG rather than sticker WebP.
      const hasTransparency = canvasHasTransparency(context, width, height);
      outputType = hasTransparency ? "image/png" : "image/jpeg";
      quality = hasTransparency ? undefined : IMAGE_PNG_TO_JPEG_QUALITY;
    }

    let blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, outputType, quality);
    });

    if (!blob || !blob.size) return file;

    if (normalizeProgressiveJpeg && outputType === "image/jpeg") {
      const generatedEncoding = await inspectJpegEncoding(blob);
      if (generatedEncoding !== "non-progressive") {
        // Canvas encoders do not expose a baseline/progressive switch. If this
        // browser still produced a progressive (or unverifiable) JPEG, fall
        // back to PNG rather than sending the problematic JPEG bytes to Meta.
        const pngBlob = await new Promise((resolve) => {
          canvas.toBlob(resolve, "image/png");
        });
        if (!pngBlob || !pngBlob.size || pngBlob.size > MAX_IMAGE_BYTES) {
          return file;
        }
        blob = pngBlob;
        outputType = "image/png";
      }
    }

    if (!normalizeProgressiveJpeg && !forceCompatibleFormat && blob.size >= file.size) {
      return file;
    }
    if (blob.size > MAX_IMAGE_BYTES) return file;
    return new File([blob], optimizedImageFileName(file.name, outputType), {
      type: outputType,
      lastModified: file.lastModified,
    });
  } catch (err) {
    // Optimization is best-effort. A browser that cannot decode the selected
    // image should still be allowed to send the original file.
    console.warn("Image optimization skipped:", err);
    return file;
  } finally {
    decoded?.cleanup?.();
  }
}

function isConversationUnreplied(conversation) {
  return typeof conversation.has_unreplied === "boolean"
    ? conversation.has_unreplied
    : conversation.last_message_role === "user";
}

function formatPolicyDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "an unknown date";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Inbox() {
  const { user, username, permissions } = useAuth();
  const ui = getBusinessTerminology(user?.businessProfile || {});
  const showUnassignedAssignment = user?.features?.leadDistributionEnabled === true;
  const canViewAllLeads = permissions.view_all_leads === true;
  const canReplyToLeads = permissions.reply_to_assigned_leads === true;
  const { toasts, showToast, dismissToast } = useToasts();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedContactParam = searchParams.get("contact");
  const requestedContactId = /^\d+$/.test(requestedContactParam || "")
    ? Number(requestedContactParam)
    : null;

  const [conversations, setConversations] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [outboundPendingByContact, setOutboundPendingByContact] = useState({});
  const [conversationStatePending, setConversationStatePending] = useState(false);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [contactDetailsOpen, setContactDetailsOpen] = useState(false);
  const [whatsappTemplateOpen, setWhatsAppTemplateOpen] = useState(false);
  const [acquisitionContext, setAcquisitionContext] = useState(null);
  const [acquisitionLoading, setAcquisitionLoading] = useState(false);
  const selectedIdRef = useRef(selectedId);
  const acquisitionContextRef = useRef(acquisitionContext);
  const messagesRef = useRef(messages);
  const latestMessageIdRef = useRef(null);
  const threadRequestVersionRef = useRef(0);
  const outboundQueueByContactRef = useRef(new Map());

  selectedIdRef.current = selectedId;
  acquisitionContextRef.current = acquisitionContext;
  messagesRef.current = messages;
  latestMessageIdRef.current = newestPersistedMessageId(messages);

  async function refreshConversations() {
    try {
      const data = await api.listConversations();
      setConversations(data);
    } catch (err) {
      console.error("Failed to refresh conversations:", err);
    }
  }

  async function refreshAcquisitionContext(contactId) {
    if (contactId == null) {
      setAcquisitionContext(null);
      return;
    }
    try {
      const data = await api.getConversationAttribution(contactId);
      if (selectedIdRef.current === contactId) {
        setAcquisitionContext(data);
      }
    } catch (err) {
      console.error("Failed to load conversation acquisition context:", err);
      if (selectedIdRef.current === contactId) setAcquisitionContext(null);
    }
  }
  async function refreshMessagesForContact(contactId) {
    if (contactId == null) return;
    const requestVersion = ++threadRequestVersionRef.current;
    const afterId = latestMessageIdRef.current;

    try {
      const data = await api.getMessages(contactId, {
        includeMedia: false,
        limit: afterId ? MAX_INCREMENTAL_MESSAGES : MESSAGE_PAGE_SIZE,
        afterId,
      });
      if (
        selectedIdRef.current !== contactId ||
        threadRequestVersionRef.current !== requestVersion
      ) {
        return;
      }

      if (afterId) {
        if (data.messages?.length) {
          setMessages((prev) => mergeMessages(prev, data.messages));
        }
      } else {
        setMessages(data.messages || []);
        setHasMoreOlderMessages(!!data.hasMore);
      }
    } catch (err) {
      console.error("Failed to refresh messages:", err);
    }
  }

  async function reconcileLoadedDeliveryStatuses(contactId) {
    if (contactId == null) return;
    const loadedOutboundMessages = messagesRef.current.filter(
      (message) => message.role !== "user" && Number.isInteger(message.id)
    );
    const messageIds = loadedOutboundMessages.map((message) => message.id);
    const expectedWamids = new Map(
      loadedOutboundMessages.map((message) => [Number(message.id), message.whatsapp_message_id])
    );
    if (!messageIds.length) return;

    try {
      const batches = [];
      for (let index = 0; index < messageIds.length; index += DELIVERY_STATUS_BATCH_SIZE) {
        batches.push(
          api.getMessageDeliveryStatuses(
            contactId,
            messageIds.slice(index, index + DELIVERY_STATUS_BATCH_SIZE)
          )
        );
      }
      const statuses = (await Promise.all(batches)).flat();
      if (selectedIdRef.current !== contactId) return;
      const byId = new Map(statuses.map((status) => [Number(status.id), status]));
      setMessages((current) =>
        current.map((message) => {
          const status = byId.get(Number(message.id));
          if (!status) return message;

          const expectedWamid = expectedWamids.get(Number(message.id));
          if (
            message.whatsapp_message_id !== expectedWamid &&
            status.whatsapp_message_id !== message.whatsapp_message_id
          ) {
            return message;
          }

          return mergeMessageState(message, status);
        })
      );
    } catch (err) {
      console.error("Failed to reconcile delivery statuses:", err);
    }
  }

  useEffect(() => {
    refreshConversations();
  }, []);

  useEffect(() => {
    if (!conversations || selectedId != null) return;

    if (conversations.length === 0) {
      if (requestedContactParam) {
        setSearchParams({}, { replace: true });
      }
      return;
    }

    const requestedConversation = requestedContactId
      ? conversations.find(
          (conversation) => Number(conversation.contact_id) === requestedContactId
        )
      : null;
    const firstConversation = requestedConversation || conversations[0];
    setSelectedId(firstConversation.contact_id);
    if (requestedConversation) {
      setMobileThreadOpen(true);
    } else if (requestedContactParam) {
      setSearchParams({}, { replace: true });
    }

    const threadIsVisible =
      !!requestedConversation || window.matchMedia("(min-width: 1024px)").matches;
    if (firstConversation.is_unread && threadIsVisible) {
      setConversations((current) =>
        current?.map((conversation) =>
          conversation.contact_id === firstConversation.contact_id
            ? { ...conversation, is_unread: false }
            : conversation
        ) || current
      );

      api.setReadState(firstConversation.contact_id, false).catch(async (err) => {
        console.error("Failed to mark the initial conversation as read:", err);
        await refreshConversations();
        showToast("Couldn't mark this conversation as read.", "error");
      });
    }
  }, [
    conversations,
    requestedContactId,
    requestedContactParam,
    selectedId,
    setSearchParams,
    showToast,
  ]);

  useEffect(() => {
    if (!conversations || selectedId == null) return;
    const stillAccessible = conversations.some(
      (conversation) => Number(conversation.contact_id) === Number(selectedId)
    );
    if (stillAccessible) return;

    const nextConversation = conversations[0] || null;
    setSelectedId(nextConversation?.contact_id ?? null);
    setMessages([]);
    setHasMoreOlderMessages(false);
    setContactDetailsOpen(false);
    setWhatsAppTemplateOpen(false);
    setMobileThreadOpen(false);
    setSearchParams({}, { replace: true });
  }, [conversations, selectedId, setSearchParams]);

  useEffect(() => {
    if (selectedId == null) return;
    let cancelled = false;
    const requestVersion = ++threadRequestVersionRef.current;

    async function initialLoad() {
      setMessagesLoading(true);
      try {
        const data = await api.getMessages(selectedId, {
          includeMedia: false,
          limit: MESSAGE_PAGE_SIZE,
        });
        if (
          !cancelled &&
          selectedIdRef.current === selectedId &&
          threadRequestVersionRef.current === requestVersion
        ) {
          setMessages(data.messages || []);
          setHasMoreOlderMessages(!!data.hasMore);
        }
      } catch (err) {
        console.error("Failed to load messages:", err);
      } finally {
        if (!cancelled && selectedIdRef.current === selectedId) {
          setMessagesLoading(false);
        }
      }
    }

    setOlderMessagesLoading(false);
    setActionPending(false);
    setMessages([]);
    setHasMoreOlderMessages(false);
    initialLoad();

    return () => {
      cancelled = true;
      threadRequestVersionRef.current += 1;
    };
  }, [selectedId]);

  useEffect(() => {
    if (selectedId == null) {
      setAcquisitionContext(null);
      setAcquisitionLoading(false);
      return undefined;
    }

    let cancelled = false;
    setAcquisitionContext(null);
    setAcquisitionLoading(true);
    api.getConversationAttribution(selectedId)
      .then((data) => {
        if (!cancelled && selectedIdRef.current === selectedId) {
          setAcquisitionContext(data);
        }
      })
      .catch((err) => {
        console.error("Failed to load acquisition details:", err);
        if (!cancelled && selectedIdRef.current === selectedId) {
          setAcquisitionContext(null);
        }
      })
      .finally(() => {
        if (!cancelled && selectedIdRef.current === selectedId) {
          setAcquisitionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);
  useEffect(() => {
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    const pendingContactIds = new Set();
    let debounceTimer = null;

    function scheduleRefresh(contactId = null) {
      if (contactId != null) pendingContactIds.add(Number(contactId));
      if (debounceTimer) clearTimeout(debounceTimer);

      debounceTimer = setTimeout(async () => {
        const changedContacts = new Set(pendingContactIds);
        pendingContactIds.clear();
        debounceTimer = null;

        await refreshConversations();

        const currentId = selectedIdRef.current;
        if (
          currentId != null &&
          (changedContacts.size === 0 || changedContacts.has(Number(currentId)))
        ) {
          await refreshMessagesForContact(currentId);
          if (changedContacts.size === 0) {
            await reconcileLoadedDeliveryStatuses(currentId);
          }
        }
      }, REALTIME_DEBOUNCE_MS);
    }

    function handleConversationChanged(event) {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (
          payload.message &&
          payload.contactId != null &&
          Number(payload.contactId) === Number(selectedIdRef.current)
        ) {
          setMessages((current) =>
            current.some((message) => Number(message.id) === Number(payload.message.id))
              ? mergeMessages(current, [payload.message])
              : current
          );
        }
        if (
          payload.contactId != null &&
          Number(payload.contactId) === Number(selectedIdRef.current) &&
          payload.messageId != null &&
          Object.prototype.hasOwnProperty.call(payload, "deliveryStatus")
        ) {
          setMessages((current) =>
            current.map((message) =>
              Number(message.id) === Number(payload.messageId)
                ? mergeMessageState(message, {
                    whatsapp_message_id: Object.prototype.hasOwnProperty.call(
                      payload,
                      "whatsappMessageId"
                    )
                      ? payload.whatsappMessageId
                      : message.whatsapp_message_id,
                    delivery_status: payload.deliveryStatus,
                    delivery_error: payload.deliveryError || null,
                  })
                : message
            )
          );
        }
        if (
          payload.contactId != null &&
          Number(payload.contactId) === Number(selectedIdRef.current) &&
          payload.messageId != null &&
          Array.isArray(payload.reactions)
        ) {
          setMessages((current) =>
            current.map((message) =>
              Number(message.id) === Number(payload.messageId)
                ? mergeMessageState(message, { reactions: payload.reactions })
                : message
            )
          );
        }
        scheduleRefresh(payload.contactId ?? null);
      } catch (err) {
        console.error("Failed to parse realtime Inbox event:", err);
        scheduleRefresh();
      }
    }

    function handlePipelineChanged(event) {
      const currentId = selectedIdRef.current;
      if (currentId == null) return;
      try {
        const payload = JSON.parse(event.data || "{}");
        const targetsSelectedContact =
          payload.contactId != null
          && Number(payload.contactId) === Number(currentId);

        // A newly-created journey has a new lead ID. The contact ID lets the
        // selected Inbox thread refresh to that new current journey instead of
        // keeping the previous journey's acquisition context.
        if (targetsSelectedContact) {
          refreshAcquisitionContext(currentId);
          return;
        }

        const currentLeadId = acquisitionContextRef.current?.lead?.id;
        if (
          payload.leadId != null
          && currentLeadId != null
          && Number(payload.leadId) !== Number(currentLeadId)
        ) {
          return;
        }
      } catch {
        // If an event payload is malformed, a single lightweight refresh is safer
        // than leaving the visible attribution stale.
      }
      refreshAcquisitionContext(currentId);
    }

    source.addEventListener("conversation_changed", handleConversationChanged);
    source.addEventListener("pipeline_changed", handlePipelineChanged);
    source.onopen = () => {
      scheduleRefresh();
    };
    source.onerror = () => {};

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      source.removeEventListener("conversation_changed", handleConversationChanged);
      source.removeEventListener("pipeline_changed", handlePipelineChanged);
      source.close();
    };
  }, []);

  async function loadOlderMessages() {
    if (selectedId == null || olderMessagesLoading || !hasMoreOlderMessages) return;
    const contactId = selectedId;
    const oldestId = messages.find((message) => Number.isInteger(message.id))?.id;
    if (!oldestId) return;

    setOlderMessagesLoading(true);
    try {
      const data = await api.getMessages(contactId, {
        includeMedia: false,
        limit: MESSAGE_PAGE_SIZE,
        beforeId: oldestId,
      });
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(data.messages || [], prev));
        setHasMoreOlderMessages(!!data.hasMore);
      }
    } catch (err) {
      console.error("Failed to load older messages:", err);
      showToast("Couldn't load older messages. Please try again.", "error");
    } finally {
      if (selectedIdRef.current === contactId) setOlderMessagesLoading(false);
    }
  }

  async function handleTakeOver() {
    if (selectedId == null) return;
    const contactId = selectedId;
    setActionPending(true);
    try {
      await api.takeOver(contactId);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to take over conversation:", err);
      showToast("Couldn't take over this conversation — please try again.", "error");
    } finally {
      if (selectedIdRef.current === contactId) setActionPending(false);
    }
  }

  async function handleReturnToAi() {
    if (selectedId == null) return;
    const contactId = selectedId;
    setActionPending(true);
    try {
      await api.returnToAi(contactId);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to return conversation to AI:", err);
      showToast("Couldn't return this conversation to the AI — please try again.", "error");
    } finally {
      if (selectedIdRef.current === contactId) setActionPending(false);
    }
  }

  async function handleDismissAttention() {
    if (selectedId == null) return;
    const contactId = selectedId;
    try {
      await api.setAttention(contactId, false);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to dismiss attention flag:", err);
    }
  }

  function updateConversationLocally(contactId, updates) {
    setConversations((current) =>
      current?.map((conversation) =>
        conversation.contact_id === contactId ? { ...conversation, ...updates } : conversation
      ) || current
    );
  }

  async function handleSelectConversation(contactId) {
    setSelectedId(contactId);
    setSearchParams({ contact: String(contactId) }, { replace: true });
    setMobileThreadOpen(true);
    const conversation = conversations?.find((item) => item.contact_id === contactId);
    if (!conversation?.is_unread) return;

    updateConversationLocally(contactId, { is_unread: false });
    try {
      await api.setReadState(contactId, false);
    } catch (err) {
      console.error("Failed to mark conversation as read:", err);
      await refreshConversations();
      showToast("Couldn't mark this conversation as read.", "error");
    }
  }

  async function handleToggleFollowUp() {
    const conversation = conversations?.find((item) => item.contact_id === selectedId);
    if (!conversation || conversationStatePending) return;

    const needsFollowUp = !conversation.needs_follow_up;
    setConversationStatePending(true);
    updateConversationLocally(conversation.contact_id, { needs_follow_up: needsFollowUp });
    try {
      await api.setFollowUp(conversation.contact_id, needsFollowUp);
    } catch (err) {
      console.error("Failed to update follow-up state:", err);
      updateConversationLocally(conversation.contact_id, {
        needs_follow_up: conversation.needs_follow_up,
      });
      showToast("Couldn't update the follow-up flag.", "error");
    } finally {
      setConversationStatePending(false);
    }
  }

  async function handleToggleUnread() {
    const conversation = conversations?.find((item) => item.contact_id === selectedId);
    if (!conversation || conversationStatePending) return;

    const isUnread = !conversation.is_unread;
    setConversationStatePending(true);
    updateConversationLocally(conversation.contact_id, { is_unread: isUnread });
    try {
      await api.setReadState(conversation.contact_id, isUnread);
    } catch (err) {
      console.error("Failed to update read state:", err);
      updateConversationLocally(conversation.contact_id, { is_unread: conversation.is_unread });
      showToast("Couldn't update the read state.", "error");
    } finally {
      setConversationStatePending(false);
    }
  }

  async function handleRetryMessage(messageId) {
    const contactId = selectedIdRef.current;
    if (contactId == null) return;

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, _retrying: true } : message
      )
    );

    try {
      const result = await api.retryMessage(contactId, messageId);
      if (selectedIdRef.current === contactId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? {
                  ...mergeMessageState(message, result),
                  _retrying: false,
                }
              : message
          )
        );
      }
      await refreshConversations();

      if (result.accepted) {
        showToast("Message queued again.", "info");
      } else {
        showToast(result.retry_error || "WhatsApp still couldn't accept this message.", "warning");
      }
    } catch (err) {
      console.error("Failed to retry message:", err);
      if (selectedIdRef.current === contactId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId ? { ...message, _retrying: false } : message
          )
        );
      }
      showToast(err.message || "Couldn't retry this message.", "error");
    }
  }

  function makeOptimisticId() {
    return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function adjustOutboundPending(contactId, delta) {
    setOutboundPendingByContact((current) => {
      const key = String(contactId);
      const nextCount = Math.max(0, Number(current[key] || 0) + delta);
      if (nextCount === Number(current[key] || 0)) return current;
      const next = { ...current };
      if (nextCount > 0) next[key] = nextCount;
      else delete next[key];
      return next;
    });
  }

  function enqueueOutbound(contactId, task) {
    const key = String(contactId);
    const previous =
      outboundQueueByContactRef.current.get(key) || Promise.resolve();

    adjustOutboundPending(contactId, 1);
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    outboundQueueByContactRef.current.set(key, tail);

    return run.finally(() => {
      adjustOutboundPending(contactId, -1);
      if (outboundQueueByContactRef.current.get(key) === tail) {
        outboundQueueByContactRef.current.delete(key);
      }
    });
  }

  async function handleSend(text, replyToMessageId = null) {
    if (selectedId == null || !text.trim()) return;
    const contactId = selectedId;

    const optimisticId = makeOptimisticId();
    const replyTarget = replyToMessageId == null
      ? null
      : messagesRef.current.find((message) => Number(message.id) === Number(replyToMessageId));
    const replyPreview = buildReplyPreview(replyTarget);
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "assistant",
        content: text.trim(),
        sent_by_username: username,
        created_at: new Date().toISOString(),
        media_url: null,
        media_base64: null,
        media_mime_type: null,
        reply_to_provider_message_id: replyTarget?.whatsapp_message_id || null,
        reply_preview: replyPreview,
        _optimistic: true,
      },
    ]);

    try {
      const result = await enqueueOutbound(
        contactId,
        () => api.sendMessage(contactId, text.trim(), replyToMessageId)
      );
      const visibleResult = replyPreview ? { ...result, reply_preview: replyPreview } : result;
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev.filter((m) => m.id !== optimisticId), [visibleResult]));
      }
      void refreshConversations();
      if (result?.delivery_unknown === true) {
        showToast(
          "Message send could not be confirmed. Check WhatsApp before retrying to avoid sending it twice.",
          "warning"
        );
      } else if (result?.delivered === false) {
        showToast(`Message saved but WhatsApp delivery failed — the ${ui.customerSingular} may not have received it. Please try resending.`, "warning");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      }
      showToast(err.message || "Couldn't send that message — please try again.", "error");
      throw err;
    }
  }

  async function handleSendImage(file, caption, replyToMessageId = null) {
    if (selectedId == null || !file) return;
    const contactId = selectedId;

    const optimisticId = makeOptimisticId();
    const previewUrl = URL.createObjectURL(file);
    const replyTarget = replyToMessageId == null
      ? null
      : messagesRef.current.find((message) => Number(message.id) === Number(replyToMessageId));
    const replyPreview = buildReplyPreview(replyTarget);
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "assistant",
        content: caption,
        sent_by_username: username,
        created_at: new Date().toISOString(),
        media_url: null,
        media_base64: null,
        media_mime_type: null,
        previewUrl,
        reply_to_provider_message_id: replyTarget?.whatsapp_message_id || null,
        reply_preview: replyPreview,
        _optimistic: true,
        _uploading: true,
      },
    ]);

    try {
      const result = await enqueueOutbound(
        contactId,
        () => api.sendImage(contactId, file, caption, replyToMessageId)
      );
      const visibleResult = replyPreview ? { ...result, reply_preview: replyPreview } : result;
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev.filter((m) => m.id !== optimisticId), [visibleResult]));
      }
      void refreshConversations();
      if (result?.delivery_unknown === true) {
        showToast(
          "Image send could not be confirmed. Check WhatsApp before retrying to avoid sending it twice.",
          "warning"
        );
      } else if (result?.delivered === false) {
        showToast(`Image saved but WhatsApp delivery failed — the ${ui.customerSingular} may not have received it. Please try resending.`, "warning");
      }
    } catch (err) {
      console.error("Failed to send image:", err);
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      }
      showToast(err.message || "Couldn't send that image — please try again.", "error");
      throw err;
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
  }

  async function handleSendVoice(recording, mimeType, replyToMessageId = null) {
    if (selectedId == null || !recording) return;
    const contactId = selectedId;
    const replyTarget = replyToMessageId == null
      ? null
      : messagesRef.current.find((message) => Number(message.id) === Number(replyToMessageId));
    const replyPreview = buildReplyPreview(replyTarget);

    try {
      const result = await enqueueOutbound(
        contactId,
        () => api.sendVoice(contactId, recording, mimeType, replyToMessageId)
      );
      const visibleResult = replyPreview ? { ...result, reply_preview: replyPreview } : result;
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev, [{ ...visibleResult, has_media_attachment: true }]));
      }
      void refreshConversations();
      if (result?.delivery_unknown === true) {
        showToast(
          "Voice message send could not be confirmed. Check WhatsApp before recording it again to avoid duplicates.",
          "warning"
        );
      } else if (result?.delivered === false) {
        showToast(`Voice message saved but WhatsApp delivery failed — the ${ui.customerSingular} may not have received it. Please try recording again.`, "warning");
      } else if (result?.transcribed === false) {
        showToast("Voice message sent. Its transcript couldn't be generated, but the recording was saved.", "info");
      }
    } catch (err) {
      console.error("Failed to send voice message:", err);
      showToast(err.message || "Couldn't send that voice message — please try again.", "error");
      throw err;
    }
  }

  async function handleForwardMessage(messageId, targetContactIds) {
    if (selectedId == null || !Number.isInteger(Number(messageId))) return null;
    const sourceContactId = selectedId;
    const result = await api.forwardMessage(sourceContactId, messageId, targetContactIds);
    const visibleMessages = (result?.results || [])
      .filter((item) => Number(item.contactId) === Number(selectedIdRef.current) && item.message)
      .map((item) => item.message);
    if (visibleMessages.length) {
      setMessages((current) => mergeMessages(current, visibleMessages));
    }
    void refreshConversations();
    return result;
  }

  function handleBackToConversationList() {
    setMobileThreadOpen(false);
    setSearchParams({}, { replace: true });
  }

  const selectedContact = conversations?.find((c) => c.contact_id === selectedId);

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={handleSelectConversation}
        mobileThreadOpen={mobileThreadOpen}
        currentUsername={username}
        canViewAllLeads={canViewAllLeads}
        showUnassignedAssignment={showUnassignedAssignment}
        customerPlural={ui.customerPlural}
      />
      <ThreadView
        key={selectedId ?? "no-conversation"}
        contact={selectedContact}
        conversations={conversations || []}
        currentUsername={username}
        canReplyToLeads={canReplyToLeads}
        showUnassignedAssignment={showUnassignedAssignment}
        messages={messages}
        loading={messagesLoading}
        olderMessagesLoading={olderMessagesLoading}
        hasMoreOlderMessages={hasMoreOlderMessages}
        actionPending={
          actionPending ||
          Boolean(outboundPendingByContact[String(selectedId)] || 0)
        }
        conversationStatePending={conversationStatePending}
        acquisitionContext={acquisitionContext}
        acquisitionLoading={acquisitionLoading}
        onLoadOlder={loadOlderMessages}
        onTakeOver={handleTakeOver}
        onReturnToAi={handleReturnToAi}
        onDismissAttention={handleDismissAttention}
        onToggleFollowUp={handleToggleFollowUp}
        onToggleUnread={handleToggleUnread}
        onRetryMessage={handleRetryMessage}
        onSend={handleSend}
        onSendImage={handleSendImage}
        onSendVoice={handleSendVoice}
        onForwardMessage={handleForwardMessage}
        onOpenContactDetails={() => setContactDetailsOpen(true)}
        onOpenWhatsAppTemplates={() => setWhatsAppTemplateOpen(true)}
        onToast={showToast}
        mobileThreadOpen={mobileThreadOpen}
        onBack={handleBackToConversationList}
        customerSingular={ui.customerSingular}
      />
      <ContactDetailsDrawer
        open={contactDetailsOpen}
        contact={selectedContact}
        onClose={() => setContactDetailsOpen(false)}
      />
      {whatsappTemplateOpen &&
        canReplyToLeads &&
        selectedContact?.channel === "whatsapp" && (
        <WhatsAppTemplateModal
          contact={selectedContact}
          onClose={() => setWhatsAppTemplateOpen(false)}
          onOptInRecorded={async () => {
            await refreshConversations();
            showToast("WhatsApp opt-in recorded.", "info");
          }}
          onSent={async (result) => {
            if (selectedIdRef.current === selectedContact.contact_id) {
              setMessages((current) => mergeMessages(current, [result]));
            }
            await refreshConversations();
            if (result?.delivery_status === "unknown") {
              showToast(
                "Template saved, but delivery could not be confirmed. Check WhatsApp before retrying.",
                "warning"
              );
            } else if (result?.delivered === false) {
              showToast(
                "Template saved, but WhatsApp did not accept the send. You can retry it from the message.",
                "warning"
              );
            } else {
              showToast("WhatsApp template sent.", "info");
            }
          }}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ConversationList({
  conversations,
  selectedId,
  onSelect,
  mobileThreadOpen,
  currentUsername,
  canViewAllLeads,
  showUnassignedAssignment,
  customerPlural,
}) {
  const [filters, setFilters] = useState({
    status: "all",
    channel: "all",
    control: "all",
    assignment: "all",
    query: "",
  });
  const [filtersOpen, setFiltersOpen] = useState(false);

  const conversationList = useMemo(() => conversations || [], [conversations]);
  const assignmentOptions = useMemo(
    () => buildLeadAssignmentFilterOptions(conversationList, currentUsername, {
      includeUnassigned: showUnassignedAssignment,
    }),
    [conversationList, currentUsername, showUnassignedAssignment]
  );
  const statusCounts = useMemo(
    () => ({
      all: conversationList.length,
      unreplied: conversationList.filter(isConversationUnreplied).length,
      "follow-up": conversationList.filter((item) => item.needs_follow_up).length,
      unread: conversationList.filter((item) => item.is_unread).length,
      attention: conversationList.filter((item) => item.needs_attention).length,
    }),
    [conversationList]
  );
  const statusOptions = useMemo(
    () =>
      STATUS_FILTERS.map((filter) => [
        filter.key,
        `${filter.label} (${statusCounts[filter.key]})`,
      ]),
    [statusCounts]
  );

  useEffect(() => {
    if (
      (!canViewAllLeads && filters.assignment !== "all") ||
      (!showUnassignedAssignment && filters.assignment === "unassigned")
    ) {
      setFilters((current) => ({ ...current, assignment: "all" }));
    }
  }, [canViewAllLeads, filters.assignment, showUnassignedAssignment]);

  const filteredConversations = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return conversationList.filter((conversation) => {
      if (filters.status === "unreplied" && !isConversationUnreplied(conversation)) return false;
      if (filters.status === "follow-up" && !conversation.needs_follow_up) return false;
      if (filters.status === "unread" && !conversation.is_unread) return false;
      if (filters.status === "attention" && !conversation.needs_attention) return false;
      if (filters.channel !== "all" && (conversation.channel || "whatsapp") !== filters.channel) return false;
      if (filters.control !== "all" && conversation.mode !== filters.control) return false;
      if (
        canViewAllLeads &&
        !matchesLeadAssignment(conversation, filters.assignment, currentUsername)
      ) return false;
      if (!query) return true;

      const searchableText = [
        displayName(conversation),
        conversation.whatsapp_number,
        conversation.last_message,
        conversation.lead_owner_display_name,
        conversation.lead_owner_username,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(query);
    });
  }, [conversationList, filters, currentUsername, canViewAllLeads]);

  const activeFilterCount =
    (filters.status !== "all" ? 1 : 0) +
    (filters.channel !== "all" ? 1 : 0) +
    (filters.control !== "all" ? 1 : 0) +
    (canViewAllLeads && filters.assignment !== "all" ? 1 : 0);

  const hasActiveFilters = activeFilterCount > 0 || !!filters.query.trim();

  const activeFilterChips = useMemo(() => {
    const active = [];
    if (filters.status !== "all") {
      const label = STATUS_FILTERS.find((item) => item.key === filters.status)?.label;
      active.push({ key: "status", label: label || "Status" });
    }
    if (canViewAllLeads && filters.assignment !== "all") {
      const label = assignmentOptions.find(([value]) => value === filters.assignment)?.[1];
      active.push({ key: "assignment", label: `Owner · ${label || "Selected"}` });
    }
    if (filters.channel !== "all") {
      const channelLabels = {
        whatsapp: "WhatsApp",
        facebook: "Facebook",
        instagram: "Instagram",
      };
      active.push({ key: "channel", label: channelLabels[filters.channel] || filters.channel });
    }
    if (filters.control !== "all") {
      active.push({
        key: "control",
        label: filters.control === "human" ? "Handled by · Staff" : "Handled by · AI",
      });
    }
    return active;
  }, [assignmentOptions, canViewAllLeads, filters.assignment, filters.channel, filters.control, filters.status]);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearAppliedFilters() {
    setFilters((current) => ({
      ...current,
      status: "all",
      channel: "all",
      control: "all",
      assignment: "all",
    }));
  }

  function clearFilters() {
    setFilters({ status: "all", channel: "all", control: "all", assignment: "all", query: "" });
  }

  return (
    <aside
      className={`${mobileThreadOpen ? "hidden lg:flex" : "flex"} h-full w-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:w-[19rem] xl:w-[20.5rem] 2xl:w-[22rem]`}
      aria-label="Conversation inbox"
    >
      <header className="shrink-0 border-b border-[var(--color-border)] px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-xl font-bold tracking-[-0.02em]">Inbox</h1>
          <p className="shrink-0 text-[11px] text-[var(--color-text-muted)]" aria-live="polite">
            {!conversations
              ? "Loading…"
              : hasActiveFilters
              ? `${filteredConversations.length} / ${conversationList.length}`
              : conversationList.length}
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="search"
              value={filters.query}
              onChange={(event) => updateFilter("query", event.target.value)}
              placeholder="Search conversations"
              aria-label="Search by name, number, message, or assignee"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] py-2.5 pl-9 pr-9 text-xs outline-none transition focus:border-[var(--color-primary)] focus:bg-white focus:ring-2 focus:ring-[var(--color-primary-light)]"
            />
            {filters.query && (
              <button
                type="button"
                onClick={() => updateFilter("query", "")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-text)]"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setFiltersOpen((current) => !current)}
            aria-expanded={filtersOpen}
            aria-controls="inbox-filter-panel"
            className={`inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[11px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${
              filtersOpen || activeFilterCount > 0
                ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                : "border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:border-[var(--color-primary)]/35 hover:text-[var(--color-text)]"
            }`}
          >
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[10px] font-bold leading-none text-white">
                {activeFilterCount}
              </span>
            )}
            <ChevronDownIcon
              className={`h-3 w-3 transition-transform ${filtersOpen ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        {filtersOpen && (
          <div
            id="inbox-filter-panel"
            className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/70 p-3"
            aria-label="Inbox filters"
          >
            {activeFilterCount > 0 && (
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={clearAppliedFilters}
                  className="rounded-lg px-2 py-1 text-[10px] font-semibold text-[var(--color-primary)] hover:bg-white"
                >
                  Clear filters
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <FilterSelect
                label="Status"
                value={filters.status}
                onChange={(value) => updateFilter("status", value)}
                options={statusOptions}
              />
              <FilterSelect
                label="Channel"
                value={filters.channel}
                onChange={(value) => updateFilter("channel", value)}
                options={[
                  ["all", "All"],
                  ["whatsapp", "WhatsApp"],
                  ["facebook", "Facebook"],
                  ["instagram", "Instagram"],
                ]}
              />
              <FilterSelect
                label="Handled by"
                value={filters.control}
                onChange={(value) => updateFilter("control", value)}
                options={[
                  ["all", "Any"],
                  ["ai", "AI"],
                  ["human", "Staff"],
                ]}
              />
              {canViewAllLeads ? (
                <FilterSelect
                  label="Lead owner"
                  value={filters.assignment}
                  onChange={(value) => updateFilter("assignment", value)}
                  options={assignmentOptions}
                />
              ) : (
                <div className="min-w-0 rounded-lg border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)]/60 px-2.5 py-2">
                  <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    Lead owner
                  </span>
                  <span className="mt-1 inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--color-primary)]">
                    <UserIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">My assigned leads</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeFilterChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Active Inbox filters">
            {activeFilterChips.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => updateFilter(filter.key, "all")}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-primary-light)] px-2 py-1 text-[10px] font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary)] hover:text-white"
                title={`Remove ${filter.label} filter`}
              >
                <span className="truncate">{filter.label}</span>
                <CloseIcon className="h-2.5 w-2.5 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {!conversations && <ConversationListSkeleton />}

        {conversations && conversations.length === 0 && (
          <EmptyListState
            title={canViewAllLeads ? "No conversations yet" : "No assigned conversations"}
            description={
              canViewAllLeads
                ? `New ${customerPlural} messages will appear here automatically.`
                : "Leads assigned to you will appear here automatically."
            }
          />
        )}

        {conversations && conversations.length > 0 && filteredConversations.length === 0 && (
          <EmptyListState
            title="No matching conversations"
            description="Try changing your search or filters."
            action={
              <button
                type="button"
                onClick={clearFilters}
                className="mt-4 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-xs font-semibold hover:bg-[var(--color-bg)]"
              >
                Clear filters
              </button>
            }
          />
        )}

        {filteredConversations.map((conversation) => {
          const selected = conversation.contact_id === selectedId;
          return (
            <button
              key={conversation.contact_id}
              type="button"
              onClick={() => onSelect(conversation.contact_id)}
              aria-current={selected ? "true" : undefined}
              className={`group mb-0.5 w-full rounded-xl px-3 py-2.5 text-left outline-none transition ${
                selected
                  ? "bg-[var(--color-primary-light)]"
                  : "hover:bg-[var(--color-bg)]"
              } focus:ring-2 focus:ring-inset focus:ring-[var(--color-primary)]/35`}
            >
              <div className="flex items-start gap-3">
                <ContactAvatar src={conversation.photo_url} channel={conversation.channel} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${conversation.is_unread ? "font-semibold" : "font-medium"}`}>
                      {displayName(conversation)}
                    </span>
                    <span className={`shrink-0 text-[10px] ${conversation.is_unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
                      {formatConversationTime(conversation.last_message_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className={`min-w-0 flex-1 truncate text-xs leading-5 ${conversation.is_unread ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                      {conversation.last_message_media_url ? "Photo · " : ""}
                      {conversation.last_message || (conversation.last_message_media_url ? "Attachment" : "No messages yet")}
                    </p>
                    {conversation.is_unread && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" title="Unread" />
                    )}
                  </div>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                    <LeadAssignmentBadge
                      ownerUsername={conversation.lead_owner_username}
                      ownerDisplayName={conversation.lead_owner_display_name}
                      currentUsername={currentUsername}
                      compact
                      showUnassigned={showUnassignedAssignment}
                    />
                    <ControlIndicator mode={conversation.mode} />
                    {conversation.needs_follow_up && <StatusBadge tone="accent">Needs follow-up</StatusBadge>}
                    {conversation.needs_attention && <StatusBadge tone="danger">Attention</StatusBadge>}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        {label}
      </span>
      <span className="relative block">
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full appearance-none rounded-lg border border-[var(--color-border)] bg-white py-2 pl-2.5 pr-7 text-[11px] font-medium text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
        >
          {options.map(([optionValue, optionLabel]) => (
            <option key={optionValue} value={optionValue}>{optionLabel}</option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]" />
      </span>
    </label>
  );
}

function ConversationListSkeleton() {
  return (
    <div className="space-y-1 p-1" aria-label="Loading conversations">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="flex animate-pulse items-center gap-3 rounded-xl px-2 py-2.5">
          <div className="h-[42px] w-[42px] shrink-0 rounded-full bg-[var(--color-border)]/70" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-2/3 rounded bg-[var(--color-border)]/70" />
            <div className="h-2.5 w-full rounded bg-[var(--color-border)]/50" />
            <div className="h-2 w-1/2 rounded bg-[var(--color-border)]/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyListState({ title, description, action }) {
  return (
    <div className="px-5 py-14 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
        <ChatOutlineIcon className="h-5 w-5" />
      </div>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-[15rem] text-xs leading-5 text-[var(--color-text-muted)]">{description}</p>
      {action}
    </div>
  );
}

function StatusBadge({ tone, children }) {
  const styles = {
    accent: "bg-[var(--color-accent-light)] text-[#8a5d13]",
    danger: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${styles[tone]}`}>
      {children}
    </span>
  );
}

function AcquisitionContextBar({ context, loading }) {
  if (loading) {
    return (
      <div className="border-t border-[var(--color-border)] bg-white px-3 py-1.5 sm:px-5 sm:py-2">
        <div className="h-3 w-52 animate-pulse rounded bg-[var(--color-border)]/60" />
      </div>
    );
  }

  const attribution = context?.attribution;
  const lead = context?.lead;
  if (!attribution || attribution.source !== "meta_ads") return null;

  const adName = attribution.ad_name || attribution.headline || (attribution.meta_ad_id ? `Ad ${attribution.meta_ad_id}` : "Meta ad");
  const campaignName = attribution.campaign_name || "Campaign details pending";
  const temperature = lead?.temperature
    ? lead.temperature.charAt(0).toUpperCase() + lead.temperature.slice(1)
    : null;

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 sm:border-blue-100 sm:bg-blue-50/70 sm:px-5 sm:py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] sm:gap-2 sm:text-[11px]">
        <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 font-bold text-blue-700">
          Meta Ads
        </span>
        <span className="min-w-0 truncate font-semibold text-[var(--color-text)]" title={adName || undefined}>
          {adName}
        </span>
        <span className="hidden shrink-0 text-[var(--color-text-muted)] sm:inline">·</span>
        <span className="hidden min-w-0 truncate text-[var(--color-text-muted)] sm:inline" title={campaignName}>
          {campaignName}
        </span>
        {temperature && (
          <span className="ml-auto shrink-0 rounded-full bg-white px-2 py-0.5 font-semibold text-[var(--color-text-muted)]">
            {temperature}
          </span>
        )}
      </div>
    </div>
  );
}
function ThreadLoadingSkeleton() {
  return (
    <div className="space-y-4 py-4" aria-label="Loading messages">
      <div className="h-14 w-2/3 animate-pulse rounded-2xl rounded-bl-md bg-white shadow-sm" />
      <div className="ml-auto h-20 w-3/5 animate-pulse rounded-2xl rounded-br-md bg-[var(--color-primary)]/20" />
      <div className="h-20 w-1/2 animate-pulse rounded-2xl rounded-bl-md bg-white shadow-sm" />
      <div className="ml-auto h-14 w-2/3 animate-pulse rounded-2xl rounded-br-md bg-[var(--color-primary)]/20" />
    </div>
  );
}

function shouldShowDateSeparator(messages, index) {
  if (index === 0) return true;
  const current = new Date(messages[index]?.created_at);
  const previous = new Date(messages[index - 1]?.created_at);
  if (Number.isNaN(current.getTime()) || Number.isNaN(previous.getTime())) return false;
  return current.toDateString() !== previous.toDateString();
}

function DateSeparator({ value }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const label =
    date.toDateString() === today.toDateString()
      ? "Today"
      : date.toDateString() === yesterday.toDateString()
      ? "Yesterday"
      : date.toLocaleDateString([], { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });

  return (
    <div className="py-2.5 text-center" aria-label={label}>
      <span className="text-[10px] font-medium text-[var(--color-text-muted)]">{label}</span>
    </div>
  );
}

function ThreadView({
  contact,
  conversations,
  currentUsername,
  canReplyToLeads,
  showUnassignedAssignment,
  messages,
  loading,
  olderMessagesLoading,
  hasMoreOlderMessages,
  actionPending,
  conversationStatePending,
  acquisitionContext,
  acquisitionLoading,
  onLoadOlder,
  onTakeOver,
  onReturnToAi,
  onDismissAttention,
  onToggleFollowUp,
  onToggleUnread,
  onRetryMessage,
  onSend,
  onSendImage,
  onSendVoice,
  onForwardMessage,
  onOpenContactDetails,
  onOpenWhatsAppTemplates,
  onToast,
  mobileThreadOpen,
  onBack,
  customerSingular,
}) {
  const bottomRef = useRef(null);
  const threadScrollRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const recordingStartingRef = useRef(false);
  const recordingRequestIdRef = useRef(0);
  const imagePreparationIdRef = useRef(0);
  const draftEditVersionRef = useRef(0);
  const composerSendVersionRef = useRef(0);
  const actionsMenuRef = useRef(null);
  const mountedRef = useRef(true);
  const activeContactIdRef = useRef(contact?.contact_id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [imagePreparing, setImagePreparing] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceBlob, setVoiceBlob] = useState(null);
  const [voiceMimeType, setVoiceMimeType] = useState("");
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const [forwardingMessage, setForwardingMessage] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [policyNow, setPolicyNow] = useState(Date.now());

  activeContactIdRef.current = contact?.contact_id;
  const messagingPolicy = messagingPolicyStatus(contact, policyNow);
  const policyBlocksComposer = messagingPolicy.applies && !messagingPolicy.manualReplyAllowed;
  const quietReplyAvailable =
    messagingPolicy.applies &&
    messagingPolicy.freeformAllowed &&
    !messagingPolicy.optedOutAt;
  const whatsappTemplateAvailable =
    canReplyToLeads &&
    messagingPolicy.channel === "whatsapp" &&
    !messagingPolicy.freeformAllowed;
  const whatsappTemplateOptInRecorded = Boolean(
    (contact?.whatsapp_opt_in_at || contact?.whatsappOptInAt) &&
    (contact?.whatsapp_opt_in_source || contact?.whatsappOptInSource)
  );
  const whatsappTemplateNeedsOptIn =
    whatsappTemplateAvailable && !whatsappTemplateOptInRecorded;
  const replyWindowCompactLabel = quietReplyAvailable
    ? String(messagingPolicy.label || "")
        .replace(/^Reply available\s*·\s*/i, "")
        .replace(/\s+remaining$/i, "")
    : "";
  const composerPlaceholder = policyBlocksComposer
    ? `${messagingPolicy.channelLabel} reply unavailable`
    : imageFile
    ? "Add a caption…"
    : contact?.mode === "human"
    ? "Message…"
    : "Reply…";
  const composerLabel = policyBlocksComposer
    ? `${messagingPolicy.channelLabel} reply unavailable`
    : imageFile
    ? "Add a caption to the selected image"
    : contact?.mode === "human"
    ? `Message this ${customerSingular}`
    : "Reply manually while AI stays on";

  useEffect(() => {
    setPolicyNow(Date.now());
    const timer = setInterval(() => setPolicyNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, [contact?.contact_id]);

  useEffect(() => {
    setAttentionExpanded(false);
  }, [contact?.contact_id, contact?.attention_reason]);

  useEffect(() => {
    setReplyingTo(null);
    setForwardingMessage(null);
  }, [contact?.contact_id]);

  useEffect(() => {
    if (!loading && messages.length > 0 && shouldStickToBottomRef.current) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    }
  }, [messages, loading]);

  useEffect(() => {
    if (!policyBlocksComposer) return;
    cancelRecording();
    clearVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyBlocksComposer]);

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  useEffect(() => () => {
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
  }, [voicePreviewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingRequestIdRef.current += 1;
      recordingStartingRef.current = false;
      discardRecordingRef.current = true;
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder?.state !== "inactive") recorder?.stop();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [draft, composerPlaceholder]);

  useEffect(() => {
    if (!actionsOpen) return;

    function handlePointerDown(event) {
      if (!actionsMenuRef.current?.contains(event.target)) setActionsOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setActionsOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  function handleThreadScroll() {
    const el = threadScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 120;
  }

  function handleDraftChange(event) {
    draftEditVersionRef.current += 1;
    setDraft(event.target.value);
  }

  async function selectImageFile(file) {
    if (!file) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }
    if (isStartingRecording || isRecording || voiceBlob) {
      onToast("Finish or remove the voice message before adding an image.", "warning");
      return;
    }
    if (!file.type.startsWith("image/")) {
      onToast("Please choose an image file.", "error");
      return;
    }
    // Selecting a new attachment is a user composer edit. An older queued
    // send that fails later must not restore its caption onto this new photo.
    draftEditVersionRef.current += 1;
    if (file.size > MAX_IMAGE_BYTES) {
      onToast("That image is larger than 16MB — please choose a smaller file.", "error");
      return;
    }

    const isWhatsApp = (contact?.channel || "whatsapp") === "whatsapp";
    const inputMimeType = String(file.type || "").toLowerCase();
    const forceCompatibleFormat =
      isWhatsApp && !WHATSAPP_IMAGE_MIME_TYPES.has(inputMimeType);

    const preparationId = imagePreparationIdRef.current + 1;
    imagePreparationIdRef.current = preparationId;
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    const nextPreviewUrl = URL.createObjectURL(file);
    setImageFile(file);
    setImagePreviewUrl(nextPreviewUrl);

    const couldNeedPreparation =
      shouldOptimizeImageUpload(file) ||
      isJpegFile(file) ||
      forceCompatibleFormat ||
      (isWhatsApp && file.size > WHATSAPP_IMAGE_MAX_BYTES);
    setImagePreparing(couldNeedPreparation);
    if (!couldNeedPreparation) return;

    try {
      const normalizeProgressiveJpeg = await isProgressiveJpeg(file);
      const shouldOptimize =
        shouldOptimizeImageUpload(file) ||
        normalizeProgressiveJpeg ||
        forceCompatibleFormat ||
        (isWhatsApp && file.size > WHATSAPP_IMAGE_MAX_BYTES);
      if (!shouldOptimize) return;

      const mandatoryPreparation =
        normalizeProgressiveJpeg ||
        forceCompatibleFormat ||
        (isWhatsApp && file.size > WHATSAPP_IMAGE_MAX_BYTES);
      const optimizationPromise = optimizeImageUpload(file, {
        normalizeProgressiveJpeg,
        forceCompatibleFormat,
      });

      let optimizedFile;
      if (mandatoryPreparation) {
        optimizedFile = await optimizationPromise;
      } else {
        const prepared = await Promise.race([
          optimizationPromise.then((value) => ({ completed: true, value })),
          new Promise((resolve) => {
            window.setTimeout(
              () => resolve({ completed: false, value: null }),
              OPTIONAL_IMAGE_PREPARATION_BUDGET_MS
            );
          }),
        ]);
        if (!prepared.completed) {
          // Optional compression must never make a valid image feel stuck.
          // Keep the already-selected original and ignore the late optimizer.
          if (
            mountedRef.current &&
            imagePreparationIdRef.current === preparationId
          ) {
            imagePreparationIdRef.current += 1;
            setImagePreparing(false);
          }
          optimizationPromise.catch(() => {});
          return;
        }
        optimizedFile = prepared.value;
      }

      if (
        !mountedRef.current ||
        imagePreparationIdRef.current !== preparationId
      ) {
        return;
      }

      const optimizedMimeType = String(optimizedFile.type || "").toLowerCase();
      if (
        isWhatsApp &&
        !WHATSAPP_IMAGE_MIME_TYPES.has(optimizedMimeType)
      ) {
        URL.revokeObjectURL(nextPreviewUrl);
        setImageFile(null);
        setImagePreviewUrl(null);
        onToast(
          "WhatsApp images must be JPEG or PNG. This image could not be converted safely.",
          "error"
        );
        return;
      }
      if (isWhatsApp && optimizedFile.size > WHATSAPP_IMAGE_MAX_BYTES) {
        URL.revokeObjectURL(nextPreviewUrl);
        setImageFile(null);
        setImagePreviewUrl(null);
        onToast(
          "WhatsApp images must be 5MB or smaller. Please choose a smaller image.",
          "error"
        );
        return;
      }

      setImageFile(optimizedFile);
    } finally {
      if (
        mountedRef.current &&
        imagePreparationIdRef.current === preparationId
      ) {
        setImagePreparing(false);
      }
    }
  }

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    await selectImageFile(file);
  }

  async function handleComposerPaste(event) {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) =>
      String(item.type || "").startsWith("image/")
    );
    const pasted =
      imageItem?.getAsFile?.() ||
      Array.from(event.clipboardData?.files || []).find((file) =>
        String(file.type || "").startsWith("image/")
      );
    if (!pasted) return;
    event.preventDefault();
    const extension = pasted.type === "image/png" ? "png" : pasted.type === "image/webp" ? "webp" : "jpg";
    const namedFile = new File(
      [pasted],
      `pasted-image-${Date.now()}.${extension}`,
      { type: pasted.type || "image/jpeg", lastModified: Date.now() }
    );
    await selectImageFile(namedFile);
  }

  function clearImage() {
    imagePreparationIdRef.current += 1;
    setImagePreparing(false);
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
  }

  function cleanupRecordingHardware() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    if (mountedRef.current) setIsRecording(false);
  }

  function clearVoice() {
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    setVoiceBlob(null);
    setVoiceMimeType("");
    setVoiceDuration(0);
    setVoicePreviewUrl(null);
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording" || recorder?.state === "paused") recorder.stop();
  }

  function cancelRecording() {
    recordingRequestIdRef.current += 1;
    recordingStartingRef.current = false;
    if (mountedRef.current) setIsStartingRecording(false);
    discardRecordingRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording" || recorder?.state === "paused") recorder.stop();
    else cleanupRecordingHardware();
    recordingChunksRef.current = [];
    setRecordingSeconds(0);
  }

  async function startRecording() {
    if (sending || isRecording || recordingStartingRef.current) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }
    if (imageFile) {
      onToast("Remove the selected image before recording a voice message.", "warning");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onToast("Voice recording isn't supported in this browser.", "error");
      return;
    }

    recordingStartingRef.current = true;
    const requestId = recordingRequestIdRef.current + 1;
    recordingRequestIdRef.current = requestId;
    setIsStartingRecording(true);

    try {
      const recordingContactId = contact.contact_id;
      clearVoice();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      if (
        !mountedRef.current ||
        recordingRequestIdRef.current !== requestId ||
        activeContactIdRef.current !== recordingContactId
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recordingStreamRef.current = stream;

      const supportsMimeType = typeof MediaRecorder.isTypeSupported === "function";
      const selectedMimeType = supportsMimeType
        ? VOICE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
        : undefined;
      const options = selectedMimeType
        ? { mimeType: selectedMimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      discardRecordingRef.current = false;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size > 0) recordingChunksRef.current.push(event.data);
      });

      recorder.addEventListener("error", () => {
        discardRecordingRef.current = true;
        onToast("Recording failed. Please check your microphone and try again.", "error");
        cleanupRecordingHardware();
      });

      recorder.addEventListener("stop", () => {
        const shouldDiscard = discardRecordingRef.current;
        const duration = Math.max(1, Math.min(MAX_VOICE_SECONDS, Math.ceil((Date.now() - recordingStartedAtRef.current) / 1000)));
        const chunks = recordingChunksRef.current;
        const mimeType = recorder.mimeType || selectedMimeType || chunks[0]?.type || "audio/webm";

        cleanupRecordingHardware();
        recordingChunksRef.current = [];
        discardRecordingRef.current = false;
        setRecordingSeconds(0);

        if (shouldDiscard) return;

        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) {
          onToast("No audio was captured. Please check your microphone and try again.", "error");
          return;
        }
        if (blob.size > MAX_VOICE_BYTES) {
          onToast("That recording is larger than 16MB. Please record a shorter message.", "error");
          return;
        }

        setVoiceBlob(blob);
        setVoiceMimeType(mimeType);
        setVoiceDuration(duration);
        setVoicePreviewUrl(URL.createObjectURL(blob));
      });

      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      setIsRecording(true);
      recorder.start(1000);
      recordingTimerRef.current = setInterval(() => {
        const elapsed = Math.min(MAX_VOICE_SECONDS, Math.floor((Date.now() - recordingStartedAtRef.current) / 1000));
        setRecordingSeconds(elapsed);
        if (elapsed >= MAX_VOICE_SECONDS) stopRecording();
      }, 250);
    } catch (err) {
      if (recordingRequestIdRef.current !== requestId) return;
      cleanupRecordingHardware();
      if (!mountedRef.current) return;
      const message =
        err?.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow microphone access in your browser and try again."
          : err?.name === "NotFoundError"
          ? "No microphone was found on this device."
          : "Couldn't start recording. Please check your microphone and try again.";
      onToast(message, "error");
    } finally {
      if (recordingRequestIdRef.current === requestId) {
        recordingStartingRef.current = false;
        if (mountedRef.current) setIsStartingRecording(false);
      }
    }
  }

  async function sendRecordedVoice() {
    if (!voiceBlob || sending) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }
    setSending(true);
    try {
      await onSendVoice(voiceBlob, voiceMimeType, replyingTo?.id || null);
      if (mountedRef.current) {
        clearVoice();
        setReplyingTo(null);
      }
    } catch {
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  function handleReply(message) {
    if (!message || !canReplyToLeads || (contact?.channel || "whatsapp") !== "whatsapp") return;
    if (!message.whatsapp_message_id) {
      onToast("This message cannot be quoted on WhatsApp.", "warning");
      return;
    }
    draftEditVersionRef.current += 1;
    setReplyingTo(message);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function handleCopyMessage(message) {
    const text = String(message?.content || "").trim();
    if (!text) {
      onToast("This message has no text to copy.", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      onToast("Message copied.", "info");
    } catch {
      onToast("Couldn't copy the message in this browser.", "error");
    }
  }

  async function handleForwardConfirm(targetContactIds) {
    if (!forwardingMessage || !targetContactIds?.length) return;
    const messageId = forwardingMessage.id;

    // Match WhatsApp's feel: close the picker as soon as the action is accepted
    // locally instead of keeping a blocking sheet open for every provider send.
    setForwardingMessage(null);
    onToast(
      `Forwarding to ${targetContactIds.length} conversation${targetContactIds.length === 1 ? "" : "s"}…`,
      "info"
    );

    try {
      const result = await onForwardMessage(messageId, targetContactIds);
      const delivered = Number(result?.deliveredCount || 0);
      const requested = Number(result?.requestedCount || targetContactIds.length);
      const unknownCount = (result?.results || []).filter(
        (item) => item.deliveryUnknown === true
      ).length;
      if (delivered === requested) {
        onToast(`Forwarded to ${delivered} conversation${delivered === 1 ? "" : "s"}.`, "info");
      } else if (unknownCount > 0) {
        onToast(
          `${unknownCount} forward${unknownCount === 1 ? "" : "s"} could not be confirmed. Check the customer chat before retrying to avoid duplicates.`,
          "warning"
        );
      } else if (delivered > 0) {
        onToast(`Forwarded to ${delivered} of ${requested} conversations. Some sends were blocked or failed.`, "warning");
      } else {
        const firstError = result?.results?.find((item) => item.error)?.error;
        onToast(firstError || "The message could not be forwarded.", "warning");
      }
      return result;
    } catch (err) {
      onToast(err?.message || "The message could not be forwarded.", "error");
      throw err;
    }
  }

  function handleBackToConversations() {
    if (isStartingRecording || isRecording || voiceBlob) {
      onToast("Finish or cancel the voice message before returning to the Inbox.", "warning");
      return;
    }
    onBack();
  }

  if (!contact) {
    return (
      <div className="hidden flex-1 items-center justify-center bg-[var(--color-bg)] lg:flex">
        <div className="max-w-xs text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
            <ChatOutlineIcon className="h-6 w-6" />
          </div>
          <h2 className="mt-4 font-display text-base font-bold">Choose a conversation</h2>
          <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">
            Select a {customerSingular} to view messages and reply.
          </p>
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (sending || imagePreparing || isStartingRecording || isRecording || voiceBlob) return;
    if (!text && !imageFile) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }

    const selectedImage = imageFile;
    const selectedReply = replyingTo;
    const contactIdAtSend = contact?.contact_id;
    const draftEditVersionAtSend = draftEditVersionRef.current;
    const sendVersion = composerSendVersionRef.current + 1;
    composerSendVersionRef.current = sendVersion;
    setSending(true);

    try {
      // The parent handlers add an optimistic bubble synchronously and enqueue
      // the actual request in per-conversation order. Clear and unlock this
      // composer immediately so staff can keep chatting while the bubble shows
      // its own upload/send progress, just like a native messaging app.
      const sendPromise = selectedImage
        ? onSendImage(selectedImage, text, selectedReply?.id || null)
        : onSend(text, selectedReply?.id || null);

      if (mountedRef.current) {
        setDraft("");
        setReplyingTo(null);
        if (selectedImage) clearImage();
      }

      // Yield once so React paints the cleared composer/optimistic bubble before
      // re-enabling submit. Network completion remains serialized by the parent.
      await Promise.resolve();
      if (
        mountedRef.current &&
        composerSendVersionRef.current === sendVersion
      ) {
        setSending(false);
      }

      await sendPromise;
    } catch {
      // Restore the failed send only if no newer send or draft edit has happened.
      if (
        mountedRef.current &&
        activeContactIdRef.current === contactIdAtSend &&
        composerSendVersionRef.current === sendVersion
      ) {
        const draftUntouched =
          draftEditVersionRef.current === draftEditVersionAtSend;
        if (draftUntouched) {
          setDraft(text);
          setReplyingTo((current) => current || selectedReply);
          if (selectedImage) {
            setImageFile((current) => current || selectedImage);
            setImagePreviewUrl(
              (current) => current || URL.createObjectURL(selectedImage)
            );
          }
        }
      }
    } finally {
      if (
        mountedRef.current &&
        composerSendVersionRef.current === sendVersion
      ) {
        setSending(false);
      }
    }
  }

  return (
    <section className={`${mobileThreadOpen ? "flex" : "hidden lg:flex"} min-w-0 flex-1 flex-col h-full bg-[var(--color-bg)]`} aria-label={`Conversation with ${displayName(contact)}`}>
      <header className="relative z-10 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between gap-3 px-3 py-2 sm:px-5 sm:py-2.5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={handleBackToConversations}
              aria-label="Back to conversations"
              title={isStartingRecording || isRecording || voiceBlob ? "Finish or cancel the voice message first" : "Back to conversations"}
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] lg:hidden"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onOpenContactDetails}
              aria-label={`Open details for ${displayName(contact)}`}
              title="View contact details"
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full outline-none transition focus:ring-2 focus:ring-[var(--color-primary)]/40 focus:ring-offset-2"
            >
              <ContactAvatar src={contact.photo_url} channel={contact.channel} size={42} />
            </button>
            <div className="min-w-0">
              <h2 className="truncate font-display text-[15px] font-bold sm:text-base">{displayName(contact)}</h2>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-muted)] sm:flex-none sm:text-[11px]">
                  {contactMeta(contact)}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                    contact.mode === "human"
                      ? "bg-[var(--color-accent-light)] text-[var(--color-accent-text)]"
                      : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                  }`}
                  title={contact.mode === "human" ? "Handled by staff" : "Handled by AI"}
                >
                  {contact.mode === "human" ? "Staff" : "AI"}
                </span>
                {quietReplyAvailable && replyWindowCompactLabel && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[9px] font-medium text-[var(--color-text-muted)] sm:text-[10px]"
                    title={messagingPolicy.label || undefined}
                    aria-label={messagingPolicy.label || undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    <span>{replyWindowCompactLabel} left</span>
                  </span>
                )}
                <span className="hidden sm:inline-flex">
                  <LeadAssignmentBadge
                    ownerUsername={contact.lead_owner_username}
                    ownerDisplayName={contact.lead_owner_display_name}
                    currentUsername={currentUsername}
                    compact
                    showUnassigned={showUnassignedAssignment}
                  />
                </span>
              </div>
            </div>
          </div>
          <div ref={actionsMenuRef} className="relative flex shrink-0 items-center gap-1.5 sm:gap-2">
            {contact.mode === "human" ? (
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  onReturnToAi();
                }}
                disabled={actionPending || isStartingRecording || isRecording || !!voiceBlob}
                title={isStartingRecording || isRecording || voiceBlob ? "Finish or cancel the voice recording first" : "Return control to AI"}
                aria-label="Return control to AI"
                className="inline-flex h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-white px-2.5 text-xs font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:opacity-50 lg:h-auto lg:gap-2 lg:px-3 lg:py-2"
              >
                {actionPending ? <Spinner /> : <BotIcon className="h-4 w-4" />}
                <span className="hidden min-[430px]:inline">Return to AI</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  onTakeOver();
                }}
                disabled={actionPending}
                aria-label="Take over conversation"
                className="inline-flex h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-[var(--color-primary)] px-2.5 text-xs font-semibold text-white transition hover:bg-[var(--color-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:ring-offset-2 disabled:opacity-50 lg:h-auto lg:gap-2 lg:px-3 lg:py-2"
              >
                {actionPending ? <Spinner /> : <UserIcon className="h-4 w-4" />}
                <span className="hidden min-[430px]:inline">Take over</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setActionsOpen((current) => !current)}
              aria-label="Conversation actions"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              className={`flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border transition focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${
                actionsOpen
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
              }`}
            >
              <MoreIcon className="h-5 w-5" />
            </button>
            {actionsOpen && (
              <div role="menu" aria-label="Conversation actions" className="absolute right-0 top-full z-40 mt-2 w-52 overflow-hidden rounded-xl border border-[var(--color-border)] bg-white p-1.5 shadow-[0_16px_40px_rgba(24,39,33,0.16)]">
                <ConversationActionItem
                  icon={FlagIcon}
                  label={contact.needs_follow_up ? "Remove follow-up" : "Add follow-up"}
                  active={!!contact.needs_follow_up}
                  disabled={conversationStatePending}
                  onClick={() => {
                    setActionsOpen(false);
                    onToggleFollowUp();
                  }}
                />
                <ConversationActionItem
                  icon={MailIcon}
                  label={contact.is_unread ? "Mark as read" : "Mark as unread"}
                  active={!!contact.is_unread}
                  disabled={conversationStatePending}
                  onClick={() => {
                    setActionsOpen(false);
                    onToggleUnread();
                  }}
                />
                {contact.needs_attention && (
                  <ConversationActionItem
                    icon={AlertIcon}
                    label="Dismiss attention"
                    tone="danger"
                    onClick={() => {
                      setActionsOpen(false);
                      onDismissAttention();
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <AcquisitionContextBar
          context={acquisitionContext}
          loading={acquisitionLoading}
        />

        {contact.needs_attention && (
          <button
            type="button"
            onClick={() => setAttentionExpanded((current) => !current)}
            aria-expanded={attentionExpanded}
            className="flex w-full touch-manipulation items-start gap-2 border-t border-[var(--color-danger)]/15 bg-[var(--color-danger-light)] px-3 py-2 text-left text-[var(--color-danger)] transition hover:bg-[var(--color-danger-light)] sm:px-5"
            title={attentionExpanded ? "Collapse attention reason" : "Show full attention reason"}
          >
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="shrink-0 text-[11px] font-semibold">Needs attention</span>
            <span className={`min-w-0 flex-1 text-[11px] leading-4 opacity-80 ${attentionExpanded ? "whitespace-normal" : "truncate"}`}>
              {contact.attention_reason || "Flagged for staff review."}
            </span>
            <ChevronDownIcon
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${attentionExpanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
        {messagingPolicy.applies && !quietReplyAvailable && (
          <div className="border-t border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 sm:px-5">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-[11px] font-semibold">{messagingPolicy.label}</p>
                {messagingPolicy.explanation && (
                  <p className="mt-0.5 break-words text-[10px] leading-4 opacity-80">{messagingPolicy.explanation}</p>
                )}
                {messagingPolicy.optedOutAt && (
                  <p className="mt-1 text-[10px] font-medium leading-4">
                    Customer opted out of WhatsApp messages on {formatPolicyDate(messagingPolicy.optedOutAt)}.
                    {messagingPolicy.customerReinitiatedAfterOptOut
                      ? " Service replies are allowed for this new request, but automated follow-ups remain blocked."
                      : " Automated follow-ups remain blocked."}
                  </p>
                )}
                {whatsappTemplateNeedsOptIn && (
                  <p className="mt-1 text-[10px] font-medium leading-4">
                    {messagingPolicy.code === "opted_out"
                      ? "This customer opted out. Record a new explicit WhatsApp opt-in before sending any template."
                      : "WhatsApp opt-in is not recorded. Record confirmed consent in the template window before sending."}
                  </p>
                )}
                {whatsappTemplateAvailable && (
                  <button
                    type="button"
                    onClick={onOpenWhatsAppTemplates}
                    className="mt-2 inline-flex touch-manipulation items-center rounded-lg bg-amber-900 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-amber-950"
                  >
                    {whatsappTemplateNeedsOptIn
                      ? "Record opt-in & choose template"
                      : "Send WhatsApp template"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      <div ref={threadScrollRef} onScroll={handleThreadScroll} className="inbox-thread-bg min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5">
        <div className="mx-auto w-full max-w-4xl space-y-2.5">
          {hasMoreOlderMessages && (
            <div className="pb-1 text-center">
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={olderMessagesLoading}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] transition hover:text-[var(--color-text)] disabled:opacity-50"
              >
                {olderMessagesLoading && <Spinner className="text-[var(--color-primary)]" />}
                {olderMessagesLoading ? "Loading…" : "Load older messages"}
              </button>
            </div>
          )}

          {loading && <ThreadLoadingSkeleton />}

          {!loading && messages.length === 0 && (
            <div className="mx-auto my-6 max-w-md rounded-2xl border border-dashed border-[var(--color-border)] bg-white/70 px-5 py-8 text-center sm:my-10 sm:px-8 sm:py-10">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-[var(--color-primary)]">
                <ChatOutlineIcon className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-semibold">
                {messagingPolicy.applies ? "No customer messages yet" : "No messages yet"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-[var(--color-text-muted)]">
                {messagingPolicy.applies
                  ? `This ${messagingPolicy.channelLabel} contact must message the business before staff can send a normal reply.`
                  : "Start the conversation below."}
              </p>
            </div>
          )}

          {!loading && messages.map((message, index) => (
            <div key={message.id} className="space-y-2.5">
              {shouldShowDateSeparator(messages, index) && <DateSeparator value={message.created_at} />}
              <MessageBubble
                contactId={contact.contact_id}
                channel={contact.channel}
                message={message}
                onImageClick={setLightboxSrc}
                onRetry={onRetryMessage}
                onReply={handleReply}
                onForward={(selectedMessage) => setForwardingMessage(selectedMessage)}
                onCopy={handleCopyMessage}
                canReply={
                  canReplyToLeads &&
                  (contact.channel || "whatsapp") === "whatsapp" &&
                  !policyBlocksComposer
                }
                canForward={canReplyToLeads && !message._optimistic}
              />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 pt-2.5 sm:px-5"
        style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto w-full max-w-4xl">
          {replyingTo && (
            <div className="mb-2 flex min-h-12 items-stretch overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
              <span className="w-1 shrink-0 bg-[var(--color-primary)]" aria-hidden="true" />
              <div className="min-w-0 flex-1 px-3 py-2">
                <p className="text-[10px] font-semibold text-[var(--color-primary)]">
                  Replying to {replyingTo.role === "user" ? customerSingular : (replyingTo.sent_by_username || "AI")}
                </p>
                <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
                  {replyPreviewText(replyingTo)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  draftEditVersionRef.current += 1;
                  setReplyingTo(null);
                }}
                disabled={sending}
                className="flex h-12 w-12 shrink-0 touch-manipulation items-center justify-center text-xl text-[var(--color-text-muted)] active:bg-white hover:bg-white disabled:opacity-50"
                aria-label="Cancel reply"
                title="Cancel reply"
              >
                ×
              </button>
            </div>
          )}
          {isStartingRecording && (
            <div className="mb-2.5 flex items-center gap-3 rounded-xl bg-[var(--color-primary-light)] px-3 py-2.5">
              <Spinner className="text-[var(--color-primary)]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">Starting microphone…</p>
                <p className="text-[11px] text-[var(--color-text-muted)]">Allow microphone access if your browser asks.</p>
              </div>
              <button type="button" onClick={cancelRecording} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-white">Cancel</button>
            </div>
          )}
          {isRecording && (
            <div className="mb-2.5 flex items-center gap-3 rounded-xl bg-red-50 px-3 py-2.5">
              <span className="relative flex h-3 w-3 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-red-600">Recording voice message</p>
                <p className="text-[11px] text-[var(--color-text-muted)]">{formatDuration(recordingSeconds)} / {formatDuration(MAX_VOICE_SECONDS)}</p>
              </div>
              <button type="button" onClick={cancelRecording} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-white">Cancel</button>
              <button type="button" onClick={stopRecording} className="rounded-lg bg-red-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-600">Stop</button>
            </div>
          )}
          {voicePreviewUrl && !isRecording && (
            <div className="mb-2.5 flex flex-col gap-3 rounded-xl bg-[var(--color-bg)] px-3 py-2.5 sm:flex-row sm:items-center">
              <audio controls src={voicePreviewUrl} className="h-9 w-full min-w-0 sm:max-w-[260px]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">Voice message · {formatDuration(voiceDuration)}</p>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <button type="button" onClick={clearVoice} disabled={sending} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-white disabled:opacity-50">Remove</button>
                <button type="button" onClick={sendRecordedVoice} disabled={sending || policyBlocksComposer} className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                  {sending && <Spinner />}{sending ? "Sending…" : "Send voice"}
                </button>
              </div>
            </div>
          )}
          {imagePreviewUrl && (
            <div className="mb-2.5 flex items-center gap-3 rounded-xl bg-[var(--color-bg)] px-3 py-2.5">
              <img src={imagePreviewUrl} alt="Selected attachment" className="h-14 w-14 rounded-lg border border-[var(--color-border)] object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{imageFile.name}</p>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {imagePreparing ? "Preparing for faster upload…" : "Caption optional"}
                </p>
              </div>
              <button type="button" onClick={clearImage} disabled={sending} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white disabled:opacity-50">Remove</button>
            </div>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl border border-[var(--color-border)] bg-white p-1.5 transition focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)] sm:gap-2">
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFilePicked} className="hidden" />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending || imagePreparing || isStartingRecording || isRecording || !!voiceBlob || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : "Attach an image"} aria-label="Attach an image" className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-primary)] disabled:opacity-50"><ImageIcon className="h-[18px] w-[18px]" /></button>
            <button type="button" onClick={startRecording} disabled={sending || imagePreparing || isStartingRecording || isRecording || !!voiceBlob || !!imageFile || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : "Record a voice message"} aria-label="Record a voice message" className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-primary)] disabled:opacity-50"><MicrophoneIcon className="h-[18px] w-[18px]" /></button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={handleDraftChange}
              onPaste={handleComposerPaste}
              disabled={isStartingRecording || isRecording || !!voiceBlob}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={composerPlaceholder}
              aria-label={composerLabel}
              rows={1}
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1.5 py-2.5 text-sm leading-relaxed outline-none disabled:opacity-50 sm:px-2.5"
            />
            <button type="submit" disabled={(!draft.trim() && !imageFile) || sending || imagePreparing || isStartingRecording || isRecording || !!voiceBlob || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : imagePreparing ? "Preparing image" : "Send message"} aria-label="Send message" className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-0 text-xs font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:px-4 sm:text-sm">
              {sending || imagePreparing ? <Spinner /> : <SendIcon className="h-4 w-4" />}
              <span className="hidden sm:inline">{imagePreparing ? "Preparing…" : sending ? (imageFile ? "Uploading…" : "Sending…") : "Send"}</span>
            </button>
          </div>
        </div>
      </form>

      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      <ForwardMessageModal
        message={forwardingMessage}
        conversations={conversations}
        currentContactId={contact.contact_id}
        onClose={() => setForwardingMessage(null)}
        onConfirm={handleForwardConfirm}
      />
    </section>
  );
}

function ForwardMessageModal({ message, conversations, currentContactId, onClose, onConfirm }) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setQuery("");
    setSelectedIds([]);
    setSending(false);
    setError("");
  }, [message?.id]);

  useEffect(() => {
    if (!message) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event) {
      if (event.key === "Escape" && !sending) onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [message, onClose, sending]);

  if (!message) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const choices = (conversations || []).filter((item) => {
    if (!normalizedQuery) return true;
    return [
      displayName(item),
      item.whatsapp_number,
      item.last_message,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  function toggleContact(contactId) {
    setError("");
    setSelectedIds((current) => {
      if (current.includes(contactId)) return current.filter((id) => id !== contactId);
      if (current.length >= 10) {
        setError("You can forward to up to 10 conversations at a time.");
        return current;
      }
      return [...current, contactId];
    });
  }

  async function submitForward() {
    if (!selectedIds.length || sending) return;
    setSending(true);
    setError("");
    try {
      await onConfirm(selectedIds);
    } catch (err) {
      setError(err?.message || "Couldn't forward this message. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Forward message"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) onClose();
      }}
    >
      <div className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[24px] bg-white shadow-2xl sm:max-h-[82vh] sm:max-w-md sm:rounded-2xl">
        <div className="flex h-5 shrink-0 items-center justify-center sm:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-slate-300" />
        </div>
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 pb-3 pt-1 sm:py-3.5">
          <div className="min-w-0 pr-3">
            <h3 className="text-base font-bold sm:text-sm">Forward message</h3>
            <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)] sm:text-[11px]">{replyPreviewText(message)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-2xl text-[var(--color-text-muted)] active:bg-[var(--color-bg)] hover:bg-[var(--color-bg)] disabled:opacity-50"
            aria-label="Close forward message"
          >
            ×
          </button>
        </div>
        <div className="shrink-0 px-4 pt-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations to forward"
            className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)] sm:text-sm"
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
            <span>Select up to 10 conversations</span>
            <span className="font-semibold text-[var(--color-primary)]">{selectedIds.length} selected</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-2 py-2">
          {choices.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]">No conversations found.</p>
          ) : choices.map((item) => {
            const id = Number(item.contact_id);
            const selected = selectedIds.includes(id);
            return (
              <button
                key={item.contact_id}
                type="button"
                onClick={() => toggleContact(id)}
                aria-pressed={selected}
                className={`flex min-h-14 w-full touch-manipulation items-center gap-3 rounded-xl px-3 py-2.5 text-left transition active:bg-[var(--color-bg)] ${selected ? "bg-[var(--color-primary-light)]" : "hover:bg-[var(--color-bg)]"}`}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${selected ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-border)] bg-white text-transparent"}`}>✓</span>
                <ContactAvatar src={item.photo_url} channel={item.channel} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {displayName(item)}{Number(item.contact_id) === Number(currentContactId) ? " (current)" : ""}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">{contactMeta(item)}</span>
                </span>
              </button>
            );
          })}
        </div>
        {error && <p className="mx-4 mb-2 shrink-0 rounded-lg bg-[var(--color-danger-light)] px-3 py-2.5 text-xs text-[var(--color-danger)]">{error}</p>}
        <div
          className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] bg-white px-4 pt-3 sm:justify-end sm:pb-3"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="h-11 flex-1 touch-manipulation rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold active:bg-[var(--color-bg)] hover:bg-[var(--color-bg)] disabled:opacity-50 sm:flex-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitForward}
            disabled={!selectedIds.length || sending}
            className="inline-flex h-11 flex-[1.35] touch-manipulation items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white active:bg-[var(--color-primary-hover)] hover:bg-[var(--color-primary-hover)] disabled:opacity-40 sm:flex-none sm:min-w-28"
          >
            {sending && <Spinner />}{sending ? "Forwarding…" : selectedIds.length ? `Forward (${selectedIds.length})` : "Forward"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConversationActionItem({ icon: Icon, label, active, disabled, tone = "default", onClick }) {
  const danger = tone === "danger";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]"
          : active
          ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
          : "text-[var(--color-text)] hover:bg-[var(--color-bg)]"
      }`}
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
        danger
          ? "bg-[var(--color-danger-light)]"
          : active
          ? "bg-white/70"
          : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
      }`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="truncate text-xs font-semibold">{label}</span>
    </button>
  );
}

function ControlIndicator({ mode }) {
  if (mode !== "human") return null;
  return (
    <span
      title="Handled by staff"
      className="inline-flex shrink-0 items-center gap-1 px-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
      Staff
    </span>
  );
}

function Spinner({ className = "" }) {
  return (
    <svg className={`animate-spin h-3.5 w-3.5 ${className}`} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function MessageBubble({
  contactId,
  channel,
  message,
  onImageClick,
  onRetry,
  onReply,
  onForward,
  onCopy,
  canReply,
  canForward,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const swipeStartRef = useRef(null);
  const swipeOffsetRef = useRef(0);
  const suppressClickRef = useRef(false);
  const isPatient = message.role === "user";
  const sentByStaff = !isPatient && !!message.sent_by_username;
  const isWhatsAppTemplate = !!message.whatsapp_template;
  const senderLabel = message.is_automated_follow_up
    ? "Automated follow-up"
    : sentByStaff
    ? message.sent_by_username
    : "AI";
  const isAudio = message.media_mime_type?.startsWith("audio/");
  const isSticker =
    String(message.media_mime_type || "").toLowerCase() === "image/webp" &&
    /(?:sent a sticker|forwarded sticker|sticker sent from)/i.test(
      String(message.content || "")
    );
  const deliveryFailed = !isPatient && message.delivery_status === "failed";
  const deliveryUnconfirmed = !isPatient && message.delivery_status === "unknown";
  const deliveryNeedsAction = deliveryFailed || deliveryUnconfirmed;
  const policyFailureExplanationText = policyFailureExplanation(message, channel);
  const storedMediaSrc = message.media_base64
    ? `data:${message.media_mime_type || "application/octet-stream"};base64,${message.media_base64}`
    : message.has_media_attachment
    ? api.messageMediaUrl(contactId, message.id)
    : null;
  const imageSrc = message.previewUrl || message.media_url || (!isAudio ? storedMediaSrc : null);
  const hasImage = !!imageSrc;
  const reactionEmojis = Array.isArray(message.reactions)
    ? message.reactions
        .map((reaction) => reaction?.emoji)
        .filter((emoji) => typeof emoji === "string" && emoji.length > 0)
    : [];
  const quoteDeliveryConfirmed =
    isPatient ||
    !["failed", "unknown"].includes(
      String(message.delivery_status || "").toLowerCase()
    );
  const canQuote = Boolean(
    canReply &&
    message.whatsapp_message_id &&
    !message._optimistic &&
    quoteDeliveryConfirmed
  );
  const canCopy = Boolean(String(message.content || "").trim());
  const showActions = canQuote || canForward || canCopy;
  const replyPreview = message.reply_preview || null;

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);

    const isMobile = window.matchMedia("(max-width: 639px)").matches;
    const previousOverflow = document.body.style.overflow;
    if (isMobile) document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (isMobile) document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  function closeAndReply() {
    setMenuOpen(false);
    onReply?.(message);
  }

  function closeAndForward() {
    setMenuOpen(false);
    onForward?.(message);
  }

  function closeAndCopy() {
    setMenuOpen(false);
    onCopy?.(message);
  }

  function handleSwipeStart(event) {
    if (!canQuote || event.touches?.length !== 1) return;
    if (event.target?.closest?.("button, audio, video, input, textarea, a")) return;
    const touch = event.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
    swipeOffsetRef.current = 0;
    setIsSwiping(true);
  }

  function handleSwipeMove(event) {
    const start = swipeStartRef.current;
    const touch = event.touches?.[0];
    if (!start || !touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) * 1.15) {
      if (swipeOffsetRef.current !== 0) {
        swipeOffsetRef.current = 0;
        setSwipeOffset(0);
      }
      return;
    }

    const nextOffset = Math.min(64, Math.max(0, dx * 0.72));
    swipeOffsetRef.current = nextOffset;
    setSwipeOffset(nextOffset);
  }

  function resetSwipe() {
    swipeStartRef.current = null;
    swipeOffsetRef.current = 0;
    setSwipeOffset(0);
    setIsSwiping(false);
  }

  function finishSwipe() {
    if (!swipeStartRef.current) return;
    const shouldReply = swipeOffsetRef.current >= 44;
    resetSwipe();
    if (shouldReply) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 500);
      onReply?.(message);
    }
  }

  function cancelSwipe() {
    resetSwipe();
  }

  function handleClickCapture(event) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className={`relative flex ${isPatient ? "justify-start" : "justify-end"} ${reactionEmojis.length ? "mb-2" : ""}`}>
      {canQuote && (
        <div
          className={`pointer-events-none absolute left-1 top-1/2 z-0 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-lg font-bold text-[var(--color-primary)] transition-opacity sm:hidden ${swipeOffset > 12 ? "opacity-100" : "opacity-0"}`}
          style={{ transform: `translateY(-50%) scale(${Math.min(1, 0.75 + swipeOffset / 160)})` }}
          aria-hidden="true"
        >
          ↩
        </div>
      )}

      <div
        className={`group relative z-10 max-w-[88%] touch-pan-y rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm transition-transform ${isSwiping ? "duration-0" : "duration-150"} sm:max-w-[78%] sm:px-4 xl:max-w-[68%] ${isPatient ? "bubble-in rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]" : "bubble-out rounded-br-md bg-[var(--color-primary)] text-white shadow-[0_2px_8px_rgba(47,111,98,0.14)]"} ${message._optimistic ? "opacity-70" : ""} ${deliveryNeedsAction ? "ring-2 ring-[var(--color-danger)]/80 ring-offset-2" : ""}`}
        style={{ transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined }}
        onTouchStart={handleSwipeStart}
        onTouchMove={handleSwipeMove}
        onTouchEnd={finishSwipe}
        onTouchCancel={cancelSwipe}
        onClickCapture={handleClickCapture}
      >
        {showActions && (
          <div className="absolute -right-1 -top-1 z-20 sm:right-1.5 sm:top-1.5">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className={`flex h-11 w-11 touch-manipulation items-center justify-center rounded-full text-xl leading-none transition sm:h-7 sm:w-7 sm:text-lg ${isPatient ? "text-[var(--color-text-muted)] active:bg-[var(--color-bg)] hover:bg-[var(--color-bg)]" : "text-white/80 active:bg-white/15 hover:bg-white/15"} ${menuOpen ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
              aria-label="Message actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              title="Message actions"
            >
              ⋮
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-30 hidden min-w-36 rounded-xl border border-[var(--color-border)] bg-white p-1.5 text-[var(--color-text)] shadow-lg sm:block" role="menu">
                {canQuote && <button type="button" role="menuitem" onClick={closeAndReply} className="block min-h-10 w-full rounded-lg px-3 py-2 text-left text-xs font-medium hover:bg-[var(--color-bg)]">↩&nbsp;&nbsp;Reply</button>}
                {canForward && <button type="button" role="menuitem" onClick={closeAndForward} className="block min-h-10 w-full rounded-lg px-3 py-2 text-left text-xs font-medium hover:bg-[var(--color-bg)]">↪&nbsp;&nbsp;Forward</button>}
                {canCopy && <button type="button" role="menuitem" onClick={closeAndCopy} className="block min-h-10 w-full rounded-lg px-3 py-2 text-left text-xs font-medium hover:bg-[var(--color-bg)]">⧉&nbsp;&nbsp;Copy</button>}
              </div>
            )}
          </div>
        )}

        {!isPatient && <p className="mb-1 pr-9 text-[10px] font-semibold text-white/65 sm:pr-7">{senderLabel}</p>}
        {isPatient && showActions && <div className="h-5 sm:h-3" aria-hidden="true" />}
        {message.is_forwarded && (
          <p className={`mb-1 text-[10px] italic ${isPatient ? "text-[var(--color-text-muted)]" : "text-white/65"}`}>↪ Forwarded</p>
        )}
        {isWhatsAppTemplate && (
          <p className="mb-1.5 inline-flex rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-semibold text-white/80">
            Template · {message.whatsapp_template.name}
          </p>
        )}
        {message.reply_to_provider_message_id && (
          <div className={`mb-2 overflow-hidden rounded-lg border-l-[3px] px-2.5 py-2 ${isPatient ? "border-[var(--color-primary)] bg-[var(--color-bg)]" : "border-white/70 bg-white/12"}`}>
            <p className={`text-[10px] font-semibold ${isPatient ? "text-[var(--color-primary)]" : "text-white/80"}`}>
              {replyPreview?.role === "user" ? "Customer" : (replyPreview?.sent_by_username || (replyPreview ? "AI" : "Original message"))}
            </p>
            <p className={`mt-0.5 truncate text-[11px] ${isPatient ? "text-[var(--color-text-muted)]" : "text-white/75"}`}>
              {replyPreviewText(replyPreview)}
            </p>
          </div>
        )}
        {isAudio && storedMediaSrc ? (
          <audio controls preload="none" src={storedMediaSrc} className="mb-1.5 max-w-full" style={{ height: "36px" }} />
        ) : (
          hasImage && (
            <div className="relative mb-1.5">
              <img
                src={imageSrc}
                alt={isSticker ? "Customer sticker" : (message.content || "Sent image")}
                onClick={() => !message._uploading && onImageClick?.(imageSrc)}
                className={`${isSticker ? "max-h-36 max-w-[9rem] object-contain" : "max-h-64 max-w-full rounded-lg object-cover"} ${message._uploading ? "" : "cursor-zoom-in"}`}
              />
              {message._uploading && <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30"><Spinner className="h-6 w-6 text-white" /></div>}
            </div>
          )
        )}
        {message.content && (!isSticker || !hasImage) && (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
        <div className={`mt-1.5 flex items-center gap-1.5 text-[10px] ${isPatient ? "text-[var(--color-text-muted)]" : "justify-end text-white/70"}`}>
          {message._optimistic && <Spinner className="h-2.5 w-2.5" />}
          <span>{formatMessageTime(message.created_at)}</span>
          {!isPatient && !message._optimistic && !deliveryNeedsAction && (
            <DeliveryIndicator status={message.delivery_status} />
          )}
        </div>
        {reactionEmojis.length > 0 && (
          <div
            className={`absolute -bottom-3 ${isPatient ? "left-3" : "right-3"} inline-flex min-h-6 items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-white px-1.5 py-0.5 text-sm leading-none shadow-sm`}
            title="Customer reaction"
            aria-label={`Customer reacted ${reactionEmojis.join(" ")}`}
          >
            {reactionEmojis.map((emoji, index) => (
              <span key={`${emoji}-${index}`} aria-hidden="true">{emoji}</span>
            ))}
          </div>
        )}
        {deliveryNeedsAction && (
          <div className="mt-2 rounded-lg bg-white px-2.5 py-2 text-[var(--color-danger)]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold">
                {deliveryUnconfirmed ? "Delivery unconfirmed" : "Not delivered"}
              </span>
              {!policyFailureExplanationText && (
                <button
                  type="button"
                  onClick={() => onRetry?.(message.id)}
                  disabled={message._retrying}
                  className="inline-flex min-h-10 touch-manipulation items-center gap-1 rounded-md border border-[var(--color-danger)]/30 px-3 py-1 text-[10px] font-semibold transition-colors active:bg-[var(--color-danger-light)] hover:bg-[var(--color-danger-light)] disabled:opacity-60"
                >
                  {message._retrying && <Spinner className="h-2.5 w-2.5" />}
                  {message._retrying ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
            {message.delivery_error && (
              <p
                className="mt-1 text-[10px] leading-snug opacity-80"
                title={displayDeliveryError(message.delivery_error)}
              >
                {displayDeliveryError(message.delivery_error)}
              </p>
            )}
            {policyFailureExplanationText && (
              <p className="mt-1 text-[10px] font-medium leading-snug">
                Cannot retry: {policyFailureExplanationText}
              </p>
            )}
          </div>
        )}
      </div>

      {menuOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[80] bg-black/40 sm:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Close message actions"
          />
          <div
            className="fixed inset-x-0 bottom-0 z-[81] overflow-hidden rounded-t-[24px] bg-white text-[var(--color-text)] shadow-2xl sm:hidden"
            role="menu"
            aria-label="Message options"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <div className="flex h-5 items-center justify-center" aria-hidden="true">
              <span className="h-1 w-10 rounded-full bg-slate-300" />
            </div>
            <div className="border-b border-[var(--color-border)] px-4 pb-3 pt-1">
              <p className="text-sm font-bold">Message actions</p>
              <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{replyPreviewText(message)}</p>
            </div>
            <div className="p-2">
              {canQuote && <button type="button" role="menuitem" onClick={closeAndReply} className="flex min-h-12 w-full touch-manipulation items-center gap-3 rounded-xl px-4 text-left text-sm font-semibold active:bg-[var(--color-bg)]"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-lg text-[var(--color-primary)]">↩</span>Reply</button>}
              {canForward && <button type="button" role="menuitem" onClick={closeAndForward} className="flex min-h-12 w-full touch-manipulation items-center gap-3 rounded-xl px-4 text-left text-sm font-semibold active:bg-[var(--color-bg)]"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-bg)] text-lg text-[var(--color-text-muted)]">↪</span>Forward</button>}
              {canCopy && <button type="button" role="menuitem" onClick={closeAndCopy} className="flex min-h-12 w-full touch-manipulation items-center gap-3 rounded-xl px-4 text-left text-sm font-semibold active:bg-[var(--color-bg)]"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-bg)] text-base text-[var(--color-text-muted)]">⧉</span>Copy</button>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DeliveryStatusGlyph({ status }) {
  if (status === "pending") {
    return (
      <svg
        viewBox="0 0 12 12"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="4.6" />
        <path d="M6 3.4V6l1.8 1.2" />
      </svg>
    );
  }

  if (status === "sent") {
    return (
      <svg
        viewBox="0 0 11 10"
        className="h-[11px] w-[12px] shrink-0 overflow-visible"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M1 5.2 3.5 7.6 9.5 1.7" />
      </svg>
    );
  }

  if (status === "delivered" || status === "read") {
    return (
      <svg
        viewBox="0 0 14 10"
        className="h-[11px] w-[15px] shrink-0 overflow-visible"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M1 5.2 3.4 7.6 8.8 2" />
        <path d="M5 5.2 7.4 7.6 12.8 2" />
      </svg>
    );
  }

  return null;
}

function DeliveryIndicator({ status }) {
  const indicators = {
    pending: { label: "Queued", className: "text-white/70" },
    sent: { label: "Sent", className: "text-white/70" },
    delivered: { label: "Delivered", className: "text-white/80" },
    read: { label: "Read", className: "text-sky-300" },
  };
  const indicator = indicators[status];
  if (!indicator) return null;

  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center ${indicator.className}`}
      title={indicator.label}
      aria-label={indicator.label}
      data-delivery-status={status}
    >
      <DeliveryStatusGlyph status={status} />
    </span>
  );
}

function formatPhone(number) {
  if (!number) return "";
  const value = String(number);
  return value.startsWith("+") ? value : `+${value}`;
}

function contactMeta(contact) {
  const channel = contact?.channel || "whatsapp";
  if (channel === "whatsapp") return formatPhone(contact?.whatsapp_number);
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return channel;
}

function displayName(contact) {
  return contact.name || contact.whatsapp_profile_name || formatPhone(contact.whatsapp_number);
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    console.warn("Invalid date received:", value);
    return "";
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatMessageTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    console.warn("Invalid date received:", value);
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
