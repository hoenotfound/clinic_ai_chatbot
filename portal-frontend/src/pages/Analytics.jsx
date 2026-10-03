import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useBusinessConfig } from "../context/BusinessConfigContext";
import { getBusinessTerminology } from "../utils/businessTerminology";
import Spinner from "../components/Spinner";
import MetaAdsAnalyticsView from "../components/analytics/MetaAdsAnalyticsView";

const TIME_ZONE = "Asia/Kuala_Lumpur";
const PRESET_OPTIONS = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["custom", "Custom range"],
];
const ADVANCED_FILTERS = ["source", "campaign", "treatment", "owner"];
const SOURCE_LABELS = {
  meta_ads: "Meta Ads",
  meta_post: "Meta post",
  facebook_referral: "Facebook referral",
  instagram_referral: "Instagram referral",
  facebook_comment: "Facebook Comment",
  instagram_comment: "Instagram Comment",
  facebook_organic: "Facebook organic / untracked",
  instagram_organic: "Instagram organic / untracked",
  whatsapp_unattributed: "WhatsApp direct / untracked",
};

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

function buildPerformanceTabs(analyticsUi) {
  return [
    ["source", "Source"],
    ["campaign", "Campaign"],
    ["treatment", analyticsUi.performanceTabs.treatment],
    ["branch", analyticsUi.performanceTabs.branch],
    ["channel", "Channel"],
    ["owner", "Owner"],
  ];
}

export default function Analytics() {
  const navigate = useNavigate();
  const { config } = useBusinessConfig();
  const initial = useMemo(() => initialFilters(), []);
  const [draftFilters, setDraftFilters] = useState(initial);
  const [appliedFilters, setAppliedFilters] = useState(initial);
  const [preset, setPreset] = useState("30");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [appliedPreset, setAppliedPreset] = useState("30");
  const [performanceTab, setPerformanceTab] = useState("source");
  const [analyticsView, setAnalyticsView] = useState("crm");
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterActionPending, setFilterActionPending] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);
  const effectiveAnalyticsConfig = data?.analyticsBusinessType
    ? { ...(config || {}), businessType: data.analyticsBusinessType }
    : (config || {});
  const analyticsUi = getBusinessTerminology(effectiveAnalyticsConfig).analytics;
  const performanceTabs = buildPerformanceTabs(analyticsUi);

  useEffect(() => {
    if (analyticsView !== "crm") {
      setLoading(false);
      return undefined;
    }
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
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setFilterActionPending(false);
        }
      });
  }, [analyticsView, appliedFilters, refreshToken]);

  if (analyticsView === "meta_ads") {
    return <MetaAdsAnalyticsView onSwitchToCrm={() => setAnalyticsView("crm")} />;
  }

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
    setFilterActionPending(true);
    setAppliedPreset(preset);
    setAppliedFilters({ ...draftFilters });
    setMobileFiltersOpen(false);
    setShowMoreFilters(false);
  }

  function clearFilters() {
    if (loading) return;
    setFilterActionPending(true);
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
    setMobileFiltersOpen(false);
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
  const activeAdvancedFilterCount = ADVANCED_FILTERS
    .filter((key) => draftFilters[key] !== "all").length;
  const hasAdvancedFilters = activeAdvancedFilterCount > 0;
  const hasPendingChanges = !filtersEqual(draftFilters, appliedFilters);
  const appliedAdvancedFilterCount = ADVANCED_FILTERS
    .filter((key) => appliedFilters[key] !== "all").length;
  const appliedPresetLabel = PRESET_OPTIONS.find(([value]) => value === appliedPreset)?.[1] || "Custom range";
  const allLocationsLabel = analyticsUi.locationFilterLabel === "Branch" ? "All branches" : "All locations";
  const appliedLocationLabel = appliedFilters.branch === "all" ? allLocationsLabel : appliedFilters.branch;
  const appliedChannelLabel = appliedFilters.channel === "all" ? "All channels" : formatChannel(appliedFilters.channel);
  const mobileFilterSummary = [
    appliedPresetLabel,
    appliedLocationLabel,
    appliedChannelLabel,
    appliedAdvancedFilterCount ? `${appliedAdvancedFilterCount} more` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div data-testid="analytics-scroll" className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="min-w-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3.5 sm:px-5 sm:py-5 lg:px-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold sm:text-[22px]">Analytics</h1>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--color-text-muted)] sm:text-sm">
              <span className="sm:hidden">Track leads, conversion and sales outcomes.</span>
              <span className="hidden sm:inline">
                Track lead quality, conversion, response speed and sales outcomes. {analyticsUi.descriptionSuffix}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
            title="Refresh analytics"
            aria-label="Refresh analytics"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-white text-[var(--color-text-muted)] transition hover:bg-[var(--color-bg)] disabled:opacity-50"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
          <button
            type="button"
            className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-[var(--color-text)]"
          >
            CRM Analytics
          </button>
          <button
            type="button"
            onClick={() => setAnalyticsView("meta_ads")}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
          >
            Meta Ads
          </button>
        </div>

        <button
          type="button"
          aria-label="Toggle analytics filters"
          aria-expanded={mobileFiltersOpen}
          onClick={() => setMobileFiltersOpen((current) => !current)}
          className="mt-3 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-left sm:hidden"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--color-text)]">Filters</span>
              {hasPendingChanges && !filterActionPending && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)]">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                  Unsaved
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
              {filterActionPending ? "Updating analytics…" : mobileFilterSummary}
            </span>
          </span>
          <ChevronIcon className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${mobileFiltersOpen ? "rotate-180" : ""}`} />
        </button>

        <div className={`${mobileFiltersOpen ? "flex" : "hidden"} mt-2.5 min-w-0 flex-col gap-2.5 sm:mt-4 sm:flex sm:gap-3 xl:flex-row xl:items-end xl:justify-between`}>
          <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-1 sm:flex-wrap sm:items-end">
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

            <FilterSelect label={analyticsUi.locationFilterLabel} value={draftFilters.branch} onChange={(value) => updateDraft("branch", value)} options={filterOptions.branches} />
            <FilterSelect label="Channel" value={draftFilters.channel} onChange={(value) => updateDraft("channel", value)} options={filterOptions.channels} format={formatChannel} />

            <button
              type="button"
              onClick={() => setShowMoreFilters((current) => !current)}
              aria-expanded={showMoreFilters}
              className={`col-span-2 flex h-10 w-full items-center justify-between rounded-xl border px-3.5 text-xs font-semibold transition sm:col-span-1 sm:h-11 sm:w-auto ${showMoreFilters || hasAdvancedFilters ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}
            >
              <span>{showMoreFilters ? "Hide filters" : "More filters"}{activeAdvancedFilterCount ? ` (${activeAdvancedFilterCount})` : ""}</span>
              <ChevronIcon className={`h-4 w-4 shrink-0 transition-transform sm:ml-2 ${showMoreFilters ? "rotate-180" : ""}`} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:items-center">
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                disabled={loading}
                className="col-span-2 h-10 rounded-xl px-3.5 text-xs font-semibold text-[var(--color-danger)] transition hover:bg-[var(--color-danger-light)] disabled:opacity-50 sm:col-span-1 sm:h-11"
              >
                Clear filters
              </button>
            )}

            <button
              type="button"
              onClick={applyFilters}
              disabled={loading || !hasPendingChanges}
              className={`${hasPendingChanges || filterActionPending ? "inline-flex" : "hidden sm:inline-flex"} col-span-2 h-10 w-full items-center justify-center rounded-xl bg-[var(--color-primary)] px-4 text-xs font-bold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-45 sm:col-span-1 sm:h-11 sm:w-auto`}
            >
              {filterActionPending ? "Loading…" : "Apply filters"}
            </button>
          </div>
        </div>

        {showMoreFilters && (
          <div className={`${mobileFiltersOpen ? "grid" : "hidden"} mt-3 grid-cols-2 gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:flex sm:flex-wrap sm:items-end`}>
            <FilterSelect label="Source" value={draftFilters.source} onChange={(value) => updateDraft("source", value)} options={filterOptions.sources} format={formatSource} />
            <FilterSelect label="Campaign" value={draftFilters.campaign} onChange={(value) => updateDraft("campaign", value)} options={filterOptions.campaigns} />
            <FilterSelect label={analyticsUi.serviceFilterLabel} value={draftFilters.treatment} onChange={(value) => updateDraft("treatment", value)} options={filterOptions.treatments} />
            <FilterSelect label="Owner" value={draftFilters.owner} onChange={(value) => updateDraft("owner", value)} options={filterOptions.owners} />
          </div>
        )}
      </header>

      {loading && !data ? (
        <div className="flex min-h-[28rem] items-center justify-center"><Spinner className="h-8 w-8 text-[var(--color-primary)]" /></div>
      ) : error && !data ? (
        <div className="mx-auto max-w-lg px-4 py-12 text-center sm:px-5 sm:py-16">
          <div className="rounded-xl border border-[var(--color-border)] bg-white p-6 sm:p-8">
            <h2 className="font-display text-lg font-bold">Couldn't load analytics</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{error}</p>
            <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white">Try again</button>
          </div>
        </div>
      ) : data ? (
        <main className="min-w-0 space-y-3.5 px-3.5 py-3.5 sm:space-y-5 sm:px-5 sm:py-5 lg:px-7 lg:py-6">
          {error && <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">{error}</div>}

          <section className="grid min-w-0 grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            <MetricCard label="New leads" value={data.summary.newLeads} delta={data.comparison.deltas.newLeads} detail="Lead journeys started in this period" />
            <MetricCard label={analyticsUi.primaryMetricLabel} value={data.summary.appointments} delta={data.comparison.deltas.appointments} detail={analyticsUi.primaryMetricDetail} />
            <MetricCard label={analyticsUi.secondaryMetricLabel} value={data.summary.visits} delta={data.comparison.deltas.visits} detail={analyticsUi.secondaryMetricDetail} />
            <MetricCard label="Won" value={data.summary.won} delta={data.comparison.deltas.won} detail={`Estimated value ${money(data.summary.estimatedWonValue)}`} />
          </section>

          <ConversionSummary
            conversionRate={data.summary.conversionRate}
            conversionDelta={data.comparison.deltas.conversionRate}
            cohort={data.cohort}
            labels={analyticsUi.rates}
          />

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-[0.85fr_1.15fr]">
            <Panel title="Conversion Funnel" subtitle="How the selected lead cohort progresses through the sales journey.">
              <FunnelChart stages={data.funnel} />
            </Panel>
            <Panel title="Activity Over Time" subtitle="Daily activity based on when each event actually happened.">
              <ActivityTrendChart data={data.trend} labels={analyticsUi} />
            </Panel>
          </section>

          <Panel title="Performance Breakdown" subtitle={analyticsUi.performanceSubtitle}>
            <PerformanceBreakdown
              performance={data.performance}
              tabs={performanceTabs}
              primaryLabel={analyticsUi.primaryTableLabel}
              secondaryLabel={analyticsUi.secondaryTableLabel}
              activeTab={performanceTab}
              onTabChange={setPerformanceTab}
              onOpen={(dimension, label) => navigate(pipelineUrl({ [dimension]: label }))}
            />
          </Panel>

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-2">
            <Panel title="Lead Quality" subtitle="Current Hot / Warm / Cold status for leads that started in this period.">
              <TemperatureBreakdown rows={data.temperature} onViewHot={() => navigate(pipelineUrl({ category: "hot" }))} />
            </Panel>
            <Panel title="Response Performance" subtitle="How quickly completed customer waiting episodes received a reply.">
              <ResponsePerformance stats={data.responseTimes} />
            </Panel>
          </section>

          <section className="grid gap-4 sm:gap-5 xl:grid-cols-2">
            <Panel title="Follow-up Performance" subtitle="Outcomes associated with scheduled automated follow-up messages.">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
                <SmallStat label="Leads Followed Up" value={data.followUps.leadsFollowedUp} />
                <SmallStat label="Replied Within 72h" value={data.followUps.leadsReplied72h} />
                <SmallStat label="Reply Rate" value={`${data.followUps.replyRate72h.toFixed(1)}%`} />
                <SmallStat label={`${analyticsUi.followUpPrimaryLabel} Within ${data.followUps.outcomeWindowDays}d`} value={data.followUps.leadsWithAppointmentAfter} />
                <SmallStat label={`Wins Within ${data.followUps.outcomeWindowDays}d`} value={data.followUps.leadsWonAfter} />
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{analyticsUi.followUpOutcomeNoun} and win outcomes are counted only when they happen in the same journey within {data.followUps.outcomeWindowDays} days after a follow-up. This shows association, not guaranteed causation.</p>
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
      <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      <input type="date" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm sm:h-11 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15" />
    </label>
  );
}

function FilterSelect({ label, value, onChange, options = [], format = (item) => item, includeAll = true, wide = false }) {
  const normalizedOptions = options.map((option) => typeof option === "string" ? { value: option, label: format(option) } : option);
  return (
    <label className={`min-w-0 sm:min-w-36 ${wide ? "sm:min-w-44" : ""} sm:max-w-56 sm:flex-1`}>
      <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15 sm:h-11">
        {includeAll && <option value="all">All</option>}
        {normalizedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function MetricCard({ label, value, delta, deltaType = "percent", detail, className = "" }) {
  return (
    <div className={`min-w-0 rounded-xl border border-[var(--color-border)] bg-white p-3 sm:p-4 ${className}`}>
      <p className="text-xs font-semibold leading-tight text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1.5 font-display text-2xl font-bold tracking-tight sm:mt-2">{value}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs sm:mt-2">
        <span className={`font-bold ${deltaTone(delta)}`}>{deltaLabel(delta, deltaType)}</span>
        <span className="text-[var(--color-text-muted)]">vs prior</span>
      </div>
      <p className="mt-2 hidden text-xs leading-5 text-[var(--color-text-muted)] sm:block">{detail}</p>
    </div>
  );
}

function ConversionSummary({ conversionRate, conversionDelta, cohort, labels }) {
  const rates = [
    [labels[0]?.detail || labels[0]?.label || "Lead → next step", cohort.appointmentRate],
    [labels[1]?.detail || labels[1]?.label || "Next step → outcome", cohort.showRate],
    [labels[2]?.detail || labels[2]?.label || "Outcome → won", cohort.closeRate],
  ];

  return (
    <section className="min-w-0 border-y border-[var(--color-border)] py-3">
      <div className="sm:hidden">
        <p className="text-xs font-semibold text-[var(--color-text-muted)]">Overall conversion</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-display text-2xl font-bold">{conversionRate.toFixed(1)}%</span>
          <span className={`text-xs font-semibold ${deltaTone(conversionDelta)}`}>{deltaLabel(conversionDelta, "points")} vs prior</span>
        </div>
        <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
          {rates.map(([definition, value]) => (
            <div key={definition} className="min-w-0 border-l border-[var(--color-border)] pl-2 first:border-l-0 first:pl-0">
              <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">{definition}</p>
              <p className="mt-0.5 font-display text-sm font-bold">{value.toFixed(1)}%</p>
            </div>
          ))}
        </div>
      </div>

      <div className="hidden sm:flex sm:items-center sm:justify-between sm:gap-5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xs font-semibold text-[var(--color-text-muted)]">Overall lead → won conversion</span>
          <span className="font-display text-xl font-bold">{conversionRate.toFixed(1)}%</span>
          <span className={`text-xs font-semibold ${deltaTone(conversionDelta)}`}>{deltaLabel(conversionDelta, "points")} vs prior</span>
        </div>
        <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs">
          {rates.map(([definition, value]) => (
            <span key={definition} className="text-[var(--color-text-muted)]">
              {definition} <strong className="font-semibold text-[var(--color-text)]">{value.toFixed(1)}%</strong>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="mb-3 sm:mb-4">
        <h2 className="font-display text-[15px] font-bold sm:text-base">{title}</h2>
        {subtitle && <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{subtitle}</p>}
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
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {stage.fromPreviousRate.toFixed(1)}% reached · {stage.dropOff} drop-off
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-lg font-bold">{stage.count}</p>
                {index > 0 && <p className="text-xs text-[var(--color-primary)]">{stage.fromLeadRate.toFixed(1)}% of leads</p>}
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

function ActivityTrendChart({ data, labels }) {
  const metrics = {
    newLeads: { label: "New leads", stroke: "var(--color-primary)" },
    appointments: { label: labels.primaryTrendLabel, stroke: "var(--color-accent)" },
    visits: { label: labels.secondaryTrendLabel, stroke: "#6a8293" },
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
      <div className="mb-3 flex gap-1.5 ui-scroll-x overflow-x-auto pb-1">
        {Object.entries(metrics).map(([key, item]) => (
          <button key={key} type="button" onClick={() => setMetric(key)} className={`h-10 shrink-0 rounded-lg px-2.5 text-xs font-semibold transition ${metric === key ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{item.label}</button>
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
                <p className="truncate text-xs text-[var(--color-text-muted)]">{row.share.toFixed(1)}% of cohort · {row.openLeads} open</p>
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
                  <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Typical</p>
                  <p className="mt-1 font-display text-lg font-bold">{hasSamples ? formatDuration(row.medianSeconds) : "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">90% within</p>
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
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">“Typical” is the median wait. “90% within” means nine out of ten measured replies were at or below that time.</p>
    </div>
  );
}

function PerformanceBreakdown({ performance, tabs, primaryLabel, secondaryLabel, activeTab, onTabChange, onOpen }) {
  const availableTabs = tabs.filter(([key]) => key === "source" || (performance[key] || []).length > 0);
  const safeTab = availableTabs.some(([key]) => key === activeTab) ? activeTab : availableTabs[0]?.[0] || "source";
  const rows = performance[safeTab] || [];
  const title = tabs.find(([key]) => key === safeTab)?.[1] || "Source";
  return (
    <div>
      <div className="mb-4 flex gap-1.5 ui-scroll-x overflow-x-auto pb-1">
        {availableTabs.map(([key, label]) => (
          <button key={key} type="button" onClick={() => onTabChange(key)} className={`h-10 shrink-0 whitespace-nowrap rounded-xl px-3 text-xs font-semibold transition ${safeTab === key ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{label}</button>
        ))}
      </div>

      {rows.length ? (
        <>
          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => {
              const canOpen = row.label !== "Unspecified";
              const displayLabel = safeTab === "channel"
                ? formatChannel(row.label)
                : safeTab === "source"
                  ? formatSource(row.label)
                  : row.label;
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
                      <p className="text-[10px] text-[var(--color-text-muted)]">conversion {canOpen ? "→" : ""}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-border)]/70 pt-3 text-center">
                    <MiniValue label={primaryLabel} value={row.appointments} />
                    <MiniValue label={secondaryLabel} value={row.visits} />
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
                  <th className="px-2 pb-2 text-right font-bold">{primaryLabel}</th>
                  <th className="px-2 pb-2 text-right font-bold">{secondaryLabel}</th>
                  <th className="px-2 pb-2 text-right font-bold">Won</th>
                  <th className="pb-2 pl-2 text-right font-bold">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const canOpen = row.label !== "Unspecified";
                  return (
                    <tr key={row.label} onClick={canOpen ? () => onOpen(safeTab, row.label) : undefined} className={`border-b border-[var(--color-border)]/70 last:border-0 ${canOpen ? "cursor-pointer hover:bg-[var(--color-bg)]" : ""}`}>
                      <td className="py-3 pr-3 font-semibold">{safeTab === "channel" ? formatChannel(row.label) : safeTab === "source" ? formatSource(row.label) : row.label}{canOpen && <span className="ml-1.5 text-[var(--color-primary)]">→</span>}</td>
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
      <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-0.5 text-sm font-bold">{value}</p>
    </div>
  );
}

function SmallStat({ label, value }) {
  return (
    <div className="rounded-2xl bg-[var(--color-bg)] px-3 py-3 sm:px-4">
      <p className="text-xs font-semibold leading-snug text-[var(--color-text-muted)]">{label}</p>
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
    <section className="rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-3 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:px-4">
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
  const marker = state === "issue" ? "Issue" : state === "healthy" ? "Healthy" : "Status";
  return <span className={`rounded-full px-2.5 py-1.5 text-xs font-semibold ${tone}`}><span className="sr-only">{marker}: </span>{text}</span>;
}

function EmptyState({ text }) {
  return <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">{text}</div>;
}

function ChevronIcon(props) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" {...props}>
      <path d="M20 6v5h-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 11a7 7 0 1 0 1 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatChannel(value) {
  if (!value) return value;
  if (value === "whatsapp") return "WhatsApp";
  if (value === "instagram") return "Instagram";
  if (value === "facebook") return "Facebook";
  return value;
}

function formatSource(value) {
  return SOURCE_LABELS[value] || value;
}
