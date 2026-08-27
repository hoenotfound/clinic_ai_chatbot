import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Lightbox from "../components/Lightbox";
import ContactAvatar from "../components/ContactAvatar";

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
  { key: "attention", label: "Attention" },
];

const DELIVERY_STATUS_RANK = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

function mergeMessageState(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  const existingStatus = existing.delivery_status;
  const incomingStatus = incoming.delivery_status;
  const incomingHasWamid = Object.prototype.hasOwnProperty.call(incoming, "whatsapp_message_id");
  const deliveryAttemptChanged =
    incomingHasWamid && existing.whatsapp_message_id !== incoming.whatsapp_message_id;

  // A new WAMID means this is a genuinely new retry attempt, so its state may
  // start again at pending. For the same WAMID, only move forwards. This stops
  // a slower retry response from overwriting a failure webhook that already
  // arrived for that same attempt.
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

export default function Inbox() {
  const { username } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();

  const [conversations, setConversations] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [conversationStatePending, setConversationStatePending] = useState(false);
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

          // If a retry changed this message's WAMID while the reconciliation
          // request was in flight, its response may describe the old attempt.
          // Ignore that snapshot and let the retry response/live event win.
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
      const firstConversation = conversations[0];
      setSelectedId(firstConversation.contact_id);

      if (firstConversation.is_unread) {
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
  }, [conversations, selectedId, showToast]);

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
          payload.contactId != null &&
          Number(payload.contactId) === Number(selectedIdRef.current) &&
          payload.messageId != null &&
          Object.prototype.hasOwnProperty.call(payload, "deliveryStatus")
        ) {
          setMessages((current) =>
            current.map((message) =>
              Number(message.id) === Number(payload.messageId)
                ? mergeMessageState(message, {
                    whatsapp_message_id: payload.whatsappMessageId ?? message.whatsapp_message_id,
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
      // SSE does not replay events that happened before the connection opened.
      // Always reconcile, including the first open, to close the gap between
      // the initial thread request and the live stream becoming ready.
      scheduleRefresh();
    };
    source.onerror = () => {
      // EventSource reconnects automatically using the server's retry hint.
    };

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
      showToast("Couldn't send that message — please try again.", "error");
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
    <div className="flex h-full">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={handleSelectConversation}
      />
      <ThreadView
        key={selectedId ?? "no-conversation"}
        contact={selectedContact}
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
        onToast={showToast}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ConversationList({ conversations, selectedId, onSelect }) {
  const [filters, setFilters] = useState({
    status: "all",
    channel: "all",
    owner: "all",
    query: "",
  });

  const conversationList = useMemo(() => conversations || [], [conversations]);
  const statusCounts = useMemo(
    () => ({
      all: conversationList.length,
      unreplied: conversationList.filter((item) => item.last_message_role === "user").length,
      "follow-up": conversationList.filter((item) => item.needs_follow_up).length,
      unread: conversationList.filter((item) => item.is_unread).length,
      attention: conversationList.filter((item) => item.needs_attention).length,
    }),
    [conversationList]
  );

  const filteredConversations = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return conversationList.filter((conversation) => {
      if (filters.status === "unreplied" && conversation.last_message_role !== "user") return false;
      if (filters.status === "follow-up" && !conversation.needs_follow_up) return false;
      if (filters.status === "unread" && !conversation.is_unread) return false;
      if (filters.status === "attention" && !conversation.needs_attention) return false;
      if (filters.channel !== "all" && (conversation.channel || "whatsapp") !== filters.channel) return false;
      if (filters.owner !== "all" && conversation.mode !== filters.owner) return false;
      if (!query) return true;

      const searchableText = [
        displayName(conversation),
        conversation.whatsapp_number,
        conversation.last_message,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(query);
    });
  }, [conversationList, filters]);

  const hasActiveFilters =
    filters.status !== "all" ||
    filters.channel !== "all" ||
    filters.owner !== "all" ||
    !!filters.query.trim();

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    setFilters({ status: "all", channel: "all", owner: "all", query: "" });
  }

  return (
    <div className="w-[23rem] shrink-0 border-r border-[var(--color-border)] h-full overflow-y-auto bg-[var(--color-surface)]">
      <div className="px-4 py-4 border-b border-[var(--color-border)] sticky top-0 z-20 bg-[var(--color-surface)] shadow-[0_1px_0_rgba(0,0,0,0.02)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-lg font-bold">Inbox</h1>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {!conversations
                ? "Loading…"
                : hasActiveFilters
                ? `${filteredConversations.length} of ${conversationList.length} conversations`
                : `${conversationList.length} conversation${conversationList.length === 1 ? "" : "s"}`}
            </p>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline mt-1"
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="relative mt-3">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-muted)]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={filters.query}
            onChange={(event) => updateFilter("query", event.target.value)}
            placeholder="Search name, number or message"
            aria-label="Search conversations"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] pl-9 pr-3 py-2 text-xs outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
          />
        </div>

        <div className="grid grid-cols-5 gap-1 mt-3" aria-label="Conversation status filters">
          {STATUS_FILTERS.map((filter) => {
            const active = filters.status === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => updateFilter("status", filter.key)}
                aria-pressed={active}
                title={filter.key === "attention" ? "Needs attention" : undefined}
                className={`rounded-lg px-1 py-2 text-[10px] font-semibold transition-colors ${
                  active
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <span>{filter.label}</span>
                <span className={`ml-1 ${active ? "text-white/70" : "text-[var(--color-text-muted)]"}`}>
                  {statusCounts[filter.key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <label className="relative">
            <span className="sr-only">Filter by channel</span>
            <select
              value={filters.channel}
              onChange={(event) => updateFilter("channel", event.target.value)}
              className="w-full appearance-none rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 pr-7 text-xs font-medium outline-none focus:border-[var(--color-primary)]"
            >
              <option value="all">All channels</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-text-muted)]">▼</span>
          </label>
          <label className="relative">
            <span className="sr-only">Filter by conversation owner</span>
            <select
              value={filters.owner}
              onChange={(event) => updateFilter("owner", event.target.value)}
              className="w-full appearance-none rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 pr-7 text-xs font-medium outline-none focus:border-[var(--color-primary)]"
            >
              <option value="all">Bot + human</option>
              <option value="ai">Bot controlled</option>
              <option value="human">Human controlled</option>
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-text-muted)]">▼</span>
          </label>
        </div>
      </div>

      {conversations && conversations.length === 0 && (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            No conversations yet. Once a customer messages you, they'll show up here.
          </p>
        </div>
      )}

      {conversations && conversations.length > 0 && filteredConversations.length === 0 && (
        <div className="px-6 py-12 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-bg)] text-lg">⌕</div>
          <p className="text-sm font-semibold mt-3">No matching conversations</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">Try changing or clearing the filters.</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 text-xs font-semibold px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)]"
          >
            Clear filters
          </button>
        </div>
      )}

      {filteredConversations.map((c) => (
        <button
          key={c.contact_id}
          onClick={() => onSelect(c.contact_id)}
          className={`relative w-full text-left px-4 py-3.5 border-b border-[var(--color-border)] transition-colors ${
            c.contact_id === selectedId
              ? "bg-[var(--color-primary-light)]"
              : c.needs_attention
              ? "bg-[var(--color-danger-light)] hover:brightness-95"
              : c.is_unread
              ? "bg-[var(--color-bg)] hover:brightness-98"
              : "hover:bg-[var(--color-bg)]"
          }`}
        >
          {c.needs_attention && (
            <span
              className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[var(--color-danger)]"
              title={c.attention_reason || "Needs attention"}
            />
          )}
          <div className="flex items-center gap-3 pl-1.5">
            <ContactAvatar src={c.photo_url} channel={c.channel} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`${c.is_unread ? "font-semibold" : "font-medium"} text-sm truncate flex items-center gap-1.5`}>
                  {displayName(c)}
                  {c.is_unread && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" title="Unread" />}
                </span>
                <span className={`text-[11px] shrink-0 ${c.is_unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
                  {formatTime(c.last_message_at)}
                </span>
              </div>
              <p className={`text-xs truncate mt-0.5 ${c.is_unread ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                {c.last_message_role === "assistant" ? "You: " : ""}
                {c.last_message_media_url ? "📷 " : ""}
                {c.last_message || (c.last_message_media_url ? "Photo" : "")}
              </p>
              <div className="flex items-center gap-1.5 mt-1.5">
                <ChannelBadge channel={c.channel} />
                <ModeBadge mode={c.mode} compact />
                {c.needs_follow_up && (
                  <span className="inline-flex items-center rounded-full bg-[var(--color-accent-light)] text-[var(--color-accent)] text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5">
                    Follow-up
                  </span>
                )}
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ThreadView({
  contact,
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
  onToast,
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

  activeContactIdRef.current = contact?.contact_id;
  activeContactModeRef.current = contact?.mode;

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
    setSending(true);
    try {
      await onSendVoice(voiceBlob, voiceMimeType);
      if (mountedRef.current) clearVoice();
    } catch {
      // Parent shows the error toast. Keep the preview so staff can retry.
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  if (!contact) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-[var(--color-text-muted)]">Select a conversation to view the chat history.</p>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (sending || isStartingRecording || isRecording || voiceBlob) return;
    if (!text && !imageFile) return;
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
      // Parent shows the error toast; keep the draft/attachment for retry.
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <ContactAvatar src={contact.photo_url} channel={contact.channel} size={40} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display font-bold text-base truncate">{displayName(contact)}</h2>
                <ModeBadge mode={contact.mode} />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] truncate">
                {contact.whatsapp_number}
                {contact.mode === "human" && contact.takeover_by && ` · Taken over by ${contact.takeover_by}`}
              </p>
            </div>
          </div>
          {contact.mode === "human" ? (
            <button
              onClick={onReturnToAi}
              disabled={actionPending || isStartingRecording || isRecording || !!voiceBlob}
              title={isStartingRecording || isRecording || voiceBlob ? "Finish or cancel the voice recording first" : undefined}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
            >
              Return to AI
            </button>
          ) : (
            <button
              onClick={onTakeOver}
              disabled={actionPending}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              Take Over Conversation
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={onToggleFollowUp}
            disabled={conversationStatePending}
            aria-pressed={!!contact.needs_follow_up}
            title={contact.needs_follow_up ? "Remove follow-up flag" : "Add to follow-up list"}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
              contact.needs_follow_up
                ? "border-[var(--color-accent)] bg-[var(--color-accent-light)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)]"
            }`}
          >
            {contact.needs_follow_up ? "Follow-up saved" : "Add follow-up"}
          </button>
          <button
            type="button"
            onClick={onToggleUnread}
            disabled={conversationStatePending}
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
          >
            {contact.is_unread ? "Mark as read" : "Mark unread"}
          </button>
          {contact.needs_attention && (
            <button
              type="button"
              onClick={onDismissAttention}
              title={contact.attention_reason || "Needs attention"}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--color-danger-light)] text-[var(--color-danger)] hover:brightness-95 transition-all"
            >
              ⚠ Needs attention · Dismiss
            </button>
          )}
        </div>
      </div>

      <div ref={threadScrollRef} onScroll={handleThreadScroll} className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
        {hasMoreOlderMessages && (
          <div className="text-center pb-2">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={olderMessagesLoading}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] disabled:opacity-50"
            >
              {olderMessagesLoading ? "Loading older messages…" : "Load 50 older messages"}
            </button>
          </div>
        )}
        {loading && <p className="text-sm text-[var(--color-text-muted)] text-center">Loading…</p>}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            contactId={contact.contact_id}
            message={m}
            onImageClick={setLightboxSrc}
            onRetry={onRetryMessage}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        {isStartingRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <Spinner className="text-[var(--color-primary)]" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">Starting microphone…</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">Allow microphone access if your browser asks.</p>
            </div>
            <button type="button" onClick={cancelRecording} className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors">Cancel</button>
          </div>
        )}
        {isRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <span className="relative flex h-3 w-3 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" /></span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-red-600">Recording voice message</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">{formatDuration(recordingSeconds)} / {formatDuration(MAX_VOICE_SECONDS)}</p>
            </div>
            <button type="button" onClick={cancelRecording} className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors">Cancel</button>
            <button type="button" onClick={stopRecording} className="text-xs font-medium px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors">Stop</button>
          </div>
        )}
        {voicePreviewUrl && !isRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <audio controls src={voicePreviewUrl} className="h-9 max-w-[260px]" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">Voice message · {formatDuration(voiceDuration)}</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">Listen before sending to the patient</p>
            </div>
            <button type="button" onClick={clearVoice} disabled={sending} className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50">Remove</button>
            <button type="button" onClick={sendRecordedVoice} disabled={sending} className="inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
              {sending && <Spinner />}{sending ? "Sending…" : "Send voice"}
            </button>
          </div>
        )}
        {imagePreviewUrl && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <img src={imagePreviewUrl} alt="Selected attachment" className="w-16 h-16 rounded-lg object-cover border border-[var(--color-border)]" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{imageFile.name}</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">Add a caption below (optional) and hit Send</p>
            </div>
            <button type="button" onClick={clearImage} className="text-xs font-medium px-2.5 py-1 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors">Remove</button>
          </div>
        )}
        <div className="flex items-end gap-3">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFilePicked} className="hidden" />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending || isStartingRecording || isRecording || !!voiceBlob} title="Attach an image" aria-label="Attach an image" className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50">📷</button>
          {contact.mode === "human" && (
            <button type="button" onClick={startRecording} disabled={sending || isStartingRecording || isRecording || !!voiceBlob || !!imageFile} title="Record a voice message" aria-label="Record a voice message" className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50">🎙️</button>
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
            placeholder={imageFile ? "Add a caption (optional)…" : contact.mode === "human" ? "Type a WhatsApp message to this patient…" : "Type a message — sending will take over this conversation from the AI…"}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] max-h-32 overflow-y-auto disabled:opacity-50"
          />
          <button type="submit" disabled={(!draft.trim() && !imageFile) || sending || isStartingRecording || isRecording || !!voiceBlob} className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
            {sending && <Spinner />}{sending ? (imageFile ? "Uploading…" : "Sending…") : "Send"}
          </button>
        </div>
      </form>

      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  );
}

function ModeBadge({ mode, compact }) {
  const isHuman = mode === "human";
  return (
    <span className={`inline-flex items-center gap-1 shrink-0 rounded-full font-medium uppercase tracking-wide ${compact ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5"} ${isHuman ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
      {isHuman ? "Staff" : "AI"}
    </span>
  );
}

function ChannelBadge({ channel = "whatsapp" }) {
  const styles = {
    whatsapp: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    facebook: "bg-blue-50 text-blue-700",
    instagram: "bg-pink-50 text-pink-700",
  };
  const labels = { whatsapp: "WhatsApp", facebook: "Facebook", instagram: "Instagram" };
  return (
    <span className={`inline-flex items-center rounded-full text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 ${styles[channel] || styles.whatsapp}`}>
      {labels[channel] || channel}
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
  const isAudio = message.media_mime_type?.startsWith("audio/");
  const deliveryFailed = !isPatient && message.delivery_status === "failed";
  const storedMediaSrc = message.media_base64
    ? `data:${message.media_mime_type || "application/octet-stream"};base64,${message.media_base64}`
    : message.has_media_attachment
    ? api.messageMediaUrl(contactId, message.id)
    : null;
  const imageSrc = message.previewUrl || message.media_url || (!isAudio ? storedMediaSrc : null);
  const hasImage = !!imageSrc;

  return (
    <div className={`flex ${isPatient ? "justify-start" : "justify-end"}`}>
      <div className={`relative max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${isPatient ? "bubble-in bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)]" : "bubble-out bg-[var(--color-primary)] text-white"} ${message._optimistic ? "opacity-70" : ""} ${deliveryFailed ? "ring-2 ring-[var(--color-danger)] ring-offset-2" : ""}`}>
        {!isPatient && <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5 text-white/70">{sentByStaff ? message.sent_by_username : "AI"}</p>}
        {isAudio && storedMediaSrc ? (
          <audio controls preload="none" src={storedMediaSrc} className="mb-1.5 max-w-full" style={{ height: "36px" }} />
        ) : (
          hasImage && (
            <div className="relative mb-1.5">
              <img src={imageSrc} alt={message.content || "Sent image"} onClick={() => !message._uploading && onImageClick?.(imageSrc)} className={`rounded-lg max-w-full max-h-64 object-cover ${message._uploading ? "" : "cursor-zoom-in"}`} />
              {message._uploading && <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg"><Spinner className="text-white h-6 w-6" /></div>}
            </div>
          )
        )}
        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
        <div className={`text-[10px] mt-1 flex items-center gap-2 ${isPatient ? "text-[var(--color-text-muted)]" : "text-white/70"}`}>
          {message._optimistic && <Spinner className="h-2.5 w-2.5" />}
          <span>{formatTime(message.created_at)}</span>
          {!isPatient && !message._optimistic && !deliveryFailed && (
            <DeliveryIndicator status={message.delivery_status} />
          )}
        </div>
        {deliveryFailed && (
          <div className="mt-2 rounded-lg bg-white px-2.5 py-2 text-[var(--color-danger)]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold">Not delivered</span>
              <button
                type="button"
                onClick={() => onRetry?.(message.id)}
                disabled={message._retrying}
                className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-md border border-[var(--color-danger)]/30 px-2 py-1 hover:bg-[var(--color-danger-light)] transition-colors disabled:opacity-60"
              >
                {message._retrying && <Spinner className="h-2.5 w-2.5" />}
                {message._retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
            {message.delivery_error && (
              <p className="text-[10px] leading-snug mt-1 opacity-80" title={message.delivery_error}>
                {message.delivery_error}
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
    <span className={`inline-flex items-center gap-1 font-medium ${indicator.className}`} title={indicator.label}>
      <span aria-hidden="true">{indicator.icon}</span>
      <span>{indicator.label}</span>
    </span>
  );
}

function formatPhone(number) {
  return `+${number}`;
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
