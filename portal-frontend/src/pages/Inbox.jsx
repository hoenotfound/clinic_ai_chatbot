import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const POLL_INTERVAL_MS = 5000;

export default function Inbox() {
  const [conversations, setConversations] = useState(null); // null = loading
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [actionPending, setActionPending] = useState(false); // takeover/return/send in flight

  // ── Poll conversation list ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.listConversations();
        if (!cancelled) setConversations(data);
      } catch (err) {
        console.error("Failed to load conversations:", err);
      }
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Auto-select the first (most recent) conversation once loaded, if nothing's selected yet.
  useEffect(() => {
    if (conversations?.length && selectedId == null) {
      setSelectedId(conversations[0].contact_id);
    }
  }, [conversations, selectedId]);

  // ── Poll selected thread ──
  useEffect(() => {
    if (selectedId == null) return;
    let cancelled = false;

    async function load(showLoading) {
      if (showLoading) setMessagesLoading(true);
      try {
        const data = await api.getMessages(selectedId);
        if (!cancelled) setMessages(data.messages);
      } catch (err) {
        console.error("Failed to load messages:", err);
      } finally {
        if (showLoading) setMessagesLoading(false);
      }
    }

    load(true);
    const interval = setInterval(() => load(false), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedId]);

  async function refreshConversations() {
    try {
      const data = await api.listConversations();
      setConversations(data);
    } catch (err) {
      console.error("Failed to refresh conversations:", err);
    }
  }

  async function refreshMessages() {
    if (selectedId == null) return;
    try {
      const data = await api.getMessages(selectedId);
      setMessages(data.messages);
    } catch (err) {
      console.error("Failed to refresh messages:", err);
    }
  }

  async function handleTakeOver() {
    if (selectedId == null) return;
    setActionPending(true);
    try {
      await api.takeOver(selectedId);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to take over conversation:", err);
      alert("Couldn't take over this conversation — please try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleReturnToAi() {
    if (selectedId == null) return;
    setActionPending(true);
    try {
      await api.returnToAi(selectedId);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to return conversation to AI:", err);
      alert("Couldn't return this conversation to the AI — please try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleDismissAttention() {
    if (selectedId == null) return;
    try {
      await api.setAttention(selectedId, false);
      await refreshConversations();
    } catch (err) {
      console.error("Failed to dismiss attention flag:", err);
    }
  }

  async function handleSend(text) {
    if (selectedId == null || !text.trim()) return;
    setActionPending(true);
    try {
      const result = await api.sendMessage(selectedId, text.trim());
      await Promise.all([refreshMessages(), refreshConversations()]);
      if (result?.delivered === false) {
        alert("Message saved but WhatsApp delivery failed — the patient may not have received it. Please try resending.");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      alert("Couldn't send that message — please try again.");
      throw err;
    } finally {
      setActionPending(false);
    }
  }

  const selectedContact = conversations?.find((c) => c.contact_id === selectedId);

  return (
    <div className="flex h-full">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <ThreadView
        contact={selectedContact}
        messages={messages}
        loading={messagesLoading}
        actionPending={actionPending}
        onTakeOver={handleTakeOver}
        onReturnToAi={handleReturnToAi}
        onDismissAttention={handleDismissAttention}
        onSend={handleSend}
      />
    </div>
  );
}

function ConversationList({ conversations, selectedId, onSelect }) {
  return (
    <div className="w-80 shrink-0 border-r border-[var(--color-border)] h-full overflow-y-auto bg-[var(--color-surface)]">
      <div className="px-5 py-4 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-surface)]">
        <h1 className="font-display text-lg font-bold">Inbox</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          {conversations ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}` : "Loading…"}
        </p>
      </div>

      {conversations && conversations.length === 0 && (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            No conversations yet. Once a patient messages your WhatsApp number, they'll show up here.
          </p>
        </div>
      )}

      {conversations?.map((c) => (
        <button
          key={c.contact_id}
          onClick={() => onSelect(c.contact_id)}
          className={`relative w-full text-left px-5 py-3.5 border-b border-[var(--color-border)] transition-colors ${
            c.contact_id === selectedId
              ? "bg-[var(--color-primary-light)]"
              : c.needs_attention
              ? "bg-[var(--color-danger-light)] hover:brightness-95"
              : "hover:bg-[var(--color-bg)]"
          }`}
        >
          {c.needs_attention && (
            <span
              className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[var(--color-danger)]"
              title={c.attention_reason || "Needs attention"}
            />
          )}
          <div className="flex items-center justify-between gap-2 pl-2">
            <span className="font-medium text-sm truncate flex items-center gap-1.5">
              {c.name || formatPhone(c.whatsapp_number)}
              {c.mode === "human" && <ModeBadge mode="human" compact />}
            </span>
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{formatTime(c.last_message_at)}</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5 pl-2">
            {c.last_message_role === "assistant" ? "You: " : ""}
            {c.last_message_media_url ? "📷 " : ""}
            {c.last_message || (c.last_message_media_url ? "Photo" : "")}
          </p>
        </button>
      ))}
    </div>
  );
}

function ThreadView({
  contact,
  messages,
  loading,
  actionPending,
  onTakeOver,
  onReturnToAi,
  onDismissAttention,
  onSend,
}) {
  const bottomRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Clear the draft whenever the selected conversation changes.
  useEffect(() => {
    setDraft("");
  }, [contact?.contact_id]);

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
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft("");
    } catch {
      // error already surfaced to the user in onSend; keep draft so they can retry
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-display font-bold text-base truncate">{contact.name || formatPhone(contact.whatsapp_number)}</h2>
            <ModeBadge mode={contact.mode} />
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            {contact.whatsapp_number}
            {contact.mode === "human" && contact.takeover_by && ` · Taken over by ${contact.takeover_by}`}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {contact.needs_attention && (
            <button
              onClick={onDismissAttention}
              title={contact.attention_reason || "Needs attention"}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--color-danger-light)] text-[var(--color-danger)] hover:brightness-95 transition-all"
            >
              ⚠ Needs attention — dismiss
            </button>
          )}
          {contact.mode === "human" ? (
            <button
              onClick={onReturnToAi}
              disabled={actionPending}
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
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
        {loading && <p className="text-sm text-[var(--color-text-muted)] text-center">Loading…</p>}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex items-end gap-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder={
            contact.mode === "human"
              ? "Type a WhatsApp message to this patient…"
              : "Type a message — sending will take over this conversation from the AI…"
          }
          rows={1}
          className="flex-1 resize-none rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] max-h-32"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="shrink-0 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function ModeBadge({ mode, compact }) {
  const isHuman = mode === "human";
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 rounded-full font-medium uppercase tracking-wide ${
        compact ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5"
      } ${
        isHuman
          ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
          : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      }`}
    >
      {isHuman ? "Staff" : "AI"}
    </span>
  );
}

function MessageBubble({ message }) {
  const isPatient = message.role === "user";
  const sentByStaff = !isPatient && !!message.sent_by_username;
  return (
    <div className={`flex ${isPatient ? "justify-start" : "justify-end"}`}>
      <div
        className={`relative max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isPatient
            ? "bubble-in bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)]"
            : "bubble-out bg-[var(--color-primary)] text-white"
        }`}
      >
        {!isPatient && (
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5 text-white/70">
            {sentByStaff ? message.sent_by_username : "AI"}
          </p>
        )}
        {message.media_url && (
          <img
            src={message.media_url}
            alt={message.content || "Sent image"}
            className="rounded-lg mb-1.5 max-w-full max-h-64 object-cover"
          />
        )}
        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
        <p className={`text-[10px] mt-1 ${isPatient ? "text-[var(--color-text-muted)]" : "text-white/70"}`}>
          {formatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}

function formatPhone(number) {
  return `+${number}`;
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
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
