import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Lightbox from "../components/Lightbox";
import ContactAvatar from "../components/ContactAvatar";

const POLL_INTERVAL_MS = 5000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // matches the server's Multer limit / WhatsApp's own cap
const MAX_VOICE_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_SECONDS = 120;
const VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

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
        const data = await api.getMessages(selectedId, { includeMedia: false });
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
      const data = await api.getMessages(selectedId, { includeMedia: false });
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

  async function handleSendVoice(recording, mimeType) {
    if (selectedId == null || !recording) return;
    setActionPending(true);

    try {
      const result = await api.sendVoice(selectedId, recording, mimeType);
      await Promise.all([refreshMessages(), refreshConversations()]);
      if (result?.delivered === false) {
        showToast(
          "Voice message saved but WhatsApp delivery failed — the patient may not have received it. Please try recording again.",
          "warning"
        );
      } else if (result?.transcribed === false) {
        showToast("Voice message sent. Its transcript couldn't be generated, but the recording was saved.", "info");
      }
    } catch (err) {
      console.error("Failed to send voice message:", err);
      showToast(err.message || "Couldn't send that voice message — please try again.", "error");
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
        onSendImage={handleSendImage}
        onSendVoice={handleSendVoice}
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
            <ContactAvatar src={c.photo_url} channel={c.channel} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate flex items-center gap-1.5">
                  {displayName(c)}
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
  onSendVoice,
  onToast,
}) {
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const recordingStartingRef = useRef(false);
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
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Clear the draft whenever the selected conversation changes.
  useEffect(() => {
    setDraft("");
    clearImage();
    cancelRecording();
    clearVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.contact_id]);

  // Voice recording is intentionally available only while staff owns the
  // conversation. Discard any unsent recording if the chat returns to AI.
  useEffect(() => {
    if (contact && contact.mode !== "human") {
      cancelRecording();
      clearVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.mode]);

  // Revoke the object URL when it's replaced/unmounted, so we don't leak memory.
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  useEffect(() => {
    return () => {
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    };
  }, [voicePreviewUrl]);

  useEffect(() => {
    // React StrictMode runs one setup/cleanup cycle twice in development.
    // Reset this flag in setup so the simulated cleanup does not leave the
    // real mounted component marked as unmounted.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRecordingRef.current = true;
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder?.state !== "inactive") recorder?.stop();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
    if (recorder?.state === "recording" || recorder?.state === "paused") {
      recorder.stop();
    }
  }

  function cancelRecording() {
    discardRecordingRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording" || recorder?.state === "paused") {
      recorder.stop();
    } else {
      cleanupRecordingHardware();
    }
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
    setIsStartingRecording(true);

    try {
      const recordingContactId = contact.contact_id;
      clearVoice();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      // The permission prompt can remain open while staff changes chats or
      // returns the conversation to AI. Do not start a stale recording after
      // they finally answer the prompt.
      if (
        !mountedRef.current ||
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
      recordingStartingRef.current = false;
      if (mountedRef.current) setIsStartingRecording(false);
    }
  }

  async function sendRecordedVoice() {
    if (!voiceBlob || sending) return;
    setSending(true);
    try {
      await onSendVoice(voiceBlob, voiceMimeType);
      clearVoice();
    } catch {
      // The toast is shown by the parent. Keep the preview so staff can retry.
    } finally {
      setSending(false);
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
    if (sending) return;
    if (isStartingRecording || isRecording || voiceBlob) return;
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
          <ContactAvatar src={contact.photo_url} channel={contact.channel} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-display font-bold text-base truncate">{displayName(contact)}</h2>
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
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
        {loading && <p className="text-sm text-[var(--color-text-muted)] text-center">Loading…</p>}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            contactId={contact.contact_id}
            message={m}
            onImageClick={setLightboxSrc}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        {isStartingRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <Spinner className="text-[var(--color-primary)]" />
            <div className="min-w-0">
              <p className="text-xs font-semibold">Starting microphone…</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Allow microphone access if your browser asks.
              </p>
            </div>
          </div>
        )}
        {isRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-red-600">Recording voice message</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {formatDuration(recordingSeconds)} / {formatDuration(MAX_VOICE_SECONDS)}
              </p>
            </div>
            <button
              type="button"
              onClick={cancelRecording}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={stopRecording}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              Stop
            </button>
          </div>
        )}
        {voicePreviewUrl && !isRecording && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
            <audio controls src={voicePreviewUrl} className="h-9 max-w-[260px]" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">Voice message · {formatDuration(voiceDuration)}</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">Listen before sending to the patient</p>
            </div>
            <button
              type="button"
              onClick={clearVoice}
              disabled={sending}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={sendRecordedVoice}
              disabled={sending}
              className="inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {sending && <Spinner />}
              {sending ? "Sending…" : "Send voice"}
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
            disabled={sending || isStartingRecording || isRecording || !!voiceBlob}
            title="Attach an image"
            aria-label="Attach an image"
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
          >
            📷
          </button>
          {contact.mode === "human" && (
            <button
              type="button"
              onClick={startRecording}
              disabled={sending || isStartingRecording || isRecording || !!voiceBlob || !!imageFile}
              title="Record a voice message"
              aria-label="Record a voice message"
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors disabled:opacity-50"
            >
              🎙️
            </button>
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
            placeholder={
              imageFile
                ? "Add a caption (optional)…"
                : contact.mode === "human"
                ? "Type a WhatsApp message to this patient…"
                : "Type a message — sending will take over this conversation from the AI…"
            }
            rows={1}
            className="flex-1 resize-none rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] max-h-32 overflow-y-auto disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={
              (!draft.trim() && !imageFile) ||
              sending ||
              isStartingRecording ||
              isRecording ||
              !!voiceBlob
            }
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

function MessageBubble({ contactId, message, onImageClick }) {
  const isPatient = message.role === "user";
  const sentByStaff = !isPatient && !!message.sent_by_username;
  const isAudio = message.media_mime_type?.startsWith("audio/");
  const storedMediaSrc = message.media_base64
    ? `data:${message.media_mime_type || "application/octet-stream"};base64,${message.media_base64}`
    : message.has_media_attachment
    ? api.messageMediaUrl(contactId, message.id)
    : null;

  // previewUrl (a local object URL) is only present on an optimistic bubble
  // for an image still uploading; otherwise fall back to the real stored
  // image source once it's come back from the server. Stored attachment
  // bytes are loaded from an authenticated URL rather than every poll.
  const imageSrc = message.previewUrl || message.media_url || (!isAudio ? storedMediaSrc : null);
  const hasImage = !!imageSrc;

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
        {isAudio && storedMediaSrc ? (
          <audio
            controls
            preload="none"
            src={storedMediaSrc}
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
