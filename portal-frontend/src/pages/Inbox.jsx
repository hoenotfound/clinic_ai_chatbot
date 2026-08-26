import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Lightbox from "../components/Lightbox";

const POLL_INTERVAL_MS = 5000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // matches the server's Multer limit / WhatsApp's own cap

export default function Inbox() {
  const { username } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();

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
      showToast("Couldn't take over this conversation — please try again.", "error");
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
      showToast("Couldn't return this conversation to the AI — please try again.", "error");
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

  // Optimistic bubbles get a locally-unique string id (never collides with a
  // real numeric DB id) so they can be targeted for removal if the send fails.
  function makeOptimisticId() {
    return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function handleSend(text) {
    if (selectedId == null || !text.trim()) return;
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
      const result = await api.sendMessage(selectedId, text.trim());
      // Replaces the whole list from the server, so the optimistic bubble
      // above is swapped out for the real (persisted) message in one go.
      await Promise.all([refreshMessages(), refreshConversations()]);
      if (result?.delivered === false) {
        showToast(
          "Message saved but WhatsApp delivery failed — the patient may not have received it. Please try resending.",
          "warning"
        );
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      showToast("Couldn't send that message — please try again.", "error");
      throw err;
    } finally {
      setActionPending(false);
    }
  }

  async function handleSendImage(file, caption) {
    if (selectedId == null || !file) return;
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
      const result = await api.sendImage(selectedId, file, caption);
      await Promise.all([refreshMessages(), refreshConversations()]);
      if (result?.delivered === false) {
        showToast(
          "Image saved but WhatsApp delivery failed — the patient may not have received it. Please try resending.",
          "warning"
        );
      }
    } catch (err) {
      console.error("Failed to send image:", err);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      showToast(err.message || "Couldn't send that image — please try again.", "error");
      throw err;
    } finally {
      URL.revokeObjectURL(previewUrl);
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
        onSendImage={handleSendImage}
        onToast={showToast}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
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
          <div className="flex items-center gap-3 pl-2">
            <Avatar src={c.photo_url} channel={c.channel} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate flex items-center gap-1.5">
                  {c.name || formatPhone(c.whatsapp_number)}
                  {c.mode === "human" && <ModeBadge mode="human" compact />}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{formatTime(c.last_message_at)}</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                {c.last_message_role === "assistant" ? "You: " : ""}
                {c.last_message_media_url ? "📷 " : ""}
                {c.last_message || (c.last_message_media_url ? "Photo" : "")}
              </p>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// Small colored badge showing which channel a contact messaged in on. Only
// 'whatsapp' is wired up today (the only channel this app talks to);
// 'instagram' and 'facebook' are stubbed so the badge just works once those
// integrations exist — no Avatar changes needed then, only a contact's
// `channel` value changing.
const CHANNEL_BADGES = {
  whatsapp: {
    label: "WhatsApp",
    background: "#25D366",
    icon: (
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39a9.9 9.9 0 0 0 4.75 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.03c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.12.11-1.8-.11a13.6 13.6 0 0 1-1.85-.68c-2.6-1.13-4.3-3.75-4.44-3.93-.13-.18-1.06-1.41-1.06-2.7 0-1.28.67-1.9.91-2.16.24-.26.52-.33.7-.33.17 0 .35 0 .5.01.16.01.38-.06.59.45.24.58.81 2 .88 2.14.07.14.12.31.02.5-.09.18-.14.29-.28.45-.14.16-.29.35-.42.47-.14.13-.28.28-.12.55.16.27.71 1.17 1.52 1.9 1.05.94 1.93 1.23 2.2 1.37.27.14.43.12.59-.07.16-.19.68-.79.86-1.06.18-.27.36-.22.6-.13.24.09 1.55.73 1.82.87.27.13.44.2.51.31.07.11.07.63-.17 1.31z" />
    ),
  },
  instagram: {
    label: "Instagram",
    background: "#E1306C",
    icon: (
      <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.24 2.23.41.55.21.95.47 1.37.89.42.42.68.82.89 1.37.17.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.24 1.8-.41 2.23-.21.55-.47.95-.89 1.37-.42.42-.82.68-1.37.89-.42.17-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.24-2.23-.41a3.7 3.7 0 0 1-1.37-.89 3.7 3.7 0 0 1-.89-1.37c-.17-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.24-1.8.41-2.23.21-.55.47-.95.89-1.37.42-.42.82-.68 1.37-.89.42-.17 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.5a6.34 6.34 0 1 0 0 12.68 6.34 6.34 0 0 0 0-12.68zm0 10.46a4.12 4.12 0 1 1 0-8.24 4.12 4.12 0 0 1 0 8.24zm6.6-10.7a1.48 1.48 0 1 1-2.97 0 1.48 1.48 0 0 1 2.97 0z" />
    ),
  },
  facebook: {
    label: "Facebook",
    background: "#0866FF",
    icon: (
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.89h2.78l-.44 2.91h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94z" />
    ),
  },
};

// Generic contact avatar. `src` renders a real photo when the contact's
// channel gives us one (Instagram/Facebook Messenger's APIs return a
// profile photo URL — this is what shows once those integrations exist);
// WhatsApp's Cloud API never provides a patient's profile picture at all,
// so WhatsApp contacts always fall back to the silhouette below. `channel`
// picks which small badge to overlay.
function Avatar({ src, channel = "whatsapp", size = 40 }) {
  const badgeSize = Math.round(size * 0.4);
  const badge = CHANNEL_BADGES[channel];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="w-full h-full rounded-full bg-[var(--color-border)] flex items-center justify-center overflow-hidden">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" />
        ) : (
          <svg viewBox="0 0 24 24" width="70%" height="70%" fill="var(--color-surface)">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7v1H4v-1z" />
          </svg>
        )}
      </div>
      {badge && (
        <span
          className="absolute bottom-0 right-0 rounded-full flex items-center justify-center ring-2 ring-[var(--color-surface)]"
          style={{ width: badgeSize, height: badgeSize, background: badge.background }}
          title={badge.label}
        >
          <svg viewBox="0 0 24 24" width="65%" height="65%" fill="white">
            {badge.icon}
          </svg>
        </span>
      )}
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
  onSendImage,
  onToast,
}) {
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Clear the draft whenever the selected conversation changes.
  useEffect(() => {
    setDraft("");
    clearImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.contact_id]);

  // Revoke the object URL when it's replaced/unmounted, so we don't leak memory.
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  // Auto-grow the textarea to fit its content, up to the max-h-32 cap below.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [draft]);

  function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
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
    if (sending) return;
    if (!text && !imageFile) return;
    setSending(true);
    try {
      if (imageFile) {
        // Caption travels with the image as one WhatsApp message, same as
        // how a phone's WhatsApp app attaches a caption to a photo.
        await onSendImage(imageFile, text);
        clearImage();
      } else {
        await onSend(text);
      }
      setDraft("");
    } catch {
      // error already surfaced to the user in onSend/onSendImage; keep draft so they can retry
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar src={contact.photo_url} channel={contact.channel} size={40} />
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
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onImageClick={setLightboxSrc} />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        {imagePreviewUrl && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <img src={imagePreviewUrl} alt="Selected attachment" className="w-16 h-16 rounded-lg object-cover border border-[var(--color-border)]" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{imageFile.name}</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">Add a caption below (optional) and hit Send</p>
            </div>
            <button
              type="button"
              onClick={clearImage}
              className="text-xs font-medium px-2.5 py-1 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors"
            >
              Remove
            </button>
          </div>
        )}
        <div className="flex items-end gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFilePicked}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Attach an image"
            aria-label="Attach an image"
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
          >
            📷
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={
              imageFile
                ? "Add a caption (optional)…"
                : contact.mode === "human"
                ? "Type a WhatsApp message to this patient…"
                : "Type a message — sending will take over this conversation from the AI…"
            }
            rows={1}
            className="flex-1 resize-none rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] max-h-32 overflow-y-auto"
          />
          <button
            type="submit"
            disabled={(!draft.trim() && !imageFile) || sending}
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            {sending && <Spinner />}
            {sending ? (imageFile ? "Uploading…" : "Sending…") : "Send"}
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

function Spinner({ className = "" }) {
  return (
    <svg
      className={`animate-spin h-3.5 w-3.5 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function MessageBubble({ message, onImageClick }) {
  const isPatient = message.role === "user";
  const sentByStaff = !isPatient && !!message.sent_by_username;

  // previewUrl (a local object URL) is only present on an optimistic bubble
  // for an image still uploading; otherwise fall back to the real stored
  // image source once it's come back from the server.
  const imageSrc =
    message.previewUrl ||
    message.media_url ||
    (message.media_base64 ? `data:${message.media_mime_type || "image/jpeg"};base64,${message.media_base64}` : null);
  const hasImage = !!imageSrc && !message.media_mime_type?.startsWith("audio/");

  return (
    <div className={`flex ${isPatient ? "justify-start" : "justify-end"}`}>
      <div
        className={`relative max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isPatient
            ? "bubble-in bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)]"
            : "bubble-out bg-[var(--color-primary)] text-white"
        } ${message._optimistic ? "opacity-70" : ""}`}
      >
        {!isPatient && (
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5 text-white/70">
            {sentByStaff ? message.sent_by_username : "AI"}
          </p>
        )}
        {message.media_base64?.length > 0 && message.media_mime_type?.startsWith("audio/") ? (
          <audio
            controls
            src={`data:${message.media_mime_type.split(";")[0].trim()};base64,${message.media_base64}`}
            className="mb-1.5 max-w-full"
            style={{ height: "36px" }}
          />
        ) : (
          hasImage && (
            <div className="relative mb-1.5">
              <img
                src={imageSrc}
                alt={message.content || "Sent image"}
                onClick={() => !message._uploading && onImageClick?.(imageSrc)}
                className={`rounded-lg max-w-full max-h-64 object-cover ${message._uploading ? "" : "cursor-zoom-in"}`}
              />
              {message._uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                  <Spinner className="text-white h-6 w-6" />
                </div>
              )}
            </div>
          )
        )}
        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
        <p className={`text-[10px] mt-1 flex items-center gap-1 ${isPatient ? "text-[var(--color-text-muted)]" : "text-white/70"}`}>
          {message._optimistic && <Spinner className="h-2.5 w-2.5" />}
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
