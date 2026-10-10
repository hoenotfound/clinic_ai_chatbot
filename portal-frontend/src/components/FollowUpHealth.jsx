import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

const CHANNELS = { whatsapp: "WhatsApp", facebook: "Messenger", instagram: "Instagram" };
const STATES = { failed: "Failed", attention: "Needs review", pending: "Stale pending" };
const CLASS = "min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-xs";

function formatTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur", month: "short", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hour12: true,
  }).format(date);
}

export default function FollowUpHealth({ active }) {
  const [filters, setFilters] = useState({ days: 7, channel: "all" });
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ data: null, loading: false, error: "" });
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setState({ data: null, loading: true, error: "" });
    api.getFollowUpHealth(filters).then((data) => {
      if (!cancelled) setState({ data, loading: false, error: "" });
    }).catch((error) => {
      if (!cancelled) setState({ data: null, loading: false, error: error.message || "Unable to load health." });
    });
    return () => { cancelled = true; };
  }, [active, filters, refresh]);

  const data = active && !state.loading && !state.error ? state.data : null;
  const grouped = useMemo(() => {
    const out = new Map();
    for (const item of data?.breakdown || []) {
      const key = [item.channel, item.type, item.part, item.step].join(":");
      if (!out.has(key)) out.set(key, { key, channel: item.channel, type: item.type,
        part: item.part, step: item.step, sent: 0, failed: 0, pending: 0, skipped: 0, attention: 0 });
      const row = out.get(key);
      if (Object.hasOwn(row, item.status)) row[item.status] += Number(item.count || 0);
    }
    return [...out.values()].sort((a,b) => a.channel.localeCompare(b.channel) ||
      a.type.localeCompare(b.type) || Number(a.step) - Number(b.step));
  }, [data]);

  return (
    <section role="region" aria-label="Follow-up health monitoring"
      className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold">Follow-up monitoring</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Read-only recorded delivery health and timing estimates. Never automatically retries messages.
          </p>
        </div>
        <button type="button" disabled={state.loading} onClick={() => setRefresh((x) => x + 1)}
          className="min-h-10 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold">
          Refresh health
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs font-semibold">Period
          <select aria-label="Health period" className={`mt-1 ${CLASS}`} value={filters.days}
            onChange={(e) => setFilters((v) => ({ ...v, days: Number(e.target.value) }))}>
            <option value={7}>7 days</option><option value={30}>30 days</option>
          </select>
        </label>
        <label className="text-xs font-semibold">Channel
          <select aria-label="Health channel" className={`mt-1 ${CLASS}`} value={filters.channel}
            onChange={(e) => setFilters((v) => ({ ...v, channel: e.target.value }))}>
            <option value="all">All channels</option>
            {Object.entries(CHANNELS).map(([value,label])=><option value={value} key={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {state.loading && <p role="status" className="mt-4 text-xs">Loading monitoring data…</p>}
      {state.error && <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-xs">
        {state.error} <button type="button" className="ml-2 underline" onClick={() => setRefresh((x)=>x+1)}>Try again</button>
      </div>}
      {data && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [data.eventCount, "Recorded events"],
              [data.failedCount, "Failed"],
              [data.attentionCount, "Needs review"],
              [data.stalePendingCount, "Pending over 20 min"],
            ].map(([number,label])=>(
              <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <p className="text-xl font-bold">{number}</p>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{label}</p>
              </div>
            ))}
          </div>
          <h3 className="mt-5 text-sm font-bold">Recorded outcomes by step and channel</h3>
          {grouped.length === 0 ? <p className="mt-2 text-xs text-[var(--color-text-muted)]">No recorded events for this period.</p> :
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead><tr className="border-b border-[var(--color-border)]">
                  {["Channel / item", "Sent", "Failed", "Pending", "Skipped", "Review"].map(k=>
                    <th key={k} className="whitespace-nowrap px-2 py-2 font-semibold">{k}</th>)}
                </tr></thead>
                <tbody>{grouped.map(row=><tr key={row.key} className="border-b border-[var(--color-border)]">
                  <td className="whitespace-nowrap px-2 py-2">{CHANNELS[row.channel] || row.channel} · {row.type==="pricing"?"Pricing":`FU${row.step}`}{row.part==="media"?" media":row.part==="decision"?" decision":""}</td>
                  {[row.sent,row.failed,row.pending,row.skipped,row.attention].map((value,i)=>
                    <td key={i} className="px-2 py-2 tabular-nums">{value}</td>)}
                </tr>)}</tbody>
              </table>
            </div>
          }
          <h3 className="mt-5 text-sm font-bold">Delivery issues requiring investigation</h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Failed, unknown, or pending for over 20 minutes. Check provider evidence and reply-window eligibility before any manual retry.
          </p>
          {(data.alerts || []).length === 0 ? <p className="mt-2 text-xs text-[var(--color-text-muted)]">No matching recorded delivery issues.</p> :
            <div className="mt-2 space-y-2">
              {data.alerts.map(a=><div key={a.id} className="rounded-lg border border-[var(--color-border)] p-3 text-xs">
                <p className="font-semibold">{CHANNELS[a.channel] || a.channel} · {a.type==="pricing"?"Pricing":`FU${a.step}`}{a.part==="media"?" attachment":a.part==="decision"?" decision":""} · {a.stale_pending?"Stale pending":(STATES[a.status] || a.status)}</p>
                <p className="mt-1 break-words text-[var(--color-text-muted)]">Contact #{a.contact_id} · {formatTime(a.created_at)}{a.detail?" · "+a.detail:""}</p>
                <Link to={`/inbox?contact=${encodeURIComponent(a.contact_id)}`} className="mt-2 inline-flex min-h-9 items-center rounded border px-3 text-[var(--color-primary)]">Review in Inbox</Link>
              </div>)}
            </div>
          }
          <h3 className="mt-5 text-sm font-bold">Upcoming follow-up review queue</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Estimates from the latest conversation and current saved sequence, not confirmed scheduled sends.
            Quiet hours, customer replies, staff takeover, appointment stage, opt-out, platform policies and worker eligibility
            can change or prevent sending. Pricing reminders require separate eligibility and are not predicted here.
          </p>
          {(data.upcoming || []).length === 0 ? <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            No estimable next steps in the active reply window.
          </p> : <div className="mt-2 space-y-2">
            {data.upcoming.map(v=><div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3 text-xs"
              key={v.contact_id}>
              <div><p className="font-semibold">{CHANNELS[v.channel] || v.channel} · FU{v.step} · Contact #{v.contact_id}</p>
                <p className="mt-1 text-[var(--color-text-muted)]">Estimated earliest: {formatTime(v.estimated_at)} · Reply window ends {formatTime(v.window_expires_at)}</p>
              </div>
              <Link to={`/inbox?contact=${encodeURIComponent(v.contact_id)}`} className="inline-flex min-h-9 items-center rounded border px-3 text-[var(--color-primary)]">Inspect</Link>
            </div>)}
          </div>}
          <p className="mt-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
            Counters count persisted events, not unique customers or provider bills. Media companions count separately.
            Some quiet-hour and eligibility deferrals leave no persisted decision. This dashboard never attempts a send.
          </p>
        </>
      )}
    </section>
  );
}
