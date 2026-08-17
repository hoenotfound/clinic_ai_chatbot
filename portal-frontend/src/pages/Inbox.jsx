import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const POLL_INTERVAL_MS = 5000;

export default function Inbox() {
  const [conversations, setConversations] = useState(null); // null = loading
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

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

  return (
    <div className="flex h-full">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <ThreadView
        contact={conversations?.find((c) => c.contact_id === selectedId)}
        messages={messages}
        loading={messagesLoading}
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
          className={`w-full text-left px-5 py-3.5 border-b border-[var(--color-border)] transition-colors ${
            c.contact_id === selectedId ? "bg-[var(--color-primary-light)]" : "hover:bg-[var(--color-bg)]"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm truncate">{c.name || formatPhone(c.whatsapp_number)}</span>
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{formatTime(c.last_message_at)}</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
            {c.last_message_role === "assistant" ? "You: " : ""}
            {c.last_message}
          </p>
        </button>
      ))}
    </div>
  );
}

function ThreadView({ contact, messages, loading }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (!contact) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-[var(--color-text-muted)]">Select a conversation to view the chat history.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <h2 className="font-display font-bold text-base">{contact.name || formatPhone(contact.whatsapp_number)}</h2>
        <p className="text-xs text-[var(--color-text-muted)]">{contact.whatsapp_number}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
        {loading && <p className="text-sm text-[var(--color-text-muted)] text-center">Loading…</p>}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  const isPatient = message.role === "user";
  return (
    <div className={`flex ${isPatient ? "justify-start" : "justify-end"}`}>
      <div
        className={`relative max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isPatient
            ? "bubble-in bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)]"
            : "bubble-out bg-[var(--color-primary)] text-white"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
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

function formatTime(isoLike) {
  if (!isoLike) return "";
  // SQLite datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC without a timezone marker.
  const date = new Date(isoLike.replace(" ", "T") + "Z");
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
