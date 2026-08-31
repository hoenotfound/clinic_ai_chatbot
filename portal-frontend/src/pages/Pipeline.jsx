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

  const activeLeads = useMemo(() => leads.filter((lead) => !lead.is_closed), [leads]);
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
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
          <h1 className="font-display text-xl font-bold">Couldn't load the pipeline</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Check the connection and try again. Your lead data has not been changed.</p>
          <button type="button" onClick={() => refreshPipeline()} className="mt-5 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)]">Try again</button>
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-xl font-bold">Lead Pipeline</h1>
              <span className="rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-primary)]">Live</span>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Move every enquiry from first message to clinic visit and conversion.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowStages(true)} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm font-semibold hover:bg-[var(--color-bg)]">Manage stages</button>
            <button type="button" onClick={() => setShowAddLead(true)} className="rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)]">+ Add lead</button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Metric label="Active leads" value={metricActiveLeads.length} detail={`${metricLeads.length} total journeys`} />
          <Metric label="Hot leads" value={categoryCounts.hot || 0} detail="Require priority follow-up" tone="danger" />
          <Metric label="Pipeline value" value={formatMoney(pipelineValue) || "RM 0"} detail="Estimated open value" />
        </div>
      </header>

      {hasAnalyticsDrilldown && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-primary-light)] px-5 py-2.5 text-xs lg:px-7">
          <span className="font-bold text-[var(--color-primary)]">Analytics drill-down</span>
          {analyticsFilters.from && analyticsFilters.to && <FilterPill>{analyticsFilters.from} → {analyticsFilters.to}</FilterPill>}
          {analyticsFilters.channel && <FilterPill>{analyticsFilters.channel}</FilterPill>}
          {analyticsFilters.source && <FilterPill>Source: {analyticsFilters.source}</FilterPill>}
          {analyticsFilters.campaign && <FilterPill>Campaign: {analyticsFilters.campaign}</FilterPill>}
          {analyticsFilters.treatment && <FilterPill>Treatment: {analyticsFilters.treatment}</FilterPill>}
          {analyticsFilters.owner && <FilterPill>Owner: {analyticsFilters.owner}</FilterPill>}
          <button type="button" onClick={clearAnalyticsDrilldown} className="ml-auto rounded-lg px-2.5 py-1.5 font-semibold text-[var(--color-primary)] hover:bg-white/70">Clear drill-down</button>
        </div>
      )}

      <div className="border-b border-[var(--color-border)] px-5 py-4 lg:px-7">
        <div className="flex gap-3 overflow-x-auto pb-1">
          {branchCards.map((branch) => {
            const hotCount = branch.leads.filter((lead) => lead.temperature === "hot").length;
            const appointmentCount = branch.leads.filter((lead) => lead.appointment_status === "set").length;
            return (
              <button key={branch.key} type="button" onClick={() => selectBranch(branch.key)} className={`min-w-44 rounded-2xl border p-3 text-left transition ${branchFilter === branch.key ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] shadow-sm" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/40"}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-bold">{branch.label}</p>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">{branch.leads.length}</span>
                </div>
                <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">{hotCount} hot · {appointmentCount} appointments</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3 lg:px-7">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <SearchIcon />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search leads…" className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] py-2.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15" />
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {CATEGORY_OPTIONS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => selectCategory(key)} className={`whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition ${categoryFilter === key ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}>
              {label} <span className="ml-1 opacity-70">{categoryCounts[key] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-5 lg:p-6">
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

function Metric({ label, value, detail, tone }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className={`font-display text-xl font-bold ${tone === "danger" ? "text-[var(--color-danger)]" : ""}`}>{value}</p>
        <p className="pb-0.5 text-[10px] text-[var(--color-text-muted)]">{detail}</p>
      </div>
    </div>
  );
}

function FilterPill({ children }) {
  return <span className="rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">{children}</span>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
}
