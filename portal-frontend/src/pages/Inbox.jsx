import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Lightbox from "../components/Lightbox";
import ContactAvatar from "../components/ContactAvatar";
import ContactDetailsDrawer from "../components/ContactDetailsDrawer";
import LeadAssignmentBadge, {
  buildLeadAssignmentFilterOptions,
  matchesLeadAssignment,
} from "../components/LeadAssignmentBadge";
import {
  policyFailureExplanation,
  whatsappPolicyStatus,
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
const MAX_VOICE_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_SECONDS = 120;
const VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "unreplied", label: "Unreplied" },
  { key: "follow-up", label: "Follow-up" },
  { key: "unread", label: "Unread" },
  { key: "attention", label: "Needs attention" },
];

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
  const { username, permissions } = useAuth();
  const canViewAllLeads = permissions.view_all_leads === true;
  const { toasts, showToast, dismissToast } = useToasts();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedContactId = /^\d+$/.test(searchParams.get("contact") || "")
    ? Number(searchParams.get("contact"))
    : null;

  const [conversations, setConversations] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [conversationStatePending, setConversationStatePending] = useState(false);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [contactDetailsOpen, setContactDetailsOpen] = useState(false);
  const selectedIdRef = useRef(selectedId);
  const messagesRef = useRef(messages);
  const latestMessageIdRef = useRef(null);
  const threadRequestVersionRef = useRef(0);

  selectedIdRef.current = selectedId;
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
    if (conversations?.length && selectedId == null) {
      const requestedConversation = requestedContactId
        ? conversations.find(
            (conversation) => Number(conversation.contact_id) === requestedContactId
          )
        : null;
      const firstConversation = requestedConversation || conversations[0];
      setSelectedId(firstConversation.contact_id);
      if (requestedConversation) setMobileThreadOpen(true);

      const threadIsVisible = window.matchMedia("(min-width: 768px)").matches;
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
    }
  }, [conversations, requestedContactId, selectedId, showToast]);

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
    setMobileThreadOpen(false);
    if (nextConversation) {
      setSearchParams({ contact: String(nextConversation.contact_id) }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
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
        scheduleRefresh(payload.contactId ?? null);
      } catch (err) {
        console.error("Failed to parse realtime Inbox event:", err);
        scheduleRefresh();
      }
    }

    source.addEventListener("conversation_changed", handleConversationChanged);
    source.onopen = () => {
      scheduleRefresh();
    };
    source.onerror = () => {};

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      source.removeEventListener("conversation_changed", handleConversationChanged);
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

  async function handleSend(text) {
    if (selectedId == null || !text.trim()) return;
    const contactId = selectedId;
    setActionPending(true);

    const optimisticId = makeOptimisticId();
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
        _optimistic: true,
      },
    ]);

    try {
      const result = await api.sendMessage(contactId, text.trim());
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev.filter((m) => m.id !== optimisticId), [result]));
      }
      await refreshConversations();
      if (result?.delivered === false) {
        showToast("Message saved but WhatsApp delivery failed — the patient may not have received it. Please try resending.", "warning");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      }
      showToast(err.message || "Couldn't send that message — please try again.", "error");
      throw err;
    } finally {
      if (selectedIdRef.current === contactId) setActionPending(false);
    }
  }

  async function handleSendImage(file, caption) {
    if (selectedId == null || !file) return;
    const contactId = selectedId;
    setActionPending(true);

    const optimisticId = makeOptimisticId();
    const previewUrl = URL.createObjectURL(file);
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
        _optimistic: true,
        _uploading: true,
      },
    ]);

    try {
      const result = await api.sendImage(contactId, file, caption);
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev.filter((m) => m.id !== optimisticId), [result]));
      }
      await refreshConversations();
      if (result?.delivered === false) {
        showToast("Image saved but WhatsApp delivery failed — the patient may not have received it. Please try resending.", "warning");
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
      if (selectedIdRef.current === contactId) setActionPending(false);
    }
  }

  async function handleSendVoice(recording, mimeType) {
    if (selectedId == null || !recording) return;
    const contactId = selectedId;
    setActionPending(true);

    try {
      const result = await api.sendVoice(contactId, recording, mimeType);
      if (selectedIdRef.current === contactId) {
        setMessages((prev) => mergeMessages(prev, [{ ...result, has_media_attachment: true }]));
      }
      await refreshConversations();
      if (result?.delivered === false) {
        showToast("Voice message saved but WhatsApp delivery failed — the patient may not have received it. Please try recording again.", "warning");
      } else if (result?.transcribed === false) {
        showToast("Voice message sent. Its transcript couldn't be generated, but the recording was saved.", "info");
      }
    } catch (err) {
      console.error("Failed to send voice message:", err);
      showToast(err.message || "Couldn't send that voice message — please try again.", "error");
      throw err;
    } finally {
      if (selectedIdRef.current === contactId) setActionPending(false);
    }
  }

  const selectedContact = conversations?.find((c) => c.contact_id === selectedId);

  return (
    <div className="flex h-full bg-[var(--color-bg)]">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={handleSelectConversation}
        mobileThreadOpen={mobileThreadOpen}
        currentUsername={username}
        canViewAllLeads={canViewAllLeads}
      />
      <ThreadView
        key={selectedId ?? "no-conversation"}
        contact={selectedContact}
        currentUsername={username}
        messages={messages}
        loading={messagesLoading}
        olderMessagesLoading={olderMessagesLoading}
        hasMoreOlderMessages={hasMoreOlderMessages}
        actionPending={actionPending}
        conversationStatePending={conversationStatePending}
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
        onOpenContactDetails={() => setContactDetailsOpen(true)}
        onToast={showToast}
        mobileThreadOpen={mobileThreadOpen}
        onBack={() => setMobileThreadOpen(false)}
      />
      <ContactDetailsDrawer
        open={contactDetailsOpen}
        contact={selectedContact}
        onClose={() => setContactDetailsOpen(false)}
      />
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
    () => buildLeadAssignmentFilterOptions(conversationList, currentUsername),
    [conversationList, currentUsername]
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
    if (!canViewAllLeads && filters.assignment !== "all") {
      setFilters((current) => ({ ...current, assignment: "all" }));
    }
  }, [canViewAllLeads, filters.assignment]);

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
      className={`${mobileThreadOpen ? "hidden md:flex" : "flex"} h-full w-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:w-[21.5rem] lg:w-[23rem] xl:w-[24.5rem]`}
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
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[9px] font-bold leading-none text-white">
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
                  <span className="block text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
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
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-primary-light)] px-2 py-1 text-[9px] font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary)] hover:text-white"
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
                ? "New patient messages will appear here automatically."
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
                      {formatTime(conversation.last_message_at)}
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
                    />
                    <ControlIndicator mode={conversation.mode} />
                    {conversation.needs_follow_up && <StatusBadge tone="accent">Follow-up</StatusBadge>}
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
      <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
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
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${styles[tone]}`}>
      {children}
    </span>
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
  currentUsername,
  messages,
  loading,
  olderMessagesLoading,
  hasMoreOlderMessages,
  actionPending,
  conversationStatePending,
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
  onOpenContactDetails,
  onToast,
  mobileThreadOpen,
  onBack,
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
  const actionsMenuRef = useRef(null);
  const mountedRef = useRef(true);
  const activeContactIdRef = useRef(contact?.contact_id);
  const activeContactModeRef = useRef(contact?.mode);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceBlob, setVoiceBlob] = useState(null);
  const [voiceMimeType, setVoiceMimeType] = useState("");
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [policyNow, setPolicyNow] = useState(Date.now());

  activeContactIdRef.current = contact?.contact_id;
  activeContactModeRef.current = contact?.mode;
  const messagingPolicy = whatsappPolicyStatus(contact, policyNow);
  const policyBlocksComposer = messagingPolicy.applies && !messagingPolicy.freeformAllowed;

  useEffect(() => {
    setPolicyNow(Date.now());
    const timer = setInterval(() => setPolicyNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, [contact?.contact_id]);

  useEffect(() => {
    if (!loading && messages.length > 0 && shouldStickToBottomRef.current) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    }
  }, [messages, loading]);

  useEffect(() => {
    if (contact && contact.mode !== "human") {
      cancelRecording();
      clearVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.mode]);

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
  }, [draft]);

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

  function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }
    if (!file.type.startsWith("image/")) {
      onToast("Please choose an image file.", "error");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      onToast("That image is larger than 16MB — please choose a smaller file.", "error");
      return;
    }
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
  }

  function clearImage() {
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
    if (contact.mode !== "human") {
      onToast("Take over this conversation before recording a voice message.", "warning");
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
        activeContactIdRef.current !== recordingContactId ||
        activeContactModeRef.current !== "human"
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
      await onSendVoice(voiceBlob, voiceMimeType);
      if (mountedRef.current) clearVoice();
    } catch {
    } finally {
      if (mountedRef.current) setSending(false);
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
      <div className="hidden flex-1 items-center justify-center bg-[var(--color-bg)] md:flex">
        <div className="max-w-xs text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
            <ChatOutlineIcon className="h-6 w-6" />
          </div>
          <h2 className="mt-4 font-display text-base font-bold">Choose a conversation</h2>
          <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">
            Select a patient to view messages and reply.
          </p>
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (sending || isStartingRecording || isRecording || voiceBlob) return;
    if (!text && !imageFile) return;
    if (policyBlocksComposer) {
      onToast(messagingPolicy.explanation, "warning");
      return;
    }
    setSending(true);
    try {
      if (imageFile) {
        await onSendImage(imageFile, text);
        if (mountedRef.current) clearImage();
      } else {
        await onSend(text);
      }
      if (mountedRef.current) setDraft("");
    } catch {
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  return (
    <section className={`${mobileThreadOpen ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col h-full bg-[var(--color-bg)]`} aria-label={`Conversation with ${displayName(contact)}`}>
      <header className="relative z-10 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={handleBackToConversations}
              aria-label="Back to conversations"
              title={isStartingRecording || isRecording || voiceBlob ? "Finish or cancel the voice message first" : "Back to conversations"}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] md:hidden"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onOpenContactDetails}
              aria-label={`Open details for ${displayName(contact)}`}
              title="View contact details"
              className="shrink-0 rounded-full outline-none transition focus:ring-2 focus:ring-[var(--color-primary)]/40 focus:ring-offset-2"
            >
              <ContactAvatar src={contact.photo_url} channel={contact.channel} size={42} />
            </button>
            <div className="min-w-0">
              <h2 className="truncate font-display text-[15px] font-bold sm:text-base">{displayName(contact)}</h2>
              <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden">
                <span className="truncate text-[10px] text-[var(--color-text-muted)] sm:text-[11px]">
                  {contactMeta(contact)}
                </span>
                <LeadAssignmentBadge
                  ownerUsername={contact.lead_owner_username}
                  ownerDisplayName={contact.lead_owner_display_name}
                  currentUsername={currentUsername}
                  compact
                />
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
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-white px-2.5 text-xs font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:opacity-50 sm:h-auto sm:gap-2 sm:px-3 sm:py-2"
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
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--color-primary)] px-2.5 text-xs font-semibold text-white transition hover:bg-[var(--color-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:ring-offset-2 disabled:opacity-50 sm:h-auto sm:gap-2 sm:px-3 sm:py-2"
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
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${
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

        {contact.needs_attention && (
          <div className="flex items-center gap-2 border-t border-[var(--color-danger)]/15 bg-[var(--color-danger-light)] px-4 py-2 text-[var(--color-danger)] sm:px-5">
            <AlertIcon className="h-4 w-4 shrink-0" />
            <span className="shrink-0 text-[11px] font-semibold">Needs attention</span>
            <span className="truncate text-[11px] opacity-80">
              {contact.attention_reason || "Flagged for staff review."}
            </span>
          </div>
        )}
        {messagingPolicy.applies && (
          <div className={`border-t px-3 py-2.5 sm:px-5 ${messagingPolicy.freeformAllowed ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
            <div className="flex items-start gap-2">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${messagingPolicy.freeformAllowed ? "bg-emerald-500" : "bg-amber-500"}`} />
              <div className="min-w-0">
                <p className="break-words text-[11px] font-semibold">{messagingPolicy.label}</p>
                <p className="mt-0.5 break-words text-[10px] leading-4 opacity-80">{messagingPolicy.explanation}</p>
                {messagingPolicy.optedOutAt && (
                  <p className="mt-1 text-[10px] font-medium leading-4">
                    Customer opted out of WhatsApp messages on {formatPolicyDate(messagingPolicy.optedOutAt)}.
                    {messagingPolicy.customerReinitiatedAfterOptOut
                      ? " Service replies are allowed for this new request, but automated follow-ups remain blocked."
                      : " Automated follow-ups remain blocked."}
                  </p>
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
                  ? "This WhatsApp contact must message the business before staff can send a normal reply."
                  : "Start the conversation below."}
              </p>
            </div>
          )}

          {!loading && messages.map((message, index) => (
            <div key={message.id} className="space-y-2.5">
              {shouldShowDateSeparator(messages, index) && <DateSeparator value={message.created_at} />}
              <MessageBubble
                contactId={contact.contact_id}
                message={message}
                onImageClick={setLightboxSrc}
                onRetry={onRetryMessage}
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
          {policyBlocksComposer && (
            <div aria-live="polite" className="mb-2.5 break-words rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-900 sm:px-3">
              <span className="font-semibold">Sending unavailable.</span> {messagingPolicy.explanation}
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
                <p className="text-[11px] text-[var(--color-text-muted)]">Caption optional</p>
              </div>
              <button type="button" onClick={clearImage} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white">Remove</button>
            </div>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl border border-[var(--color-border)] bg-white p-1.5 transition focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)] sm:gap-2">
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFilePicked} className="hidden" />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending || isStartingRecording || isRecording || !!voiceBlob || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : "Attach an image"} aria-label="Attach an image" className="flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-xl text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-primary)] disabled:opacity-50"><ImageIcon className="h-[18px] w-[18px]" /></button>
            {contact.mode === "human" && (
              <button type="button" onClick={startRecording} disabled={sending || isStartingRecording || isRecording || !!voiceBlob || !!imageFile || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : "Record a voice message"} aria-label="Record a voice message" className="flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-xl text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-primary)] disabled:opacity-50"><MicrophoneIcon className="h-[18px] w-[18px]" /></button>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={isStartingRecording || isRecording || !!voiceBlob}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={policyBlocksComposer ? "WhatsApp reply unavailable" : imageFile ? "Add a caption…" : contact.mode === "human" ? "Message this patient…" : "Message to take over from AI…"}
              rows={1}
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1.5 py-2.5 text-sm leading-relaxed outline-none disabled:opacity-50 sm:px-2.5"
            />
            <button type="submit" disabled={(!draft.trim() && !imageFile) || sending || isStartingRecording || isRecording || !!voiceBlob || policyBlocksComposer} title={policyBlocksComposer ? messagingPolicy.explanation : "Send message"} aria-label="Send message" className="flex h-10 shrink-0 touch-manipulation items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-3 text-xs font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:text-sm">
              {sending ? <Spinner /> : <SendIcon className="h-4 w-4" />}
              <span className="hidden sm:inline">{sending ? (imageFile ? "Uploading…" : "Sending…") : "Send"}</span>
            </button>
          </div>
        </div>
      </form>

      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </section>
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
      className="inline-flex shrink-0 items-center gap-1 px-0.5 text-[9px] font-medium text-[var(--color-text-muted)]"
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

function MessageBubble({ contactId, message, onImageClick, onRetry }) {
  const isPatient = message.role === "user";
  const sentByStaff = !isPatient && !!message.sent_by_username;
  const senderLabel = message.is_automated_follow_up
    ? "Automated follow-up"
    : sentByStaff
    ? message.sent_by_username
    : "AI";
  const isAudio = message.media_mime_type?.startsWith("audio/");
  const deliveryFailed = !isPatient && message.delivery_status === "failed";
  const deliveryUnconfirmed = !isPatient && message.delivery_status === "unknown";
  const deliveryNeedsAction = deliveryFailed || deliveryUnconfirmed;
  const policyFailureExplanationText = policyFailureExplanation(message);
  const storedMediaSrc = message.media_base64
    ? `data:${message.media_mime_type || "application/octet-stream"};base64,${message.media_base64}`
    : message.has_media_attachment
    ? api.messageMediaUrl(contactId, message.id)
    : null;
  const imageSrc = message.previewUrl || message.media_url || (!isAudio ? storedMediaSrc : null);
  const hasImage = !!imageSrc;

  return (
    <div className={`flex ${isPatient ? "justify-start" : "justify-end"}`}>
      <div className={`relative max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm sm:max-w-[78%] sm:px-4 xl:max-w-[68%] ${isPatient ? "bubble-in rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]" : "bubble-out rounded-br-md bg-[var(--color-primary)] text-white shadow-[0_2px_8px_rgba(47,111,98,0.14)]"} ${message._optimistic ? "opacity-70" : ""} ${deliveryNeedsAction ? "ring-2 ring-[var(--color-danger)]/80 ring-offset-2" : ""}`}>
        {!isPatient && <p className="mb-1 text-[10px] font-semibold text-white/65">{senderLabel}</p>}
        {isAudio && storedMediaSrc ? (
          <audio controls preload="none" src={storedMediaSrc} className="mb-1.5 max-w-full" style={{ height: "36px" }} />
        ) : (
          hasImage && (
            <div className="relative mb-1.5">
              <img src={imageSrc} alt={message.content || "Sent image"} onClick={() => !message._uploading && onImageClick?.(imageSrc)} className={`max-h-64 max-w-full rounded-lg object-cover ${message._uploading ? "" : "cursor-zoom-in"}`} />
              {message._uploading && <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30"><Spinner className="h-6 w-6 text-white" /></div>}
            </div>
          )
        )}
        {message.content && <p className="whitespace-pre-wrap break-words">{message.content}</p>}
        <div className={`mt-1.5 flex items-center gap-1.5 text-[10px] ${isPatient ? "text-[var(--color-text-muted)]" : "justify-end text-white/70"}`}>
          {message._optimistic && <Spinner className="h-2.5 w-2.5" />}
          <span>{formatTime(message.created_at)}</span>
          {!isPatient && !message._optimistic && !deliveryNeedsAction && (
            <DeliveryIndicator status={message.delivery_status} />
          )}
        </div>
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
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--color-danger)]/30 px-2 py-1 text-[10px] font-semibold transition-colors hover:bg-[var(--color-danger-light)] disabled:opacity-60"
                >
                  {message._retrying && <Spinner className="h-2.5 w-2.5" />}
                  {message._retrying ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
            {message.delivery_error && (
              <p className="mt-1 text-[10px] leading-snug opacity-80" title={message.delivery_error}>
                {message.delivery_error}
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
    </div>
  );
}

function DeliveryIndicator({ status }) {
  const indicators = {
    pending: { icon: "◷", label: "Queued", className: "text-white/70" },
    sent: { icon: "✓", label: "Sent", className: "text-white/70" },
    delivered: { icon: "✓✓", label: "Delivered", className: "text-white/80" },
    read: { icon: "✓✓", label: "Read", className: "text-cyan-100" },
  };
  const indicator = indicators[status];
  if (!indicator) return null;

  return (
    <span className={`font-medium ${indicator.className}`} title={indicator.label} aria-label={indicator.label}>
      {indicator.icon}
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

function formatTime(value) {
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
