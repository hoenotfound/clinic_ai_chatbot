import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

const STATUS_LABELS = {
  sent: "Sent / accepted",
  pending: "Pending / unconfirmed",
  failed: "Failed",
  skipped: "Skipped",
  attention: "Needs review",
};
const REASON_LABELS = {
  already_sent: "Pricing graphic already sent",
  delivery_review: "Earlier pricing delivery is unconfirmed — review before retry",
  ambiguous_service: "Treatment could not be identified reliably",
  ambiguous_package: "Package choice or graphics are ambiguous",
  missing_promotion: "Matching pricing promotion or media unavailable",
  insufficient_window: "Not enough time remaining in the reply window",
  no_pricing_interest: "Customer did not meet the clinic's price-interest condition",
  human_review: "Human review requested",
};
const CHANNEL_LABELS = { whatsapp: "WhatsApp", facebook: "Messenger", instagram: "Instagram" };
const SELECT_CLASS = "min-h-10 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-white px-2.5 py-2 text-xs font-medium text-[var(--color-text)]";

function labelForReason(row) {
  if (row.event_id?.startsWith("message:")) {
    if (row.state === "pending") return "Provider acceptance or delivery has not been confirmed.";
    if (row.state === "sent") return "Provider status: " + String(row.raw_status || "sent") + ".";
    return row.detail || "Check this message in Inbox and verify its provider status before retrying.";
  }
  return REASON_LABELS[row.detail] || String(row.detail || "No reason recorded").replaceAll("_", " ");
}

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" :
    new Intl.DateTimeFormat("en-MY", {
      timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(date);
}

export default function FollowUpActivity({ active }) {
  const [filters, setFilters] = useState({ days: 7, channel: "all", type: "all", state: "all", page: 1 });
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getFollowUpActivity(filters)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setResult(null);
          setError(err.message || "Could not load follow-up activity.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, filters, refresh]);

  function changeFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value, page: 1 }));
  }

  const rows = result?.items || [];
  const totals = result?.summary || {};
  const stats = [
    ["sent", "Sent / accepted"],
    ["pending", "Unconfirmed"],
    ["failed", "Failed"],
    ["skipped", "Skipped"],
    ["attention", "Needs review"],
  ];

  return (
    <section aria-label="Follow-up delivery activity" className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold">Follow-up delivery activity</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Recorded Follow-up 1–3 messages, pricing reminders and terminal skip/review decisions
            across WhatsApp, Messenger and Instagram. Extended templates are shown separately below.
          </p>
        </div>
        <button type="button" onClick={() => setRefresh((x) => x + 1)} disabled={loading}
          className="min-h-10 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50">
          {loading ? "Refreshing…" : "Refresh activity"}
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Follow-up activity totals">
        {stats.map(([key, title]) => (
          <button type="button" key={key} onClick={() => changeFilter("state", filters.state === key ? "all" : key)}
            aria-pressed={filters.state === key}
            className={`min-h-16 rounded-lg border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] ${filters.state === key ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
            <p className="text-lg font-bold">{result ? Number(totals[key] || 0) : "—"}</p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{title}</p>
          </button>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="min-w-0 text-[11px] font-semibold">
          Period
          <select aria-label="Activity period" value={filters.days} onChange={(e) => changeFilter("days", Number(e.target.value))} className={`mt-1 ${SELECT_CLASS}`}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>
        <label className="min-w-0 text-[11px] font-semibold">
          Channel
          <select aria-label="Activity channel" value={filters.channel} onChange={(e) => changeFilter("channel", e.target.value)} className={`mt-1 ${SELECT_CLASS}`}>
            <option value="all">All channels</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="facebook">Messenger</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
        <label className="min-w-0 text-[11px] font-semibold">
          Message type
          <select aria-label="Activity type" value={filters.type} onChange={(e) => changeFilter("type", e.target.value)} className={`mt-1 ${SELECT_CLASS}`}>
            <option value="all">All types</option>
            <option value="sequence">Follow-up 1–3</option>
            <option value="pricing">Pricing reminders</option>
          </select>
        </label>
        <label className="min-w-0 text-[11px] font-semibold">
          Outcome
          <select aria-label="Activity outcome" value={filters.state} onChange={(e) => changeFilter("state", e.target.value)} className={`mt-1 ${SELECT_CLASS}`}>
            <option value="all">All outcomes</option>
            {Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      {error && (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800">
          <p>{error}</p>
          <button type="button" onClick={() => setRefresh((x) => x + 1)}
            className="min-h-9 rounded-lg border border-red-300 px-3 font-semibold">Try again</button>
        </div>
      )}
      {loading && <p role="status" className="mt-4 text-xs text-[var(--color-text-muted)]">Loading recorded activity…</p>}
      {!loading && !error && result && (
        <div className="mt-4" aria-label="Follow-up activity events">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold">Recent events</h3>
            <p className="text-xs text-[var(--color-text-muted)]">{result.total || 0} matching recorded events</p>
          </div>
          {rows.length === 0 ? (
            <p role="status" className="mt-3 rounded-lg border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
              No recorded events match these filters. This does not mean no follow-ups were eligible;
              quiet hours, skipped opportunities and pending worker checks are not always persisted as events.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {rows.map((row) => (
                <article key={row.event_id} className="min-w-0 rounded-xl border border-[var(--color-border)] p-3 sm:p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold">
                        {row.type === "pricing" ? "Pricing reminder" : `Follow-up ${row.step || "?"}`}
                        {" · "}{CHANNEL_LABELS[row.channel] || row.channel}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                        Contact #{row.contact_id} · {localTime(row.occurred_at)}
                      </p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${row.state === "failed" || row.state === "attention" ? "bg-amber-50 text-amber-900" : "bg-[var(--color-bg)] text-[var(--color-text)]"}`}>
                      {STATUS_LABELS[row.state] || row.state}
                    </span>
                  </div>
                  <p className="mt-2 break-words text-xs leading-5 text-[var(--color-text-muted)]">{labelForReason(row)}</p>
                  <Link to={`/inbox?contact=${encodeURIComponent(row.contact_id)}`}
                    className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-primary)]">
                    Open conversation
                  </Link>
                </article>
              ))}
            </div>
          )}
          {((result.page || 1) > 1 || result.hasMore) && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <button type="button" disabled={loading || filters.page <= 1}
                onClick={() => setFilters((old) => ({ ...old, page: Math.max(1, old.page - 1) }))}
                className="min-h-10 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-40">Previous</button>
              <p className="text-xs text-[var(--color-text-muted)]">Page {result.page}</p>
              <button type="button" disabled={loading || !result.hasMore || filters.page >= 20}
                onClick={() => setFilters((old) => ({ ...old, page: old.page + 1 }))}
                className="min-h-10 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-40">Next</button>
            </div>
          )}
        </div>
      )}
      <p className="mt-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
        Statuses reflect stored records at refresh time, not a live Meta bill or guaranteed delivery.
        “Sent / accepted” includes provider-delivered/read statuses; pending and unknown sends must be investigated
        before retry. Counters cover the chosen period, channel and message type, not just the displayed page.
      </p>
    </section>
  );
}
