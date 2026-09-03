import { useCallback, useEffect, useMemo, useState } from "react";
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

export default function ScheduledInboxMessages() {
  const [searchParams] = useSearchParams();
  const contactId = /^\d+$/.test(searchParams.get("contact") || "")
    ? Number(searchParams.get("contact"))
    : null;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [windowEndsAt, setWindowEndsAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [content, setContent] = useState("");
  const [scheduledFor, setScheduledFor] = useState(toLocalInputValue());

  const activeItems = useMemo(
    () => items.filter((item) => ["scheduled", "processing"].includes(item.status)),
    [items]
  );

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    try {
      const data = await request(`/conversations/${contactId}/scheduled-messages`);
      setItems(data.items || []);
      setWindowEndsAt(data.windowEndsAt || null);
      setError("");
    } catch (err) {
      setError(err.message || "Couldn't load scheduled messages.");
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
    setScheduledFor(toLocalInputValue());
    setError("");
    if (contactId) load();
  }, [contactId, load]);

  useEffect(() => {
    if (!contactId) return undefined;
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    const onChange = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (Number(payload.contactId) === Number(contactId) && payload.reason === "scheduled_message") {
          load();
        }
      } catch {
        // The main Inbox connection handles malformed events. This small
        // companion listener only needs to ignore them.
      }
    };
    source.addEventListener("conversation_changed", onChange);
    return () => {
      source.removeEventListener("conversation_changed", onChange);
      source.close();
    };
  }, [contactId, load]);

  function resetForm() {
    setEditingId(null);
    setContent("");
    setScheduledFor(toLocalInputValue());
    setError("");
  }

  function startEdit(item) {
    setEditingId(item.id);
    setContent(item.content || "");
    setScheduledFor(toLocalInputValue(item.scheduled_for));
    setError("");
  }

  async function save(event) {
    event.preventDefault();
    if (!contactId || !content.trim() || !scheduledFor) return;
    setSaving(true);
    setError("");
    try {
      const path = editingId
        ? `/conversations/${contactId}/scheduled-messages/${editingId}`
        : `/conversations/${contactId}/scheduled-messages`;
      await request(path, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify({
          content: content.trim(),
          scheduledFor: new Date(scheduledFor).toISOString(),
        }),
      });
      resetForm();
      await load();
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

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          load();
        }}
        className="absolute bottom-24 right-4 z-30 inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--color-text)] shadow-lg transition hover:bg-[var(--color-bg)] sm:right-6"
        title="Schedule a message"
      >
        <span aria-hidden="true">🕐</span>
        <span>Schedule</span>
        {activeItems.length > 0 && (
          <span className="rounded-full bg-[var(--color-primary)] px-1.5 py-0.5 text-[10px] text-white">
            {activeItems.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-4">
          <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:max-w-lg sm:rounded-3xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-white px-5 py-4">
              <div>
                <h2 className="font-display text-lg font-bold">Scheduled messages</h2>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {windowEndsAt
                    ? `Reply window ends ${formatDateTime(windowEndsAt)}`
                    : "No active customer reply window"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-bg)] text-lg"
                aria-label="Close scheduled messages"
              >
                ×
              </button>
            </div>

            <div className="space-y-5 p-5">
              <form onSubmit={save} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-bold">{editingId ? "Edit scheduled message" : "Schedule a message"}</h3>
                  {editingId && (
                    <button type="button" onClick={resetForm} className="text-xs font-semibold text-[var(--color-primary)]">
                      New message
                    </button>
                  )}
                </div>

                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={4}
                  maxLength={4096}
                  placeholder="Type the message to send later…"
                  className="mt-3 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                />

                <label className="mt-3 block text-xs font-semibold text-[var(--color-text-muted)]">
                  Send at
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    min={toLocalInputValue(new Date(Date.now() + 60 * 1000))}
                    max={windowEndsAt ? toLocalInputValue(windowEndsAt) : undefined}
                    onChange={(event) => setScheduledFor(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm font-medium text-[var(--color-text)] outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                </label>

                {error && (
                  <p className="mt-3 rounded-lg bg-[var(--color-danger-light)] px-3 py-2 text-xs font-medium text-[var(--color-danger)]">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={saving || !content.trim() || !scheduledFor || !windowEndsAt}
                  className="mt-3 w-full rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? "Saving…" : editingId ? "Save changes" : "Schedule message"}
                </button>
              </form>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-bold">Upcoming & needs review</h3>
                  <button type="button" onClick={load} className="text-xs font-semibold text-[var(--color-primary)]">
                    Refresh
                  </button>
                </div>

                {loading && <p className="py-5 text-center text-xs text-[var(--color-text-muted)]">Loading…</p>}
                {!loading && items.length === 0 && (
                  <p className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-7 text-center text-xs text-[var(--color-text-muted)]">
                    No scheduled messages for this conversation.
                  </p>
                )}

                <div className="space-y-2.5">
                  {items.map((item) => {
                    const canChange = item.status === "scheduled";
                    const needsReview = item.status === "failed" || item.status === "expired";
                    return (
                      <div key={item.id} className="rounded-2xl border border-[var(--color-border)] bg-white p-3.5 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.content}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                              <span className="font-semibold">🕐 {formatDateTime(item.scheduled_for)}</span>
                              <span>•</span>
                              <span>{statusLabel(item.status)}</span>
                              {item.scheduled_by_username && <span>• {item.scheduled_by_username}</span>}
                            </div>
                          </div>
                        </div>

                        {needsReview && item.failure_reason && (
                          <p className="mt-2 rounded-lg bg-[var(--color-danger-light)] px-2.5 py-2 text-[10px] leading-relaxed text-[var(--color-danger)]">
                            {item.failure_reason}
                          </p>
                        )}

                        {canChange && (
                          <div className="mt-3 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => startEdit(item)}
                              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => cancel(item)}
                              className="rounded-lg border border-[var(--color-danger)]/25 px-2.5 py-1.5 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]"
                            >
                              Cancel
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
