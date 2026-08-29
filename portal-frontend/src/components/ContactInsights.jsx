import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";

const TEMPERATURE_STYLES = {
  hot: "bg-red-50 text-red-700 border-red-100",
  warm: "bg-orange-50 text-orange-700 border-orange-100",
  cold: "bg-blue-50 text-blue-700 border-blue-100",
};

const TEMPERATURE_LABELS = {
  hot: "🔥 Hot",
  warm: "🟠 Warm",
  cold: "🔵 Cold",
};

function valueOrFallback(value, fallback = "Not captured") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TemperatureBadge({ temperature }) {
  const normalized = String(temperature || "").toLowerCase();
  if (!TEMPERATURE_LABELS[normalized]) return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${TEMPERATURE_STYLES[normalized]}`}>
      {TEMPERATURE_LABELS[normalized]}
    </span>
  );
}

function MiniBadge({ children }) {
  if (!children) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-muted)]">
      {children}
    </span>
  );
}

function DetailItem({ label, value }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-[var(--color-text)]">
        {valueOrFallback(value)}
      </p>
    </div>
  );
}

export default function ContactInsights({ contactId, className = "" }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getContactInsights(contactId);
      setData(result);
    } catch (err) {
      console.error("Failed to load contact insights:", err);
      setError(err.message || "Couldn't load AI insights.");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  if (loading) {
    return (
      <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Spinner className="text-[var(--color-primary)]" />
          Loading AI conversation insights…
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}>
        <p className="text-sm font-semibold">AI Conversation Insights</p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-xs font-semibold hover:bg-[var(--color-bg)]"
        >
          Try again
        </button>
      </section>
    );
  }

  const lead = data?.lead;
  const insights = data?.aiInsights;
  const summary = insights?.summary || {};
  const treatment = summary.treatmentInterest || lead?.treatmentInterest;
  const branch = summary.preferredBranch || lead?.branchName;
  const appointment = summary.preferredAppointment ||
    (lead?.appointmentAt ? formatDateTime(lead.appointmentAt) : "");

  return (
    <section className={`overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-base" aria-hidden="true">✨</span>
            <div>
              <h3 className="text-sm font-bold">AI Conversation Insights</h3>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Latest saved handoff summary and lead details</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="shrink-0 rounded-lg border border-[var(--color-border)] bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-5 p-5">
        {lead && (
          <div className="flex flex-wrap gap-2">
            <TemperatureBadge temperature={lead.temperature} />
            <MiniBadge>{lead.stageName || "No stage"}</MiniBadge>
            {insights?.confidence && <MiniBadge>{`${insights.confidence} confidence`}</MiniBadge>}
            {lead.isClosed && <MiniBadge>Closed journey</MiniBadge>}
          </div>
        )}

        {!lead && (
          <div className="rounded-xl bg-[var(--color-bg)] px-4 py-4">
            <p className="text-sm font-semibold">No lead journey yet</p>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Lead details will appear here after this contact enters the pipeline.
            </p>
          </div>
        )}

        {lead && !insights && (
          <div className="rounded-xl bg-[var(--color-bg)] px-4 py-4">
            <p className="text-sm font-semibold">No AI summary yet</p>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              It will appear automatically after lead scoring completes for this lead journey.
            </p>
          </div>
        )}

        {insights && (
          <>
            {insights.isStale && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                <p className="text-xs font-semibold">New messages since this summary</p>
                <p className="mt-1 text-[11px] leading-4">
                  This snapshot does not include the newest chat messages yet. It will refresh after the next scoring pass.
                </p>
              </div>
            )}

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">Chat summary</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--color-text)]">
                {valueOrFallback(summary.chatSummary, "No conversation summary was captured.")}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <DetailItem label="Treatment / Interest" value={treatment} />
              <DetailItem label="Preferred Branch" value={branch} />
              <DetailItem label="Preferred Appointment" value={appointment} />
              <DetailItem label="Main Concern / Goal" value={summary.mainConcern} />
            </div>

            <div className="rounded-xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-primary)]">Recommended next action</p>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5">
                {valueOrFallback(summary.nextAction, "No specific next action captured.")}
              </p>
            </div>

            {insights.reason && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">Why this temperature</p>
                <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">{insights.reason}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3 text-[10px] text-[var(--color-text-muted)]">
              <span>{insights.updatedAt ? `Updated ${formatDateTime(insights.updatedAt)}` : "Saved AI summary"}</span>
              {insights.temperature && insights.temperature !== lead?.temperature && (
                <span>AI scored {TEMPERATURE_LABELS[insights.temperature] || insights.temperature}</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
