import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Spinner from "../components/Spinner";

const TIME_ZONE = "Asia/Kuala_Lumpur";
const PRESET_OPTIONS = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["custom", "Custom range"],
];
const ADVANCED_FILTERS = ["source", "campaign", "treatment", "owner"];
const PERFORMANCE_TABS = [
  ["source", "Source"],
  ["campaign", "Campaign"],
  ["treatment", "Treatment"],
  ["branch", "Branch"],
  ["channel", "Channel"],
  ["owner", "Owner"],
];

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

function initialFilters() {
  return {
    ...rangeForDays(30),
    branch: "all",
    channel: "all",
    source: "all",
    campaign: "all",
    treatment: "all",
    owner: "all",
  };
}

function money(value) {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-MY", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
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

function formatDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-MY", { day: "numeric", month: "short" }).format(date);
}

function deltaLabel(delta, type = "percent") {
  if (delta == null) return "No baseline";
  const value = Number(delta) || 0;
  const sign = value > 0 ? "+" : "";
  return type === "points" ? `${sign}${value.toFixed(1)} pp` : `${sign}${value.toFixed(1)}%`;
}

function deltaTone(delta) {
  if (delta == null || Number(delta) === 0) return "text-[var(--color-text-muted)]";
  return Number(delta) > 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]";
}

function filtersEqual(left, right) {
  return ["from", "to", "branch", "channel", "source", "campaign", "treatment", "owner"]
    .every((key) => left[key] === right[key]);
}

export default function Analytics() {
  const navigate = useNavigate();
  const initial = useMemo(() => initialFilters(), []);
  const [draftFilters, setDraftFilters] = useState(initial);
  const [appliedFilters, setAppliedFilters] = useState(initial);
  const [preset, setPreset] = useState("30");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [performanceTab, setPerformanceTab] = useState("source");
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    api.getAnalytics(appliedFilters)
      .then((payload) => {
        if (requestId === requestIdRef.current) setData(payload);
      })
      .catch((err) => {
        console.error("Failed to load analytics:", err);
        if (requestId === requestIdRef.current) {
          setError(err.message || "Couldn't load analytics.");
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [appliedFilters, refreshToken]);

  function updateDraft(key, value) {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  }

  function applyPreset(value) {
    setPreset(value);
    if (value === "custom") return;
    const range = rangeForDays(Number(value));
    setDraftFilters((current) => ({ ...current, ...range }));
  }

  function applyFilters() {
    if (loading) return;
    setAppliedFilters({ ...draftFilters });
  }

  function clearFilters() {
    if (loading) return;
    const next = {
      ...draftFilters,
      branch: "all",
      channel: "all",
      source: "all",
      campaign: "all",
      treatment: "all",
      owner: "all",
    };
    setDraftFilters(next);
    setAppliedFilters(next);
    setShowMoreFilters(false);
  }

  function pipelineUrl(extra = {}) {
    const params = new URLSearchParams();
    params.set("from", appliedFilters.from);
    params.set("to", appliedFilters.to);
    for (const key of ["branch", "channel", "source", "campaign", "treatment", "owner"]) {
      const value = appliedFilters[key];
      if (value && value !== "all") params.set(key, value);
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value != null && value !== "" && value !== "all") params.set(key, String(value));
    }
    return `/pipeline?${params.toString()}`;
  }

  const filterOptions = data?.filterOptions || {};
  const activeFilterCount = ["branch", "channel", ...ADVANCED_FILTERS]
    .filter((key) => draftFilters[key] !== "all").length;
  const hasAdvancedFilters = ADVANCED_FILTERS.some((key) => draftFilters[key] !== "all");
  const hasPendingChanges = !filtersEqual(draftFilters, appliedFilters);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 sm:py-5 lg:px-7">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-xl font-bold">Analytics</h1>
              <span className="rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-primary)]">Sales</span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-text-muted)] sm:text-sm">
              Track lead quality, conversion, response speed and sales outcomes.
              <span className="hidden sm:inline"> See where enquiries drop off and which channels turn into clinic visits and wins.</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
            title="Refresh analytics"
            aria-label="Refresh analytics"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-white text-lg font-semibold text-[var(--color-text-muted)] shadow-sm transition hover:bg-[var(--color-bg)] disabled:opacity-50"
          >
            ↻
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-end">
          <div className="col-span-2 sm:col-span-1">
            <FilterSelect
              label="Date range"
              value={preset}
              onChange={applyPreset}
              options={PRESET_OPTIONS.map(([value, label]) => ({ value, label }))}
              includeAll={false}
              wide
            />
          </div>

          {preset === "custom" && (
            <>
              <DateField label="From" value={draftFilters.from} onChange={(value) => updateDraft("from", value)} />
              <DateField label="To" value={draftFilters.to} onChange={(value) => updateDraft("to", value)} />
            </>
          )}

          <FilterSelect label="Branch" value={draftFilters.branch} onChange={(value) => updateDraft("branch", value)} options={filterOptions.branches} />
          <FilterSelect label="Channel" value={draftFilters.channel} onChange={(value) => updateDraft("channel", value)} options={filterOptions.channels} format={formatChannel} />

          <button
            type="button"
            onClick={() => setShowMoreFilters((current) => !current)}
            aria-expanded={showMoreFilters}
            className={`h-11 rounded-xl border px-3.5 text-xs font-semibold transition ${showMoreFilters || hasAdvancedFilters ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}
          >
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </button>

          <button
            type="button"
            onClick={applyFilters}
            disabled={loading}
            className="h-11 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-bold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
          >
            {loading ? "Loading…" : hasPendingChanges ? "Apply filters" : "Apply"}
          </button>

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              disabled={loading}
              className="col-span-2 h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)] transition hover:bg-[var(--color-danger-light)] sm:col-span-1"
            >
              Clear filters
            </button>
          )}
        </div>

        {showMoreFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:flex sm:flex-wrap sm:items-end">
            <FilterSelect label="Source" value={draftFilters.source} onChange={(value) => updateDraft("source", value)} options={filterOptions.sources} />
            <FilterSelect label="Campaign" value={draftFilters.campaign} onChange={(value) => updateDraft("campaign", value)} options={filterOptions.campaigns} />
            <FilterSelect label="Treatment" value={draftFilters.treatment} onChange={(value) => updateDraft("treatment", value)} options={filterOptions.treatments} />
            <FilterSelect label="Owner" value={draftFilters.owner} onChange={(value) => updateDraft("owner", value)} options={filterOptions.owners} />
          </div>
        )}
      </header>

      {loading && !data ? (
        <div className="flex min-h-[28rem] items-center justify-center"><Spinner className="h-8 w-8 text-[var(--color-primary)]" /></div>
      ) : error && !data ? (
        <div className="mx-auto max-w-lg px-4 py-12 text-center sm:px-5 sm:py-16">
          <div className="rounded-3xl border border-[var(--color-border)] bg-white p-6 shadow-sm sm:p-8">
            <h2 className="font-display text-lg font-bold">Couldn't load analytics</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{error}</p>
            <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white">Try again</button>
          </div>
        </div>
      ) : data ? (
        <main className="space-y-4 px-3.5 py-4 sm:space-y-5 sm:px-5 sm:py-5 lg:px-7 lg:py-6">
          {error && <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">{error}</div>}

          <section className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-5">
            <MetricCard label="New Leads" value={data.summary.newLeads} delta={data.comparison.deltas.newLeads} detail="Lead journeys started in this period" />
            <MetricCard label="Appointments" value={data.summary.appointments} delta={data.comparison.deltas.appointments} detail="First appointment stage entered in this period" />
            <MetricCard label="Clinic Visits" value={data.summary.visits} delta={data.comparison.deltas.visits} detail="First visit stage entered in this period" />
            <MetricCard label="Won" value={data.summary.won} delta={data.comparison.deltas.won} detail={`Estimated value ${money(data.summary.estimatedWonValue)}`} />
            <MetricCard className="col-span-2 xl:col-span-1" label="Cohort Conversion" value={`${data.summary.conversionRate.toFixed(1)}%`} delta={data.comparison.deltas.conversionRate} deltaType="points" detail="Leads started in period → Won" />
          </section>

          <RateStrip cohort={data.cohort} />

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-[0.85fr_1.15fr]">
            <Panel title="Conversion Funnel" subtitle="How the selected lead cohort progresses through the sales journey.">
              <FunnelChart stages={data.funnel} />
            </Panel>
            <Panel title="Activity Over Time" subtitle="Daily activity based on when each event actually happened.">
              <ActivityTrendChart data={data.trend} />
            </Panel>
          </section>

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-2">
            <Panel title="Lead Quality" subtitle="Current Hot / Warm / Cold status for leads that started in this period.">
              <TemperatureBreakdown rows={data.temperature} onViewHot={() => navigate(pipelineUrl({ category: "hot" }))} />
            </Panel>
            <Panel title="Response Performance" subtitle="How quickly completed customer waiting episodes received a reply.">
              <ResponsePerformance stats={data.responseTimes} />
            </Panel>
          </section>

          <Panel title="Performance Breakdown" subtitle="Compare this lead cohort by acquisition, treatment, location, channel or owner.">
            <PerformanceBreakdown
              performance={data.performance}
              activeTab={performanceTab}
              onTabChange={setPerformanceTab}
              onOpen={(dimension, label) => navigate(pipelineUrl({ [dimension]: label }))}
            />
          </Panel>

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-2">
            <Panel title="Follow-up Performance" subtitle="Outcomes associated with scheduled automated follow-up messages.">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
                <SmallStat label="Leads Followed Up" value={data.followUps.leadsFollowedUp} />
                <SmallStat label="Replied Within 72h" value={data.followUps.leadsReplied72h} />
                <SmallStat label="Reply Rate" value={`${data.followUps.replyRate72h.toFixed(1)}%`} />
                <SmallStat label={`Appointments Within ${data.followUps.outcomeWindowDays}d`} value={data.followUps.leadsWithAppointmentAfter} />
                <SmallStat label={`Wins Within ${data.followUps.outcomeWindowDays}d`} value={data.followUps.leadsWonAfter} />
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)] sm:text-[11px]">Appointment and win outcomes are counted only when they happen in the same journey within {data.followUps.outcomeWindowDays} days after a follow-up. This shows association, not guaranteed causation.</p>
            </Panel>
            <Panel title="Lost Reasons" subtitle="Why leads in this cohort were closed as lost.">
              <LostReasons rows={data.lostReasons} />
            </Panel>
          </section>

          <SystemStatus health={data.systemHealth} />
        </main>
      ) : null}
    </div>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="min-w-0 sm:min-w-36">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
      <input type="date" value={value} onChange={(event) => onChange(event.target.value)} className="h-11 w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15" />
    </label>
  );
}

function FilterSelect({ label, value, onChange, options = [], format = (item) => item, includeAll = true, wide = false }) {
  const normalizedOptions = options.map((option) => typeof option === "string" ? { value: option, label: format(option) } : option);
  return (
    <label className={`min-w-0 sm:min-w-36 ${wide ? "sm:min-w-44" : ""} sm:max-w-56 sm:flex-1`}>
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-11 w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15">
        {includeAll && <option value="all">All</option>}
        {normalizedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function MetricCard({ label, value, delta, deltaType = "percent", detail, className = "" }) {
  return (
    <div className={`rounded-2xl border border-[var(--color-border)] bg-white p-3.5 shadow-sm sm:p-4 ${className}`}>
      <p className="text-[11px] font-semibold leading-tight text-[var(--color-text-muted)] sm:text-xs">{label}</p>
      <p className="mt-1.5 font-display text-2xl font-bold tracking-tight sm:mt-2">{value}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] sm:mt-2">
        <span className={`font-bold ${deltaTone(delta)}`}>{deltaLabel(delta, deltaType)}</span>
        <span className="text-[var(--color-text-muted)]">vs prior</span>
      </div>
      <p className="mt-2 hidden text-[10px] leading-relaxed text-[var(--color-text-muted)] sm:block">{detail}</p>
    </div>
  );
}

function RateStrip({ cohort }) {
  const rates = [
    ["Appointment", cohort.appointmentRate, "Lead → Appt"],
    ["Show", cohort.showRate, "Appt → Visit"],
    ["Close", cohort.closeRate, "Visit → Won"],
  ];
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-white p-2.5 shadow-sm sm:px-4 sm:py-3">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {rates.map(([label, value, detail]) => (
          <div key={label} className="rounded-xl bg-[var(--color-bg)] px-2.5 py-3 text-center sm:flex sm:items-end sm:justify-between sm:gap-3 sm:px-4 sm:text-left">
            <div className="min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] sm:text-[10px]">{label}</p>
              <p className="mt-0.5 hidden text-[10px] text-[var(--color-text-muted)] sm:block">{detail}</p>
            </div>
            <p className="mt-1 font-display text-lg font-bold sm:mt-0 sm:text-xl">{value.toFixed(1)}%</p>
          </div>
        ))}
      </div>
      <p className="mt-2 hidden text-[10px] text-[var(--color-text-muted)] sm:block">Rates use leads that started in the selected period, so they describe cohort conversion quality rather than raw event volume.</p>
    </section>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:rounded-3xl sm:p-5">
      <div className="mb-3 sm:mb-4">
        <h2 className="font-display text-[15px] font-bold sm:text-base">{title}</h2>
        {subtitle && <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)] sm:text-xs">{subtitle}</p>}
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
              <div className="min-w-0">
                <p className="truncate text-xs font-bold">{stage.label}</p>
                {index > 0 && (
                  <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)] sm:text-[10px]">
                    {stage.fromPreviousRate.toFixed(1)}% reached · {stage.dropOff} drop-off
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-lg font-bold">{stage.count}</p>
                {index > 0 && <p className="text-[9px] text-[var(--color-primary)] sm:text-[10px]">{stage.fromLeadRate.toFixed(1)}% of leads</p>}
              </div>
            </div>
            <div className="h-7 overflow-hidden rounded-xl bg-[var(--color-bg)] sm:h-8">
              <div className="flex h-full items-center rounded-xl bg-[var(--color-primary-light)] px-2.5 text-[10px] font-bold text-[var(--color-primary)] transition-[width] sm:px-3" style={{ width: `${width}%` }}>
                {stage.count ? compactNumber(stage.count) : "0"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityTrendChart({ data }) {
  const metrics = {
    newLeads: { label: "New leads", stroke: "var(--color-primary)" },
    appointments: { label: "Appointments", stroke: "var(--color-accent)" },
    visits: { label: "Visits", stroke: "#6a8293" },
    won: { label: "Won", stroke: "#2f7d4e" },
  };
  const [metric, setMetric] = useState("newLeads");
  const width = 640;
  const height = 220;
  const padX = 28;
  const padTop = 18;
  const padBottom = 36;

  if (!data.length) return <EmptyState text="No activity in this period." />;

  const maxValue = Math.max(1, ...data.map((row) => row[metric]));
  const x = (index) => data.length <= 1 ? width / 2 : padX + (index / (data.length - 1)) * (width - padX * 2);
  const y = (value) => padTop + (1 - value / maxValue) * (height - padTop - padBottom);
  const points = data.map((row, index) => `${x(index)},${y(row[metric])}`).join(" ");
  const labelStep = Math.max(1, Math.ceil(data.length / 4));

  return (
    <div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {Object.entries(metrics).map(([key, item]) => (
          <button key={key} type="button" onClick={() => setMetric(key)} className={`h-9 shrink-0 rounded-lg px-2.5 text-[10px] font-bold transition ${metric === key ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{item.label}</button>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="h-auto w-full" role="img" aria-label={`${metrics[metric].label} over time`}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = padTop + ratio * (height - padTop - padBottom);
          return <line key={ratio} x1={padX} x2={width - padX} y1={lineY} y2={lineY} stroke="var(--color-border)" strokeWidth="1" />;
        })}
        <polyline points={points} fill="none" stroke={metrics[metric].stroke} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((row, index) => (
          <circle key={`point-${row.day}`} cx={x(index)} cy={y(row[metric])} r="3" fill={metrics[metric].stroke} />
        ))}
        {data.map((row, index) => index % labelStep === 0 || index === data.length - 1 ? (
          <text key={row.day} x={x(index)} y={height - 10} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">{formatDay(row.day)}</text>
        ) : null)}
      </svg>
    </div>
  );
}

function TemperatureBreakdown({ rows, onViewHot }) {
  const order = ["hot", "warm", "cold"];
  const byTemperature = Object.fromEntries(rows.map((row) => [row.temperature, row]));
  const tones = {
    hot: "bg-[var(--color-danger)]",
    warm: "bg-[var(--color-accent)]",
    cold: "bg-[#6a8293]",
  };
  const normalized = order.map((temperature) => byTemperature[temperature] || { temperature, leads: 0, share: 0, won: 0, openLeads: 0, conversionRate: 0 });
  const total = normalized.reduce((sum, row) => sum + row.leads, 0);
  const hotOpen = normalized.find((row) => row.temperature === "hot")?.openLeads || 0;

  if (!total) return <EmptyState text="No lead temperature data in this period." />;

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-[var(--color-bg)]">
        {normalized.map((row) => row.share > 0 ? <div key={row.temperature} className={tones[row.temperature]} style={{ width: `${row.share}%` }} /> : null)}
      </div>
      <div className="mt-4 space-y-2.5">
        {normalized.map((row) => (
          <div key={row.temperature} className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--color-bg)] px-3 py-3 sm:px-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tones[row.temperature]}`} />
              <div className="min-w-0">
                <p className="text-xs font-bold capitalize">{row.temperature}</p>
                <p className="truncate text-[10px] text-[var(--color-text-muted)]">{row.share.toFixed(1)}% of cohort · {row.openLeads} open</p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-bold">{row.leads}</p>
              <p className="text-[10px] text-[var(--color-primary)]">{row.conversionRate.toFixed(1)}% won</p>
            </div>
          </div>
        ))}
      </div>
      {hotOpen > 0 && (
        <button type="button" onClick={onViewHot} className="mt-3 min-h-11 w-full rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-3 py-2.5 text-xs font-bold text-[var(--color-danger)] transition hover:border-[var(--color-danger)]/40">
          View {hotOpen} open hot lead{hotOpen === 1 ? "" : "s"} →
        </button>
      )}
    </div>
  );
}

function ResponsePerformance({ stats }) {
  const rows = [
    ["Automated", stats.automated],
    ["Human", stats.staff],
  ];
  return (
    <div>
      <div className="grid gap-2.5 sm:hidden">
        {rows.map(([label, row]) => {
          const hasSamples = row.samples > 0;
          return (
            <div key={label} className="rounded-2xl bg-[var(--color-bg)] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold">{label}</p>
                <span className="text-[10px] text-[var(--color-text-muted)]">{row.samples} episode{row.samples === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Typical</p>
                  <p className="mt-1 font-display text-lg font-bold">{hasSamples ? formatDuration(row.medianSeconds) : "—"}</p>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">90% within</p>
                  <p className="mt-1 font-display text-lg font-bold">{hasSamples ? formatDuration(row.p90Seconds) : "—"}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden sm:block">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <th className="pb-2 font-bold">Responder</th>
              <th className="px-2 pb-2 text-right font-bold">Typical</th>
              <th className="px-2 pb-2 text-right font-bold">90% within</th>
              <th className="pb-2 pl-2 text-right font-bold">Episodes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, row]) => {
              const hasSamples = row.samples > 0;
              return (
                <tr key={label} className="border-b border-[var(--color-border)]/70 last:border-0">
                  <td className="py-4 font-semibold">{label}</td>
                  <td className="px-2 py-4 text-right font-display text-base font-bold">{hasSamples ? formatDuration(row.medianSeconds) : "—"}</td>
                  <td className="px-2 py-4 text-right">{hasSamples ? formatDuration(row.p90Seconds) : "—"}</td>
                  <td className="py-4 pl-2 text-right text-[var(--color-text-muted)]">{row.samples}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)] sm:text-[11px]">“Typical” is the median wait. “90% within” means nine out of ten measured replies were at or below that time.</p>
    </div>
  );
}

function PerformanceBreakdown({ performance, activeTab, onTabChange, onOpen }) {
  const availableTabs = PERFORMANCE_TABS.filter(([key]) => key === "source" || (performance[key] || []).length > 0);
  const safeTab = availableTabs.some(([key]) => key === activeTab) ? activeTab : availableTabs[0]?.[0] || "source";
  const rows = performance[safeTab] || [];
  const title = PERFORMANCE_TABS.find(([key]) => key === safeTab)?.[1] || "Source";
  return (
    <div>
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
        {availableTabs.map(([key, label]) => (
          <button key={key} type="button" onClick={() => onTabChange(key)} className={`h-10 shrink-0 whitespace-nowrap rounded-xl px-3 text-xs font-semibold transition ${safeTab === key ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{label}</button>
        ))}
      </div>

      {rows.length ? (
        <>
          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => {
              const canOpen = row.label !== "Unspecified";
              const displayLabel = safeTab === "channel" ? formatChannel(row.label) : row.label;
              return (
                <button
                  key={row.label}
                  type="button"
                  disabled={!canOpen}
                  onClick={canOpen ? () => onOpen(safeTab, row.label) : undefined}
                  className={`w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5 text-left ${canOpen ? "active:scale-[0.99]" : "cursor-default"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold">{displayLabel}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{row.leads} lead{row.leads === 1 ? "" : "s"}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-display text-lg font-bold text-[var(--color-primary)]">{row.conversionRate.toFixed(1)}%</p>
                      <p className="text-[9px] text-[var(--color-text-muted)]">conversion {canOpen ? "→" : ""}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-border)]/70 pt-3 text-center">
                    <MiniValue label="Appt" value={row.appointments} />
                    <MiniValue label="Visits" value={row.visits} />
                    <MiniValue label="Won" value={row.won} />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[38rem] text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  <th className="pb-2 pr-3 font-bold">{title}</th>
                  <th className="px-2 pb-2 text-right font-bold">Leads</th>
                  <th className="px-2 pb-2 text-right font-bold">Appt</th>
                  <th className="px-2 pb-2 text-right font-bold">Visits</th>
                  <th className="px-2 pb-2 text-right font-bold">Won</th>
                  <th className="pb-2 pl-2 text-right font-bold">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const canOpen = row.label !== "Unspecified";
                  return (
                    <tr key={row.label} onClick={canOpen ? () => onOpen(safeTab, row.label) : undefined} className={`border-b border-[var(--color-border)]/70 last:border-0 ${canOpen ? "cursor-pointer hover:bg-[var(--color-bg)]" : ""}`}>
                      <td className="py-3 pr-3 font-semibold">{safeTab === "channel" ? formatChannel(row.label) : row.label}{canOpen && <span className="ml-1.5 text-[var(--color-primary)]">→</span>}</td>
                      <td className="px-2 py-3 text-right">{row.leads}</td>
                      <td className="px-2 py-3 text-right">{row.appointments}</td>
                      <td className="px-2 py-3 text-right">{row.visits}</td>
                      <td className="px-2 py-3 text-right font-semibold">{row.won}</td>
                      <td className="py-3 pl-2 text-right text-[var(--color-primary)]">{row.conversionRate.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : <EmptyState text={`No ${title.toLowerCase()} data for this cohort yet.`} />}
    </div>
  );
}

function MiniValue({ label, value }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-0.5 text-sm font-bold">{value}</p>
    </div>
  );
}

function SmallStat({ label, value }) {
  return (
    <div className="rounded-2xl bg-[var(--color-bg)] px-3 py-3 sm:px-4">
      <p className="text-[9px] font-semibold leading-snug text-[var(--color-text-muted)] sm:text-[10px]">{label}</p>
      <p className="mt-1 font-display text-lg font-bold sm:text-xl">{value}</p>
    </div>
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
            <span className="min-w-0 truncate font-semibold">{row.reason}</span>
            <span className="shrink-0 text-[var(--color-text-muted)]">{row.leads} · {row.share.toFixed(1)}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--color-bg)]">
            <div className="h-full rounded-full bg-[var(--color-danger)]/75" style={{ width: `${(row.leads / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SystemStatus({ health }) {
  const scoring = health.aiScoring;
  const delivery = health.delivery;
  const scoringState = scoring.attempts === 0 ? "neutral" : scoring.failed > 0 ? "issue" : "healthy";
  const deliveryState = delivery.tracked === 0 ? "neutral" : delivery.failed > 0 ? "issue" : "healthy";
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-white px-3.5 py-3 shadow-sm sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:px-4">
      <span className="mb-2 block font-display text-xs font-bold sm:mb-0 sm:mr-1">System status</span>
      <div className="flex flex-wrap gap-2">
        <StatusChip
          state={deliveryState}
          text={delivery.tracked === 0 ? "Delivery: no tracked messages" : delivery.failed > 0 ? `${delivery.failed} delivery failure${delivery.failed === 1 ? "" : "s"} (${delivery.failureRate.toFixed(1)}%)` : "Messaging healthy"}
        />
        <StatusChip
          state={scoringState}
          text={scoring.attempts === 0 ? "AI scoring: no attempts" : scoring.failed > 0 ? `${scoring.failed} AI scoring failure${scoring.failed === 1 ? "" : "s"}` : "AI scoring healthy"}
        />
      </div>
    </section>
  );
}

function StatusChip({ state, text }) {
  const tone = state === "issue"
    ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]"
    : state === "healthy"
      ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      : "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  const icon = state === "issue" ? "⚠" : state === "healthy" ? "✓" : "•";
  return <span className={`rounded-full px-2.5 py-1.5 text-[10px] font-semibold sm:text-xs ${tone}`}>{icon} {text}</span>;
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
