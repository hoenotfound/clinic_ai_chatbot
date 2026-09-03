import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function toLocalInputValue(value) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function getDefaultScheduledFor(windowEndsAt) {
  const now = Date.now();
  let target = now + 60 * 60 * 1000;
  const windowEnd = windowEndsAt ? new Date(windowEndsAt).getTime() : NaN;

  if (Number.isFinite(windowEnd)) {
    target = Math.min(target, windowEnd - 5 * 60 * 1000);
  }

  if (target <= now + 60 * 1000) return "";
  return toLocalInputValue(new Date(target));
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusLabel(status) {
  const labels = {
    scheduled: "Scheduled",
    processing: "Sending",
    failed: "Failed",
    expired: "Expired",
  };
  return labels[status] || status;
}

function ClockIcon({ className = "" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3.2 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ className = "" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function nativeSetTextareaValue(textarea, value) {
  if (!textarea) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export default function ScheduledInboxMessages() {
  const [searchParams] = useSearchParams();
  const contactId = /^\d+$/.test(searchParams.get("contact") || "")
    ? Number(searchParams.get("contact"))
    : null;
  const formRef = useRef(null);
  const composerFormRef = useRef(null);
  const draftSnapshotRef = useRef("");
  const [composerMount, setComposerMount] = useState(null);
  const [composerBlocked, setComposerBlocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [windowEndsAt, setWindowEndsAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [content, setContent] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");

  const activeItems = useMemo(
    () => items.filter((item) => ["scheduled", "processing"].includes(item.status)),
    [items]
  );

  const windowEndTime = windowEndsAt ? new Date(windowEndsAt).getTime() : NaN;
  const windowOpen = Number.isFinite(windowEndTime) && windowEndTime > Date.now() + 60 * 1000;
  const maxScheduleValue = windowOpen
    ? toLocalInputValue(new Date(windowEndTime - 60 * 1000))
    : undefined;

  const load = useCallback(async () => {
    if (!contactId) return null;
    setLoading(true);
    try {
      const data = await request(`/conversations/${contactId}/scheduled-messages`);
      setItems(data.items || []);
      setWindowEndsAt(data.windowEndsAt || null);
      setError("");
      return data;
    } catch (err) {
      setError(err.message || "Couldn't load scheduled messages.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    setItems([]);
    setWindowEndsAt(null);
    setOpen(false);
    setEditingId(null);
    setContent("");
    setScheduledFor("");
    setError("");
    draftSnapshotRef.current = "";
    if (contactId) load();
  }, [contactId, load]);

  useEffect(() => {
    if (!contactId) {
      setComposerMount(null);
      composerFormRef.current = null;
      return undefined;
    }

    let ownedMount = null;

    function findComposer() {
      const conversationSection = document.querySelector(
        'section[aria-label^="Conversation with "]'
      );
      const form = conversationSection?.querySelector("form");
      const sendButton = form?.querySelector('button[type="submit"]');
      if (!form || !sendButton) return;

      composerFormRef.current = form;
      let mount = form.querySelector("[data-scheduled-message-composer-slot]");
      if (!mount) {
        mount = document.createElement("span");
        mount.dataset.scheduledMessageComposerSlot = "true";
        mount.style.display = "contents";
        sendButton.parentElement?.insertBefore(mount, sendButton);
        ownedMount = mount;
      }
      setComposerMount((current) => (current === mount ? current : mount));

      const textarea = form.querySelector("textarea");
      const hasMedia = !!form.querySelector(
        'img[alt="Selected attachment"], audio'
      );
      const blocked = !!textarea?.disabled || hasMedia;
      setComposerBlocked((current) => (current === blocked ? current : blocked));
    }

    findComposer();
    const observer = new MutationObserver(findComposer);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });

    return () => {
      observer.disconnect();
      if (ownedMount?.isConnected) ownedMount.remove();
      if (composerFormRef.current?.contains(ownedMount)) composerFormRef.current = null;
      setComposerMount(null);
    };
  }, [contactId]);

  useEffect(() => {
    if (!contactId) return undefined;
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    const onChange = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (
          Number(payload.contactId) === Number(contactId) &&
          payload.reason === "scheduled_message"
        ) {
          load();
        }
      } catch {
        // Ignore malformed events in this small companion listener.
      }
    };
    source.addEventListener("conversation_changed", onChange);
    return () => {
      source.removeEventListener("conversation_changed", onChange);
      source.close();
    };
  }, [contactId, load]);

  useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(event) {
      if (event.key === "Escape" && !saving) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, saving]);

  function resetForm(nextWindowEndsAt = windowEndsAt) {
    setEditingId(null);
    setContent("");
    setScheduledFor(getDefaultScheduledFor(nextWindowEndsAt));
    setError("");
    draftSnapshotRef.current = "";
  }

  async function openScheduler() {
    if (!contactId || composerBlocked) return;
    const textarea = composerFormRef.current?.querySelector("textarea");
    const draft = textarea?.value || "";
    draftSnapshotRef.current = draft;
    setEditingId(null);
    setContent(draft);
    setError("");
    setOpen(true);

    const data = await load();
    setScheduledFor(getDefaultScheduledFor(data?.windowEndsAt || null));
  }

  function startEdit(item) {
    setEditingId(item.id);
    setContent(item.content || "");
    setScheduledFor(toLocalInputValue(item.scheduled_for));
    setError("");
    draftSnapshotRef.current = "";
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function applyQuickTime(minutes) {
    const candidate = new Date(Date.now() + minutes * 60 * 1000);
    if (windowOpen && candidate.getTime() >= windowEndTime) {
      setError("That time is outside the active customer reply window.");
      return;
    }
    setScheduledFor(toLocalInputValue(candidate));
    setError("");
  }

  async function save(event) {
    event.preventDefault();
    if (!contactId || !content.trim() || !scheduledFor) return;
    const wasEditing = !!editingId;
    const scheduledContent = content.trim();
    setSaving(true);
    setError("");
    try {
      const path = editingId
        ? `/conversations/${contactId}/scheduled-messages/${editingId}`
        : `/conversations/${contactId}/scheduled-messages`;
      await request(path, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify({
          content: scheduledContent,
          scheduledFor: new Date(scheduledFor).toISOString(),
        }),
      });

      if (!wasEditing && draftSnapshotRef.current) {
        const textarea = composerFormRef.current?.querySelector("textarea");
        if (textarea?.value === draftSnapshotRef.current) {
          nativeSetTextareaValue(textarea, "");
        }
      }

      const data = await load();
      resetForm(data?.windowEndsAt || windowEndsAt);
      setOpen(false);
    } catch (err) {
      setError(err.message || "Couldn't schedule this message.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(item) {
    if (!contactId || item.status !== "scheduled") return;
    setError("");
    try {
      await request(`/conversations/${contactId}/scheduled-messages/${item.id}`, {
        method: "DELETE",
      });
      if (editingId === item.id) resetForm();
      await load();
    } catch (err) {
      setError(err.message || "Couldn't cancel this scheduled message.");
    }
  }

  if (!contactId) return null;

  const scheduleButton = composerMount
    ? createPortal(
        <button
          type="button"
          onClick={openScheduler}
          disabled={composerBlocked}
          title={
            composerBlocked
              ? "Scheduled messages support text only. Finish or remove the current media first."
              : activeItems.length > 0
              ? `${activeItems.length} scheduled message${activeItems.length === 1 ? "" : "s"}. Schedule another.`
              : "Schedule this message"
          }
          aria-label="Schedule message"
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-35 sm:h-10 sm:w-10 ${
            activeItems.length > 0
              ? "border-[var(--color-primary)]/20 bg-[var(--color-primary-light)] text-[var(--color-primary)]"
              : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)]"
          }`}
        >
          <ClockIcon className="h-[18px] w-[18px]" />
          {activeItems.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[9px] font-bold leading-none text-white shadow-sm">
              {activeItems.length > 9 ? "9+" : activeItems.length}
            </span>
          )}
        </button>,
        composerMount
      )
    : null;

  return (
    <>
      {scheduleButton}

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-0 backdrop-blur-[1px] sm:items-center sm:p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-message-title"
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white shadow-[0_24px_70px_rgba(20,34,28,0.22)] sm:max-w-lg sm:rounded-3xl"
          >
            <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-white/95 px-5 py-4 backdrop-blur sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
                      <ClockIcon className="h-4 w-4" />
                    </span>
                    <div>
                      <h2 id="schedule-message-title" className="font-display text-lg font-bold">
                        {editingId ? "Edit scheduled message" : "Schedule message"}
                      </h2>
                      <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                        Send this message automatically later.
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => !saving && setOpen(false)}
                  disabled={saving}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--color-text-muted)] transition hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] disabled:opacity-40"
                  aria-label="Close scheduled messages"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>

              <div
                className={`mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] ${
                  windowOpen
                    ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "bg-[var(--color-danger-light)] text-[var(--color-danger)]"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${windowOpen ? "bg-[var(--color-primary)]" : "bg-[var(--color-danger)]"}`} />
                <span className="font-semibold">
                  {windowOpen
                    ? `Can schedule until ${formatDateTime(windowEndsAt)}`
                    : windowEndsAt
                    ? `Reply window closed ${formatDateTime(windowEndsAt)}`
                    : "No active customer reply window"}
                </span>
              </div>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              <form ref={formRef} onSubmit={save} className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">Message</span>
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    rows={4}
                    maxLength={4096}
                    autoFocus
                    placeholder="Type the message to send later…"
                    className="w-full resize-y rounded-2xl border border-[var(--color-border)] bg-white px-3.5 py-3 text-sm leading-relaxed outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                  <div className="mt-1 flex justify-end text-[10px] text-[var(--color-text-muted)]">
                    {content.length}/4096
                  </div>
                </label>

                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-[var(--color-text)]">Send at</span>
                    {!editingId && windowOpen && (
                      <div className="flex items-center gap-1">
                        {[30, 60, 180].map((minutes) => {
                          const candidate = Date.now() + minutes * 60 * 1000;
                          const disabled = candidate >= windowEndTime;
                          return (
                            <button
                              key={minutes}
                              type="button"
                              onClick={() => applyQuickTime(minutes)}
                              disabled={disabled}
                              className="rounded-lg bg-[var(--color-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    min={toLocalInputValue(new Date(Date.now() + 60 * 1000))}
                    max={maxScheduleValue}
                    onChange={(event) => {
                      setScheduledFor(event.target.value);
                      setError("");
                    }}
                    disabled={!windowOpen}
                    className="w-full rounded-2xl border border-[var(--color-border)] bg-white px-3.5 py-3 text-sm font-medium text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)] disabled:cursor-not-allowed disabled:bg-[var(--color-bg)] disabled:opacity-60"
                  />
                </div>

                {error && (
                  <p className="rounded-xl bg-[var(--color-danger-light)] px-3 py-2.5 text-xs font-medium leading-relaxed text-[var(--color-danger)]">
                    {error}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  {editingId && (
                    <button
                      type="button"
                      onClick={() => resetForm()}
                      disabled={saving}
                      className="rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-xs font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-bg)] disabled:opacity-40"
                    >
                      New message
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={saving || !content.trim() || !scheduledFor || !windowOpen}
                    className="inline-flex min-w-[132px] items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving && (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white" />
                    )}
                    {saving ? "Saving…" : editingId ? "Save changes" : "Schedule"}
                  </button>
                </div>
              </form>

              <div className="border-t border-[var(--color-border)] pt-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold">Scheduled</h3>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      Manage messages that have not finished sending.
                    </p>
                  </div>
                  {items.length > 0 && (
                    <button
                      type="button"
                      onClick={load}
                      disabled={loading}
                      className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary-light)] disabled:opacity-40"
                    >
                      {loading ? "Refreshing…" : "Refresh"}
                    </button>
                  )}
                </div>

                {loading && items.length === 0 && (
                  <div className="space-y-2.5" aria-label="Loading scheduled messages">
                    {[0, 1].map((item) => (
                      <div key={item} className="h-20 animate-pulse rounded-2xl bg-[var(--color-bg)]" />
                    ))}
                  </div>
                )}

                {!loading && items.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)]/45 px-4 py-7 text-center">
                    <ClockIcon className="mx-auto h-5 w-5 text-[var(--color-text-muted)]" />
                    <p className="mt-2 text-xs font-semibold text-[var(--color-text)]">Nothing scheduled</p>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      Scheduled messages for this conversation will appear here.
                    </p>
                  </div>
                )}

                <div className="space-y-2.5">
                  {items.map((item) => {
                    const canChange = item.status === "scheduled";
                    const needsReview = item.status === "failed" || item.status === "expired";
                    return (
                      <div
                        key={item.id}
                        className={`rounded-2xl border p-3.5 ${
                          needsReview
                            ? "border-[var(--color-danger)]/20 bg-[var(--color-danger-light)]/35"
                            : "border-[var(--color-border)] bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${needsReview ? "bg-white text-[var(--color-danger)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
                            <ClockIcon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text)]">
                              {item.content}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                              <span className="font-semibold text-[var(--color-text)]">
                                {formatDateTime(item.scheduled_for)}
                              </span>
                              <span>•</span>
                              <span className={needsReview ? "font-semibold text-[var(--color-danger)]" : "font-medium"}>
                                {statusLabel(item.status)}
                              </span>
                              {item.scheduled_by_username && <span>• {item.scheduled_by_username}</span>}
                            </div>
                          </div>
                        </div>

                        {needsReview && item.failure_reason && (
                          <p className="mt-3 rounded-xl bg-white px-3 py-2 text-[10px] leading-relaxed text-[var(--color-danger)]">
                            {item.failure_reason}
                          </p>
                        )}

                        {canChange && (
                          <div className="mt-3 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => startEdit(item)}
                              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold transition hover:bg-[var(--color-bg)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => cancel(item)}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[var(--color-danger)] transition hover:bg-[var(--color-danger-light)]"
                            >
                              Cancel send
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
