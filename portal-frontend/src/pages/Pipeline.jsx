import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ToastContainer, useToasts } from "../components/Toast";
import Spinner from "../components/Spinner";
import LeadCard from "../components/pipeline/LeadCard";
import LeadDrawer from "../components/pipeline/LeadDrawer";
import StageManager from "../components/pipeline/StageManager";
import AddLeadModal from "../components/pipeline/AddLeadModal";
import StageMoveDialog from "../components/pipeline/StageMoveDialog";
import { formatMoney, isNoReply, isOverdue } from "../components/pipeline/pipelineUtils";

const PIPELINE_CLOCK_INTERVAL_MS = 30 * 1000;
const TIME_ZONE = "Asia/Kuala_Lumpur";

const CATEGORY_OPTIONS = [
  ["all", "All leads"],
  ["hot", "Hot"],
  ["warm", "Warm"],
  ["cold", "Cold"],
  ["unassigned", "Unassigned"],
  ["no_reply", "No reply"],
  ["reschedule", "Reschedule"],
  ["cancelled", "Cancelled"],
  ["overdue", "Follow-up overdue"],
  ["attention", "Needs attention"],
];
const CATEGORY_KEYS = new Set(CATEGORY_OPTIONS.map(([key]) => key));
const ANALYTICS_PARAM_KEYS = ["from", "to", "channel", "source", "campaign", "treatment", "owner"];

function parameterOrNull(searchParams, key) {
  const value = searchParams.get(key);
  return value && value !== "all" ? value : null;
}

function localDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function Pipeline() {
  const { toasts, showToast, dismissToast } = useToasts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState(() => parameterOrNull(searchParams, "branch") || "all");
  const [categoryFilter, setCategoryFilter] = useState(() => {
    const requested = searchParams.get("category") || "all";
    return CATEGORY_KEYS.has(requested) ? requested : "all";
  });
  const [mobileStageId, setMobileStageId] = useState(null);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [showStages, setShowStages] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [pendingMove, setPendingMove] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshTimerRef = useRef(null);

  const analyticsFilters = useMemo(() => ({
    from: parameterOrNull(searchParams, "from"),
    to: parameterOrNull(searchParams, "to"),
    channel: parameterOrNull(searchParams, "channel"),
    source: parameterOrNull(searchParams, "source"),
    campaign: parameterOrNull(searchParams, "campaign"),
    treatment: parameterOrNull(searchParams, "treatment"),
    owner: parameterOrNull(searchParams, "owner"),
  }), [searchParams]);
  const hasAnalyticsDrilldown = Object.values(analyticsFilters).some(Boolean);

  const refreshPipeline = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await api.getPipeline();
      setData(payload);
    } catch (err) {
      console.error("Failed to load pipeline:", err);
      showToast(err.message || "Couldn't load the pipeline.", "error");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    refreshPipeline();
  }, [refreshPipeline]);

  useEffect(() => {
    const requestedBranch = parameterOrNull(searchParams, "branch") || "all";
    const requestedCategory = searchParams.get("category") || "all";
    setBranchFilter(requestedBranch);
    setCategoryFilter(CATEGORY_KEYS.has(requestedCategory) ? requestedCategory : "all");
  }, [searchParams]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PIPELINE_CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    function scheduleRefresh() {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => refreshPipeline({ quiet: true }), 150);
    }
    source.addEventListener("pipeline_changed", scheduleRefresh);
    source.addEventListener("conversation_changed", scheduleRefresh);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      source.removeEventListener("pipeline_changed", scheduleRefresh);
      source.removeEventListener("conversation_changed", scheduleRefresh);
      source.close();
    };
  }, [refreshPipeline]);

  const requestedLeadId = /^\d+$/.test(searchParams.get("lead") || "")
    ? Number(searchParams.get("lead"))
    : null;

  useEffect(() => {
    if (requestedLeadId && data?.leads.some((lead) => Number(lead.id) === requestedLeadId)) {
      setSelectedLeadId(requestedLeadId);
    }
  }, [data, requestedLeadId]);

  const leads = useMemo(() => data?.leads || [], [data?.leads]);
  const stages = useMemo(() => data?.stages || [], [data?.stages]);
  const noReplyHours = Number(data?.noReplyHours) || 24;
  const selectedLead = leads.find((lead) => Number(lead.id) === Number(selectedLeadId)) || null;

  useEffect(() => {
    if (!stages.length) {
      setMobileStageId(null);
      return;
    }
    setMobileStageId((current) => (
      stages.some((stage) => Number(stage.id) === Number(current)) ? current : stages[0].id
    ));
  }, [stages]);

  // Analytics date/source/etc. filters are applied first without the branch.
  // Branch cards can then show accurate counts inside the Analytics cohort,
  // while selecting a branch narrows that same cohort instead of mixing scopes.
  const analyticsBaseLeads = useMemo(() => {
    if (!hasAnalyticsDrilldown) return leads;
    return leads.filter((lead) => {
      if (analyticsFilters.channel && lead.channel !== analyticsFilters.channel) return false;
      if (analyticsFilters.source && lead.source !== analyticsFilters.source) return false;
      if (analyticsFilters.campaign && lead.campaign_name !== analyticsFilters.campaign) return false;
      if (analyticsFilters.treatment && lead.treatment_interest !== analyticsFilters.treatment) return false;
      if (analyticsFilters.owner && lead.owner_username !== analyticsFilters.owner) return false;
      if (analyticsFilters.from || analyticsFilters.to) {
        const journeyDate = localDate(lead.journey_started_at || lead.created_at);
        if (!journeyDate) return false;
        if (analyticsFilters.from && journeyDate < analyticsFilters.from) return false;
        if (analyticsFilters.to && journeyDate > analyticsFilters.to) return false;
      }
      return true;
    });
  }, [analyticsFilters, hasAnalyticsDrilldown, leads]);

  const drilldownLeads = useMemo(() => {
    return analyticsBaseLeads.filter((lead) => {
      if (branchFilter === "unassigned" && lead.branch_name) return false;
      if (branchFilter !== "all" && branchFilter !== "unassigned" && lead.branch_name !== branchFilter) return false;
      return true;
    });
  }, [analyticsBaseLeads, branchFilter]);

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    return drilldownLeads.filter((lead) => {
      if (!matchesCategory(lead, categoryFilter, now, noReplyHours)) return false;
      if (term) {
        const haystack = [
          lead.name,
          lead.whatsapp_profile_name,
          lead.whatsapp_number,
          lead.treatment_interest,
          lead.branch_name,
          lead.owner_username,
          lead.source,
          lead.campaign_name,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [categoryFilter, drilldownLeads, noReplyHours, now, search]);

  const categoryCounts = useMemo(() => Object.fromEntries(
    CATEGORY_OPTIONS.map(([key]) => [
      key,
      drilldownLeads.filter((lead) => matchesCategory(lead, key, now, noReplyHours)).length,
    ])
  ), [drilldownLeads, noReplyHours, now]);

  const metricLeads = hasAnalyticsDrilldown ? drilldownLeads : leads;
  const metricActiveLeads = metricLeads.filter((lead) => !lead.is_closed);
  const pipelineValue = metricActiveLeads.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0);
  const branchCardBase = hasAnalyticsDrilldown ? analyticsBaseLeads : leads;
  const branchCardActive = branchCardBase.filter((lead) => !lead.is_closed);
  const branchCards = useMemo(() => [
    { key: "all", label: "All branches", leads: branchCardActive },
    ...(data?.branches || []).map((branch) => ({
      key: branch,
      label: branch,
      leads: branchCardActive.filter((lead) => lead.branch_name === branch),
    })),
    { key: "unassigned", label: "Unassigned", leads: branchCardActive.filter((lead) => !lead.branch_name) },
  ], [branchCardActive, data?.branches]);

  const stageCounts = useMemo(() => Object.fromEntries(
    stages.map((stage) => [
      stage.id,
      filteredLeads.filter((lead) => Number(lead.stage_id) === Number(stage.id)).length,
    ])
  ), [filteredLeads, stages]);
  const mobileStage = stages.find((stage) => Number(stage.id) === Number(mobileStageId)) || stages[0] || null;
  const mobileStageLeads = mobileStage
    ? filteredLeads.filter((lead) => Number(lead.stage_id) === Number(mobileStage.id))
    : [];
  const mobileStageValue = mobileStageLeads.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0);

  function updateParam(key, value) {
    const next = new URLSearchParams(searchParams);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    next.delete("lead");
    setSelectedLeadId(null);
    setSearchParams(next, { replace: true });
  }

  function selectBranch(value) {
    setBranchFilter(value);
    updateParam("branch", value);
  }

  function selectCategory(value) {
    setCategoryFilter(value);
    updateParam("category", value);
  }

  function clearAnalyticsDrilldown() {
    const next = new URLSearchParams(searchParams);
    for (const key of [...ANALYTICS_PARAM_KEYS, "branch", "category"]) next.delete(key);
    next.delete("lead");
    setBranchFilter("all");
    setCategoryFilter("all");
    setSelectedLeadId(null);
    setSearchParams(next, { replace: true });
  }

  function openLead(leadId) {
    setSelectedLeadId(Number(leadId));
    const next = new URLSearchParams(searchParams);
    next.set("lead", String(leadId));
    setSearchParams(next, { replace: true });
  }

  function closeLead() {
    setSelectedLeadId(null);
    const next = new URLSearchParams(searchParams);
    next.delete("lead");
    setSearchParams(next, { replace: true });
  }

  function mergeLead(updated) {
    setData((current) => current ? {
      ...current,
      leads: current.leads.map((lead) => Number(lead.id) === Number(updated.id) ? updated : lead),
    } : current);
  }

  async function updateLead(leadId, patch) {
    try {
      const updated = await api.updateLead(leadId, patch);
      mergeLead(updated);
      refreshPipeline({ quiet: true });
      return updated;
    } catch (err) {
      showToast(err.message || "Couldn't update the lead.", "error");
      return null;
    }
  }

  async function requestStageMove(lead, stage) {
    if (Number(lead.stage_id) === Number(stage.id)) return;
    if (stage.stage_type === "won" || stage.stage_type === "lost") {
      setPendingMove({ lead, stage });
      return;
    }
    await updateLead(lead.id, { stageId: Number(stage.id) });
  }

  function handleDragStart(event, lead) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/lead-id", String(lead.id));
  }

  function handleDrop(event, stage) {
    event.preventDefault();
    const leadId = Number(event.dataTransfer.getData("text/lead-id"));
    const lead = leads.find((item) => Number(item.id) === leadId);
    if (lead) requestStageMove(lead, stage);
  }

  async function handleLeadCreated(lead, created) {
    await refreshPipeline({ quiet: true });
    setShowAddLead(false);
    openLead(lead.id);
    showToast(created ? "Lead added to the pipeline." : "This contact already has an open lead.", created ? "info" : "warning");
  }

  async function refreshAfterStageChange(action) {
    const result = await action();
    await refreshPipeline({ quiet: true });
    return result;
  }

  if (loading && !data) {
    return <div className="flex h-full items-center justify-center"><Spinner className="h-7 w-7 text-[var(--color-primary)]" /></div>;
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-4 sm:p-6">
        <div className="max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm sm:p-8">
          <h1 className="font-display text-xl font-bold">Couldn't load the pipeline</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Check the connection and try again. Your lead data has not been changed.</p>
          <button type="button" onClick={() => refreshPipeline()} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)]">Try again</button>
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg)]">
      <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 lg:px-7">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="truncate font-display text-xl font-bold">Lead Pipeline</h1>
              <span className="shrink-0 rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-primary)]">Live</span>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-text-muted)] sm:text-sm">Track every enquiry, next action and sales outcome in one place.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => setShowStages(true)} className="h-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold transition hover:bg-[var(--color-bg)] sm:px-3.5 sm:text-sm">
              <span className="sm:hidden">Stages</span><span className="hidden sm:inline">Manage stages</span>
            </button>
            <button type="button" onClick={() => setShowAddLead(true)} className="h-11 rounded-xl bg-[var(--color-primary)] px-3.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] sm:px-4 sm:text-sm">+ Add lead</button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
          <Metric label="Active leads" value={metricActiveLeads.length} detail={`${metricLeads.length} total journeys`} />
          <Metric label="Hot leads" value={categoryCounts.hot || 0} detail="Priority follow-up" tone="danger" />
          <Metric className="col-span-2 sm:col-span-1" label="Pipeline value" value={formatMoney(pipelineValue) || "RM 0"} detail="Estimated open value" />
        </div>
      </header>

      {hasAnalyticsDrilldown && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-primary-light)] px-3.5 py-2.5 text-xs sm:px-5 lg:px-7">
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 font-bold text-[var(--color-primary)]">Analytics view</span>
            {analyticsFilters.from && analyticsFilters.to && <FilterPill>{analyticsFilters.from} → {analyticsFilters.to}</FilterPill>}
            {analyticsFilters.channel && <FilterPill>{analyticsFilters.channel}</FilterPill>}
            {analyticsFilters.source && <FilterPill>Source: {analyticsFilters.source}</FilterPill>}
            {analyticsFilters.campaign && <FilterPill>Campaign: {analyticsFilters.campaign}</FilterPill>}
            {analyticsFilters.treatment && <FilterPill>Treatment: {analyticsFilters.treatment}</FilterPill>}
            {analyticsFilters.owner && <FilterPill>Owner: {analyticsFilters.owner}</FilterPill>}
            <button type="button" onClick={clearAnalyticsDrilldown} className="ml-auto h-9 shrink-0 rounded-lg px-2.5 font-semibold text-[var(--color-primary)] transition hover:bg-white/70">Clear</button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-b border-[var(--color-border)] px-3.5 py-3 sm:px-5 sm:py-4 lg:px-7">
        <div className="flex gap-2.5 overflow-x-auto pb-1 sm:gap-3">
          {branchCards.map((branch) => {
            const hotCount = branch.leads.filter((lead) => lead.temperature === "hot").length;
            const appointmentCount = branch.leads.filter((lead) => lead.appointment_status === "set").length;
            return (
              <button key={branch.key} type="button" onClick={() => selectBranch(branch.key)} className={`min-w-36 rounded-2xl border px-3 py-2.5 text-left transition sm:min-w-44 sm:p-3 ${branchFilter === branch.key ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] shadow-sm" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/40"}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-bold">{branch.label}</p>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">{branch.leads.length}</span>
                </div>
                <p className="mt-1.5 truncate text-[9px] text-[var(--color-text-muted)] sm:mt-2 sm:text-[10px]">{hotCount} hot · {appointmentCount} appointments</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 sm:px-5 lg:px-7">
        <div className="flex items-center gap-2.5">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <SearchIcon />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search leads…" className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] pl-9 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-sm text-[var(--color-text-muted)] hover:bg-white">✕</button>}
          </div>
          <span className="hidden shrink-0 text-[11px] font-medium text-[var(--color-text-muted)] md:block">{filteredLeads.length} shown</span>
        </div>
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
          {CATEGORY_OPTIONS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => selectCategory(key)} className={`h-10 shrink-0 whitespace-nowrap rounded-xl px-3 text-xs font-semibold transition ${categoryFilter === key ? "bg-[var(--color-primary)] text-white shadow-sm" : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}>
              {label} <span className="ml-1 opacity-70">{categoryCounts[key] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2.5">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {stages.map((stage) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => setMobileStageId(stage.id)}
                className={`flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-xs font-semibold transition ${Number(mobileStage?.id) === Number(stage.id) ? "bg-[var(--color-text)] text-white shadow-sm" : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"}`}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: stage.color }} />
                <span>{stage.name}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${Number(mobileStage?.id) === Number(stage.id) ? "bg-white/15 text-white" : "bg-[var(--color-bg)]"}`}>{stageCounts[stage.id] || 0}</span>
              </button>
            ))}
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
          {mobileStage ? (
            <section>
              <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-white px-3.5 py-3 shadow-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: mobileStage.color }} />
                    <h2 className="truncate text-sm font-bold">{mobileStage.name}</h2>
                  </div>
                  <p className="mt-1 pl-[18px] text-[10px] text-[var(--color-text-muted)]">{mobileStageLeads.length} lead{mobileStageLeads.length === 1 ? "" : "s"} · {formatMoney(mobileStageValue) || "RM 0"}</p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-[10px] font-bold text-[var(--color-text-muted)]">{filteredLeads.length} shown</span>
              </div>

              <div className="space-y-2.5">
                {mobileStageLeads.map((lead) => <LeadCard key={lead.id} lead={lead} now={now} noReplyHours={noReplyHours} onOpen={openLead} onDragStart={handleDragStart} />)}
                {mobileStageLeads.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-white/60 px-4 py-10 text-center">
                    <p className="text-sm font-semibold">No leads here</p>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">Try another stage or adjust your filters.</p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-xs text-[var(--color-text-muted)]">No pipeline stages yet.</div>
          )}
        </main>
      </div>

      <main className="hidden min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-5 md:block lg:p-6">
        <div className="flex h-full min-w-max gap-4">
          {stages.map((stage) => {
            const stageLeads = filteredLeads.filter((lead) => Number(lead.stage_id) === Number(stage.id));
            const value = stageLeads.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0);
            return (
              <section key={stage.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => handleDrop(event, stage)} className="flex h-full w-[19rem] flex-col rounded-2xl bg-[#f1f2ee]">
                <header className="border-b border-black/5 px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stage.color }} />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-bold">{stage.name}</h2>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-muted)]">{stageLeads.length}</span>
                  </div>
                  <p className="mt-1.5 pl-[18px] text-[10px] text-[var(--color-text-muted)]">{formatMoney(value) || "RM 0"}</p>
                </header>
                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
                  {stageLeads.map((lead) => <LeadCard key={lead.id} lead={lead} now={now} noReplyHours={noReplyHours} onOpen={openLead} onDragStart={handleDragStart} />)}
                  {stageLeads.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">Drop leads here</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {selectedLead && <LeadDrawer key={selectedLead.id} lead={selectedLead} stages={stages} branches={data.branches || []} owners={data.owners || []} services={data.services || []} now={now} noReplyHours={noReplyHours} onClose={closeLead} onSaved={mergeLead} onToast={showToast} />}
      {showStages && <StageManager stages={stages} onClose={() => setShowStages(false)} onSaveStage={(id, patch) => api.updatePipelineStage(id, patch)} onCreateStage={(payload) => refreshAfterStageChange(() => api.createPipelineStage(payload))} onDeleteStage={(id) => refreshAfterStageChange(() => api.deletePipelineStage(id))} onReorder={(ids) => refreshAfterStageChange(() => api.reorderPipelineStages(ids))} onToast={showToast} />}
      {showAddLead && <AddLeadModal branches={data.branches || []} services={data.services || []} onClose={() => setShowAddLead(false)} onCreated={handleLeadCreated} onToast={showToast} />}
      {pendingMove && <StageMoveDialog lead={pendingMove.lead} stage={pendingMove.stage} onCancel={() => setPendingMove(null)} onConfirm={async (patch) => { const updated = await updateLead(pendingMove.lead.id, patch); if (updated) setPendingMove(null); }} />}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function matchesCategory(lead, category, now, noReplyHours) {
  if (category === "all") return true;
  if (["hot", "warm", "cold"].includes(category)) return lead.temperature === category && !lead.is_closed;
  if (category === "unassigned") return !lead.branch_name && !lead.is_closed;
  if (category === "no_reply") return isNoReply(lead, noReplyHours, now);
  if (category === "reschedule") return lead.appointment_status === "reschedule";
  if (category === "cancelled") return lead.appointment_status === "cancelled";
  if (category === "overdue") return isOverdue(lead, now);
  if (category === "attention") return !!lead.needs_attention;
  return true;
}

function Metric({ label, value, detail, tone, className = "" }) {
  return (
    <div className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 sm:px-4 ${className}`}>
      <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] sm:text-[10px]">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className={`font-display text-xl font-bold ${tone === "danger" ? "text-[var(--color-danger)]" : ""}`}>{value}</p>
        <p className="hidden pb-0.5 text-[10px] text-[var(--color-text-muted)] sm:block">{detail}</p>
      </div>
    </div>
  );
}

function FilterPill({ children }) {
  return <span className="shrink-0 rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">{children}</span>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
}
