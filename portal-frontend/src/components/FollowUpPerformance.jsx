import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import FollowUpIntelligence from "./FollowUpIntelligence";

const CHANNELS = { all: "All channels", whatsapp: "WhatsApp", facebook: "Messenger", instagram: "Instagram" };
const SECTIONS = [
  { key: "step", title: "By follow-up step", note: "Compare FU1, FU2, FU3 and pricing reminders" },
  { key: "service", title: "By recorded service", note: "Only services stored on messages; unknown history stays unclassified" },
  { key: "media", title: "By accepted media", note: "Media accepted by provider, not proof that recipients viewed it" },
  { key: "channel", title: "By channel", note: "WhatsApp, Messenger and Instagram" },
  { key: "hour", title: "By sending hour", note: "Malaysia local time; sample size matters more than rankings" },
];

function pct(n, d) {
  if (!d) return "—";
  return `${(100 * n / d).toFixed(1)}%`;
}
function ratio(n, d) {
  return d ? `${n} / ${d}` : "0 mature";
}
function formatHour(value) {
  return `${String(value).padStart(2, "0")}:00–${String((Number(value) + 1) % 24).padStart(2, "0")}:00`;
}
function metric(v, title, subtitle) {
  return (
    <div key={title} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="text-xl font-bold tabular-nums">{v}</p>
      <p className="mt-1 text-xs font-semibold">{title}</p>
      <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-muted)]">{subtitle}</p>
    </div>
  );
}
function Breakdown({ rows, title, note, dimension }) {
  const [showAll, setShowAll] = useState(false);
  if (!rows.length) return (
    <section className="rounded-xl border border-[var(--color-border)] p-4">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">No accepted follow-ups in this group.</p>
    </section>
  );
  const ordered = [...rows].sort((a, b) => dimension === "hour"
    ? Number(a.label) - Number(b.label)
    : dimension === "step"
      ? (["FU1","FU2","FU3","Pricing","Extended WA template"].indexOf(a.label)
        - ["FU1","FU2","FU3","Pricing","Extended WA template"].indexOf(b.label))
      : b.sent - a.sent || a.label.localeCompare(b.label));
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-white p-4">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{note}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-[620px] w-full text-left text-xs">
          <thead><tr className="border-b border-[var(--color-border)]">
            {["Group", "Accepted", "Reply · 72h", "Appointment · 7d", "Visit · 7d", "Won · 7d", "Avg reply · mature"].map(s =>
              <th key={s} className="px-2 py-2 font-semibold whitespace-nowrap">{s}</th>)}
          </tr></thead>
          <tbody>{(showAll ? ordered : ordered.slice(0, dimension === "hour" ? 24 : 30)).map((v) =>
            <tr key={v.label} className="border-b border-[var(--color-border)]">
              <td className="px-2 py-2 font-semibold">{dimension === "hour" ? formatHour(v.label) : v.label}</td>
              <td className="px-2 py-2 tabular-nums">{v.sent}</td>
              <td className="px-2 py-2 tabular-nums">{pct(v.replied_matured, v.reply_matured)}
                <span className="block text-[10px] text-[var(--color-text-muted)]">{ratio(v.replied_matured, v.reply_matured)}</span>
              </td>
              <td className="px-2 py-2 tabular-nums">{pct(v.appointments_matured, v.milestone_matured)}
                <span className="block text-[10px] text-[var(--color-text-muted)]">{ratio(v.appointments_matured, v.milestone_matured)}</span>
              </td>
              <td className="px-2 py-2 tabular-nums">{pct(v.visits_matured, v.milestone_matured)}
                <span className="block text-[10px] text-[var(--color-text-muted)]">{ratio(v.visits_matured, v.milestone_matured)}</span>
              </td>
              <td className="px-2 py-2 tabular-nums">{pct(v.won_matured, v.milestone_matured)}
                <span className="block text-[10px] text-[var(--color-text-muted)]">{ratio(v.won_matured, v.milestone_matured)}</span>
              </td>
              <td className="px-2 py-2 tabular-nums">{v.avg_reply_hours == null ? "—" : `${v.avg_reply_hours}h`}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {ordered.length > 30 && dimension !== "hour" && <button type="button" className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-semibold" onClick={() => setShowAll(value => !value)}>{showAll ? "Show fewer groups" : `Show all ${ordered.length} groups`}</button>}
    </section>
  );
}

export default function FollowUpPerformance({ active }) {
  const [filters, setFilters] = useState({ days: 30, channel: "all" });
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ loading: false, data: null, error: "" });
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setState({ loading: true, data: null, error: "" });
    api.getFollowUpPerformance(filters).then(data => {
      if (!cancelled) setState({ loading: false, data, error: "" });
    }).catch(error => {
      if (!cancelled) setState({ loading: false, data: null, error: error.message || "Unable to load performance." });
    });
    return () => { cancelled = true; };
  }, [active, filters, refresh]);
  const data = active && !state.loading && !state.error ? state.data : null;
  const sections = useMemo(() => {
    const groups = new Map();
    for (const row of data?.breakdown || []) {
      if (!groups.has(row.dimension)) groups.set(row.dimension, []);
      groups.get(row.dimension).push(row);
    }
    return groups;
  }, [data]);

  return (
    <section role="region" aria-label="Follow-up performance analytics" className="space-y-4">
      <div className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div><h2 className="text-base font-bold">Follow-up performance</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Observed replies and pipeline outcomes after accepted follow-ups—not proof of incremental lift.
            </p>
          </div>
          <button type="button" className="min-h-10 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold"
            disabled={state.loading} onClick={() => setRefresh(n => n + 1)}>Refresh analytics</button>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="text-xs font-semibold">Period
            <select aria-label="Performance period" className="mt-1 block min-h-10 rounded-lg border border-[var(--color-border)] px-3"
              value={filters.days} onChange={e => setFilters(f => ({ ...f, days: Number(e.target.value) }))}>
              <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
            </select>
          </label>
          <label className="text-xs font-semibold">Channel
            <select aria-label="Performance channel" className="mt-1 block min-h-10 rounded-lg border border-[var(--color-border)] px-3"
              value={filters.channel} onChange={e => setFilters(f => ({ ...f, channel: e.target.value }))}>
              {Object.entries(CHANNELS).map(([value,label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        </div>
        {state.loading && <p role="status" className="mt-4 text-xs">Loading performance data…</p>}
        {state.error && <p role="alert" className="mt-4 text-xs text-red-700">{state.error}</p>}
        {data && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {metric(data.summary.sent, "Accepted follow-ups", `${data.summary.contacts} distinct contacts · ${data.summary.reply_matured} reply-mature · ${data.summary.milestone_matured} milestone-mature`)}
              {metric(pct(data.summary.replied_matured, data.summary.reply_matured), "72-hour reply rate",
                ratio(data.summary.replied_matured, data.summary.reply_matured) + " mature sends")}
              {metric(pct(data.summary.appointments_matured, data.summary.milestone_matured), "7-day appointment rate",
                ratio(data.summary.appointments_matured, data.summary.milestone_matured) + " mature sends")}
              {metric(pct(data.summary.visits_matured, data.summary.milestone_matured), "7-day visit rate",
                ratio(data.summary.visits_matured, data.summary.milestone_matured) + " mature sends")}
              {metric(pct(data.summary.won_matured, data.summary.milestone_matured), "7-day won rate",
                ratio(data.summary.won_matured, data.summary.milestone_matured) + " mature sends")}
              {metric(data.summary.replied_observed, "Follow-ups with a first reply", "First customer response within 72 hours, including immature sends")}
            </div>
            <div className="mt-4 rounded-lg border border-[var(--color-border)] p-3 text-xs leading-5 text-[var(--color-text-muted)]">
              <strong>How attribution works:</strong> One accepted follow-up or pricing message counts as one touch.
              Separately sent media is not counted again. The first customer reply, or each pipeline stage change
              is assigned to the most recent eligible follow-up, ending at the next touch. Reply rates use only
              sends at least 72 hours old; appointment, visit and won rates use sends at least 7 days old. Average reply time uses mature sends only.
              Later stages count as reaching earlier stages. Pipeline changes are staff-recorded milestones, not guaranteed appointments or sales.
              The selected period is based on send dates, not outcome dates. A dash means there is not yet a mature sample. New leads and newer follow-ups can affect outcomes.
            </div>
          </>
        )}
      </div>
      {data && (
        <>
          <FollowUpIntelligence report={data} />
          <section className="rounded-xl border border-[var(--color-border)] bg-white p-4">
            <h3 className="text-sm font-bold">Accepted follow-ups by day</h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Malaysia local date; daily bars count accepted sends, not unique customers.</p>
            {(data.daily || []).length === 0 ? <p className="mt-3 text-xs">No accepted follow-ups in this period.</p> :
              <div className="mt-3 space-y-2">
                {data.daily.map(row => {
                  const max = Math.max(1, ...data.daily.map(d => d.sent));
                  return <div key={row.label} className="grid grid-cols-[5.8rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
                    <span className="tabular-nums">{row.label}</span>
                    <div className="h-3 overflow-hidden rounded bg-[var(--color-bg)]">
                      <div className="h-full rounded bg-[var(--color-primary)]" style={{ width: `${(row.sent / max) * 100}%` }} />
                    </div>
                    <span className="text-right tabular-nums">{row.sent}</span>
                  </div>;
                })}
              </div>}
          </section>
          {SECTIONS.map(section => (
            <Breakdown key={section.key} title={section.title} note={section.note}
              dimension={section.key} rows={sections.get(section.key) || []} />
          ))}
          <p className="text-xs leading-5 text-[var(--color-text-muted)]">
            Timing, media and service comparisons are descriptive. Correlation is not causation;
            do not change follow-up sending cadence solely based on small or immature samples.
            This view does not send messages, change lead stages or modify follow-up settings.
          </p>
        </>
      )}
    </section>
  );
}
