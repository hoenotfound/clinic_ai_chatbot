import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "../components/Spinner";

const TIME_ZONE = "Asia/Kuala_Lumpur";
const PRESETS = [7, 30, 90];

function dateInMalaysia(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeForDays(days) {
  const to = dateInMalaysia();
  return { from: shiftDate(to, -(days - 1)), to };
}

function money(value) {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-MY", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) {
    const minutes = Math.floor(value / 60);
    const remaining = Math.round(value % 60);
    return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDay(day, dayCount) {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: dayCount > 31 ? "short" : "short",
  }).format(date);
}

function deltaLabel(delta, type = "percent") {
  if (delta == null) return "No prior baseline";
  const value = Number(delta) || 0;
  const sign = value > 0 ? "+" : "";
  return type === "points" ? `${sign}${value.toFixed(1)} pp` : `${sign}${value.toFixed(1)}%`;
}

function deltaTone(delta) {
  if (delta == null || Number(delta) === 0) return "text-[var(--color-text-muted)]";
  return Number(delta) > 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]";
}

export default function Analytics() {
  const initialRange = useMemo(() => rangeForDays(30), []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [branch, setBranch] = useState("all");
  const [channel, setChannel] = useState("all");
  const [source, setSource] = useState("all");
  const [campaign, setCampaign] = useState("all");
  const [treatment, setTreatment] = useState("all");
  const [owner, setOwner] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.getAnalytics({
        from,
        to,
        branch,
        channel,
        source,
        campaign,
        treatment,
        owner,
      });
      setData(payload);
    } catch (err) {
      console.error("Failed to load analytics:", err);
      setError(err.message || "Couldn't load analytics.");
    } finally {
      setLoading(false);
    }
  }, [branch, campaign, channel, from, owner, source, to, treatment]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  function applyPreset(days) {
    const range = rangeForDays(days);
    setFrom(range.from);
    setTo(range.to);
  }

  function clearFilters() {
    setBranch("all");
    setChannel("all");
    setSource("all");
    setCampaign("all");
    setTreatment("all");
    setOwner("all");
  }

  const filterOptions = data?.filterOptions || {};
  const hasFilters = [branch, channel, source, campaign, treatment, owner].some((value) => value !== "all");

  return (
    <div className="min-h-full bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-5 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-xl font-bold">Analytics</h1>
              <span className="rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-primary)]">Sales & conversations</span>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Track how enquiries move from first message to appointment, clinic visit, and conversion.</p>
          </div>
          <button
            type="button"
            onClick={loadAnalytics}
            disabled={loading}
            className="rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm font-semibold hover:bg-[var(--color-bg)] disabled:opacity-60"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-2.5">
          <div className="flex gap-1 rounded-xl bg-[var(--color-bg)] p-1">
            {PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => applyPreset(days)}
                className="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-text)]"
              >
                {days} days
              </button>
            ))}
          </div>
          <DateField label="From" value={from} onChange={setFrom} />
          <DateField label="To" value={to} onChange={setTo} />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2.5">
          <FilterSelect label="Branch" value={branch} onChange={setBranch} options={filterOptions.branches} />
          <FilterSelect label="Channel" value={channel} onChange={setChannel} options={filterOptions.channels} format={formatChannel} />
          <FilterSelect label="Source" value={source} onChange={setSource} options={filterOptions.sources} />
          <FilterSelect label="Campaign" value={campaign} onChange={setCampaign} options={filterOptions.campaigns} />
          <FilterSelect label="Treatment" value={treatment} onChange={setTreatment} options={filterOptions.treatments} />
          <FilterSelect label="Owner" value={owner} onChange={setOwner} options={filterOptions.owners} />
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="mb-px rounded-xl px-3 py-2.5 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]">
              Clear filters
            </button>
          )}
        </div>
      </header>

      {loading && !data ? (
        <div className="flex min-h-[32rem] items-center justify-center"><Spinner className="h-8 w-8 text-[var(--color-primary)]" /></div>
      ) : error && !data ? (
        <div className="mx-auto max-w-lg px-5 py-16 text-center">
          <div className="rounded-3xl border border-[var(--color-border)] bg-white p-8 shadow-sm">
            <h2 className="font-display text-lg font-bold">Couldn't load analytics</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{error}</p>
            <button type="button" onClick={loadAnalytics} className="mt-5 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white">Try again</button>
          </div>
        </div>
      ) : data ? (
        <main className="space-y-5 px-5 py-5 lg:px-7 lg:py-6">
          {error && <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">{error}</div>}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricCard label="New Leads" value={data.summary.newLeads} delta={data.comparison.deltas.newLeads} detail="Started in selected period" />
            <MetricCard label="Appointments" value={data.summary.appointments} delta={data.comparison.deltas.appointments} detail="Cohort reached appointment" />
            <MetricCard label="Visited" value={data.summary.visits} delta={data.comparison.deltas.visits} detail="Cohort reached clinic visit" />
            <MetricCard label="Won" value={data.summary.won} delta={data.comparison.deltas.won} detail="Converted journeys" />
            <MetricCard label="Conversion" value={`${data.summary.conversionRate.toFixed(1)}%`} delta={data.comparison.deltas.conversionRate} deltaType="points" detail="Lead → Won" />
            <MetricCard label="Est. Won Value" value={money(data.summary.estimatedWonValue)} delta={data.comparison.deltas.estimatedWonValue} detail="Based on estimated lead value" />
          </section>

          <section className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
            <Panel title="Lead Funnel" subtitle="Leads that started during this period and the furthest milestones they eventually reached.">
              <FunnelChart stages={data.funnel} />
            </Panel>
            <Panel title="Cohort Trend" subtitle="Daily lead cohorts, with eventual appointment and win outcomes.">
              <TrendChart data={data.trend} dayCount={data.range.dayCount} />
            </Panel>
          </section>

          <section className="grid gap-5 xl:grid-cols-3">
            <Panel title="Lead Quality" subtitle="Current Hot / Warm / Cold status for leads in this period.">
              <TemperatureBreakdown rows={data.temperature} />
            </Panel>
            <ResponseCard title="Automated Response" stats={data.responseTimes.automated} description="First automated response after a customer waiting episode." />
            <ResponseCard title="Staff Response" stats={data.responseTimes.staff} description="First staff response after a customer waiting episode." />
          </section>

          <section className="grid gap-5 xl:grid-cols-3">
            <Panel title="Automated Follow-ups" subtitle="Recovery after scheduled follow-up messages.">
              <div className="grid grid-cols-2 gap-3">
                <SmallStat label="Sent" value={data.followUps.sent} />
                <SmallStat label="72h Reply Rate" value={`${data.followUps.replyRate72h.toFixed(1)}%`} />
                <SmallStat label="Appointments After" value={data.followUps.leadsWithAppointmentAfter} />
                <SmallStat label="Won After" value={data.followUps.leadsWonAfter} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">Reply rate counts a customer response within 72 hours of the automated follow-up. Appointment and win counts are unique leads that progressed after a follow-up.</p>
            </Panel>
            <Panel title="AI Lead Scoring" subtitle="Health of end-of-conversation lead scoring during this period.">
              <div className="grid grid-cols-2 gap-3">
                <SmallStat label="Completed" value={data.aiScoring.completed} />
                <SmallStat label="Completion Rate" value={`${data.aiScoring.completionRate.toFixed(1)}%`} />
                <SmallStat label="High Confidence" value={data.aiScoring.highConfidence} />
                <SmallStat label="Applied" value={`${data.aiScoring.appliedRate.toFixed(1)}%`} />
              </div>
            </Panel>
            <Panel title="Message Delivery" subtitle="Tracked WhatsApp outbound delivery results during this period.">
              <div className="grid grid-cols-2 gap-3">
                <SmallStat label="Tracked" value={data.deliveryHealth.tracked} />
                <SmallStat label="Failed" value={data.deliveryHealth.failed} tone={data.deliveryHealth.failed ? "danger" : "default"} />
              </div>
              <div className="mt-3 rounded-2xl bg-[var(--color-bg)] px-4 py-3">
                <p className="text-xs text-[var(--color-text-muted)]">Failure rate</p>
                <p className="mt-1 font-display text-2xl font-bold">{data.deliveryHealth.failureRate.toFixed(1)}%</p>
              </div>
            </Panel>
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <PerformanceTable title="Branch Performance" rows={data.performance.branches} />
            <PerformanceTable title="Treatment Performance" rows={data.performance.treatments} />
            <PerformanceTable title="Source Performance" rows={data.performance.sources} />
            <PerformanceTable title="Channel Performance" rows={data.performance.channels} formatLabel={formatChannel} />
            {data.performance.campaigns.length > 0 && <PerformanceTable title="Campaign Performance" rows={data.performance.campaigns} />}
            {data.performance.owners.some((row) => row.label !== "Unspecified") && <PerformanceTable title="Owner Performance" rows={data.performance.owners} />}
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <Panel title="Lost Reasons" subtitle="Why leads in this cohort were closed as lost.">
              <LostReasons rows={data.lostReasons} />
            </Panel>
            <Panel title="Value Snapshot" subtitle="Estimated values currently stored in the lead pipeline.">
              <div className="grid gap-3 sm:grid-cols-2">
                <SmallStat label="Estimated Won Value" value={money(data.summary.estimatedWonValue)} />
                <SmallStat label="Open Pipeline Value" value={money(data.summary.openPipelineValue)} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">These are estimated lead values, not confirmed revenue. Actual collected revenue is not stored in the current lead schema.</p>
            </Panel>
          </section>
        </main>
      ) : null}
    </div>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="min-w-36">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
      <input type="date" value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15" />
    </label>
  );
}

function FilterSelect({ label, value, onChange, options = [], format = (item) => item }) {
  return (
    <label className="min-w-36 max-w-56 flex-1 sm:flex-none">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15">
        <option value="all">All {label.toLowerCase()}s</option>
        {options.map((option) => <option key={option} value={option}>{format(option)}</option>)}
      </select>
    </label>
  );
}

function MetricCard({ label, value, delta, deltaType = "percent", detail }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-2 font-display text-2xl font-bold tracking-tight">{value}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
        <span className={`font-bold ${deltaTone(delta)}`}>{deltaLabel(delta, deltaType)}</span>
        <span className="text-[var(--color-text-muted)]">vs previous period</span>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{detail}</p>
    </div>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="rounded-3xl border border-[var(--color-border)] bg-white p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="font-display text-base font-bold">{title}</h2>
        {subtitle && <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function FunnelChart({ stages }) {
  const max = Math.max(1, stages[0]?.count || 0);
  return (
    <div className="space-y-3">
      {stages.map((stage, index) => {
        const width = Math.max(stage.count ? 18 : 6, (stage.count / max) * 100);
        return (
          <div key={stage.label}>
            <div className="mb-1.5 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-bold">{stage.label}</p>
                {index > 0 && <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{stage.fromPreviousRate.toFixed(1)}% from previous stage</p>}
              </div>
              <div className="text-right">
                <p className="font-display text-lg font-bold">{stage.count}</p>
                {index > 0 && <p className="text-[10px] text-[var(--color-primary)]">{stage.fromLeadRate.toFixed(1)}% of leads</p>}
              </div>
            </div>
            <div className="h-8 overflow-hidden rounded-xl bg-[var(--color-bg)]">
              <div className="flex h-full items-center rounded-xl bg-[var(--color-primary-light)] px-3 text-[10px] font-bold text-[var(--color-primary)] transition-[width]" style={{ width: `${width}%` }}>
                {stage.count ? compactNumber(stage.count) : "0"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrendChart({ data, dayCount }) {
  const width = 900;
  const height = 250;
  const padX = 30;
  const padTop = 20;
  const padBottom = 40;
  const maxValue = Math.max(1, ...data.flatMap((row) => [row.newLeads, row.appointments, row.won]));
  const x = (index) => data.length <= 1 ? width / 2 : padX + (index / (data.length - 1)) * (width - padX * 2);
  const y = (value) => padTop + (1 - value / maxValue) * (height - padTop - padBottom);
  const points = (key) => data.map((row, index) => `${x(index)},${y(row[key])}`).join(" ");
  const labelStep = Math.max(1, Math.ceil(data.length / 6));

  if (!data.length) return <EmptyState text="No lead activity in this period." />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-[11px] font-semibold">
        <LegendDot className="bg-[var(--color-primary)]" label="New leads" />
        <LegendDot className="bg-[var(--color-accent)]" label="Appointments" />
        <LegendDot className="bg-[#2f7d4e]" label="Won" />
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-64 min-w-[38rem] w-full" role="img" aria-label="Lead cohort trend">
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const lineY = padTop + ratio * (height - padTop - padBottom);
            return <line key={ratio} x1={padX} x2={width - padX} y1={lineY} y2={lineY} stroke="var(--color-border)" strokeWidth="1" />;
          })}
          <polyline points={points("newLeads")} fill="none" stroke="var(--color-primary)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={points("appointments")} fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={points("won")} fill="none" stroke="#2f7d4e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {data.map((row, index) => index % labelStep === 0 || index === data.length - 1 ? (
            <text key={row.day} x={x(index)} y={height - 12} textAnchor="middle" fontSize="11" fill="var(--color-text-muted)">{formatDay(row.day, dayCount)}</text>
          ) : null)}
        </svg>
      </div>
    </div>
  );
}

function LegendDot({ className, label }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${className}`} />{label}</span>;
}

function TemperatureBreakdown({ rows }) {
  const order = ["hot", "warm", "cold"];
  const byTemperature = Object.fromEntries(rows.map((row) => [row.temperature, row]));
  const tones = {
    hot: "bg-[var(--color-danger)]",
    warm: "bg-[var(--color-accent)]",
    cold: "bg-[#6a8293]",
  };
  const normalized = order.map((temperature) => byTemperature[temperature] || { temperature, leads: 0, share: 0, won: 0, conversionRate: 0 });
  const total = normalized.reduce((sum, row) => sum + row.leads, 0);

  if (!total) return <EmptyState text="No lead temperature data in this period." />;

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-[var(--color-bg)]">
        {normalized.map((row) => row.share > 0 ? <div key={row.temperature} className={tones[row.temperature]} style={{ width: `${row.share}%` }} /> : null)}
      </div>
      <div className="mt-4 space-y-3">
        {normalized.map((row) => (
          <div key={row.temperature} className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--color-bg)] px-3.5 py-3">
            <div className="flex items-center gap-2.5">
              <span className={`h-2.5 w-2.5 rounded-full ${tones[row.temperature]}`} />
              <div>
                <p className="text-xs font-bold capitalize">{row.temperature}</p>
                <p className="text-[10px] text-[var(--color-text-muted)]">{row.share.toFixed(1)}% of leads</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold">{row.leads}</p>
              <p className="text-[10px] text-[var(--color-primary)]">{row.conversionRate.toFixed(1)}% won</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResponseCard({ title, stats, description }) {
  return (
    <Panel title={title} subtitle={description}>
      <div className="grid grid-cols-2 gap-3">
        <SmallStat label="Median" value={formatDuration(stats.medianSeconds)} />
        <SmallStat label="90th Percentile" value={formatDuration(stats.p90Seconds)} />
      </div>
      <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">Based on {stats.samples} completed waiting episode{stats.samples === 1 ? "" : "s"}.</p>
    </Panel>
  );
}

function SmallStat({ label, value, tone = "default" }) {
  return (
    <div className={`rounded-2xl px-4 py-3 ${tone === "danger" ? "bg-[var(--color-danger-light)]" : "bg-[var(--color-bg)]"}`}>
      <p className="text-[10px] font-semibold text-[var(--color-text-muted)]">{label}</p>
      <p className={`mt-1 font-display text-xl font-bold ${tone === "danger" ? "text-[var(--color-danger)]" : ""}`}>{value}</p>
    </div>
  );
}

function PerformanceTable({ title, rows, formatLabel = (value) => value }) {
  return (
    <Panel title={title} subtitle="Cohort performance for the selected date range and filters.">
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                <th className="pb-2 pr-3 font-bold">{title.replace(" Performance", "")}</th>
                <th className="pb-2 px-2 text-right font-bold">Leads</th>
                <th className="pb-2 px-2 text-right font-bold">Appt</th>
                <th className="pb-2 px-2 text-right font-bold">Won</th>
                <th className="pb-2 px-2 text-right font-bold">Conv.</th>
                <th className="pb-2 pl-2 text-right font-bold">Est. value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-[var(--color-border)]/70 last:border-0">
                  <td className="py-3 pr-3 font-semibold">{formatLabel(row.label)}</td>
                  <td className="px-2 py-3 text-right">{row.leads}</td>
                  <td className="px-2 py-3 text-right">{row.appointments}</td>
                  <td className="px-2 py-3 text-right font-semibold">{row.won}</td>
                  <td className="px-2 py-3 text-right text-[var(--color-primary)]">{row.conversionRate.toFixed(1)}%</td>
                  <td className="py-3 pl-2 text-right">{money(row.estimatedWonValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState text="No data for this breakdown yet." />}
    </Panel>
  );
}

function LostReasons({ rows }) {
  if (!rows.length) return <EmptyState text="No lost leads in this cohort." />;
  const max = Math.max(...rows.map((row) => row.leads), 1);
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.reason}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold">{row.reason}</span>
            <span className="text-[var(--color-text-muted)]">{row.leads} · {row.share.toFixed(1)}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--color-bg)]">
            <div className="h-full rounded-full bg-[var(--color-danger)]/75" style={{ width: `${(row.leads / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">{text}</div>;
}

function formatChannel(value) {
  if (!value) return value;
  if (value === "whatsapp") return "WhatsApp";
  if (value === "instagram") return "Instagram";
  if (value === "facebook") return "Facebook";
  return value;
}
