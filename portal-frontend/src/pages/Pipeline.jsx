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
import { formatMoney, isOverdue } from "../components/pipeline/pipelineUtils";

const CATEGORY_OPTIONS = [
  ["all", "All leads"],
  ["hot", "Hot"],
  ["warm", "Warm"],
  ["unassigned", "Unassigned"],
  ["no_reply", "No reply"],
  ["reschedule", "Reschedule"],
  ["cancelled", "Cancelled"],
  ["overdue", "Follow-up overdue"],
  ["attention", "Needs attention"],
];

export default function Pipeline() {
  const { toasts, showToast, dismissToast } = useToasts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [showStages, setShowStages] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [pendingMove, setPendingMove] = useState(null);
  const refreshTimerRef = useRef(null);

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
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    function scheduleRefresh() {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => refreshPipeline({ quiet: true }), 150);
    }
    source.addEventListener("pipeline_changed", scheduleRefresh);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      source.removeEventListener("pipeline_changed", scheduleRefresh);
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
  const selectedLead = leads.find((lead) => Number(lead.id) === Number(selectedLeadId)) || null;

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (branchFilter === "unassigned" && lead.branch_name) return false;
      if (branchFilter !== "all" && branchFilter !== "unassigned" && lead.branch_name !== branchFilter) return false;
      if (!matchesCategory(lead, categoryFilter)) return false;
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
  }, [branchFilter, categoryFilter, leads, search]);

  const categoryCounts = useMemo(() => Object.fromEntries(
    CATEGORY_OPTIONS.map(([key]) => [key, leads.filter((lead) => matchesCategory(lead, key)).length])
  ), [leads]);

  const activeLeads = useMemo(() => leads.filter((lead) => !lead.is_closed), [leads]);
  const pipelineValue = activeLeads.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0);
  const branchCards = useMemo(() => [
    { key: "all", label: "All branches", leads: activeLeads },
    ...(data?.branches || []).map((branch) => ({
      key: branch,
      label: branch,
      leads: activeLeads.filter((lead) => lead.branch_name === branch),
    })),
    { key: "unassigned", label: "Unassigned", leads: activeLeads.filter((lead) => !lead.branch_name) },
  ], [activeLeads, data?.branches]);

  function openLead(leadId) {
    setSelectedLeadId(Number(leadId));
    setSearchParams({ lead: String(leadId) }, { replace: true });
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
          <Metric label="Active leads" value={activeLeads.length} detail={`${leads.length} total journeys`} />
          <Metric label="Hot leads" value={categoryCounts.hot || 0} detail="Require priority follow-up" tone="danger" />
          <Metric label="Pipeline value" value={formatMoney(pipelineValue) || "RM 0"} detail="Estimated open value" />
        </div>
      </header>

      <div className="border-b border-[var(--color-border)] px-5 py-4 lg:px-7">
        <div className="flex gap-3 overflow-x-auto pb-1">
          {branchCards.map((branch) => {
            const hotCount = branch.leads.filter((lead) => lead.temperature === "hot").length;
            const appointmentCount = branch.leads.filter((lead) => lead.appointment_status === "set").length;
            return (
              <button key={branch.key} type="button" onClick={() => setBranchFilter(branch.key)} className={`min-w-44 rounded-2xl border p-3 text-left transition ${branchFilter === branch.key ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] shadow-sm" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/40"}`}>
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
            <button key={key} type="button" onClick={() => setCategoryFilter(key)} className={`whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition ${categoryFilter === key ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}>
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
                  {stageLeads.map((lead) => <LeadCard key={lead.id} lead={lead} onOpen={openLead} onDragStart={handleDragStart} />)}
                  {stageLeads.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">Drop leads here</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {selectedLead && <LeadDrawer key={selectedLead.id} lead={selectedLead} stages={stages} branches={data.branches || []} owners={data.owners || []} services={data.services || []} onClose={closeLead} onSaved={mergeLead} onToast={showToast} />}
      {showStages && <StageManager stages={stages} onClose={() => setShowStages(false)} onSaveStage={(id, patch) => api.updatePipelineStage(id, patch)} onCreateStage={(payload) => refreshAfterStageChange(() => api.createPipelineStage(payload))} onDeleteStage={(id) => refreshAfterStageChange(() => api.deletePipelineStage(id))} onReorder={(ids) => refreshAfterStageChange(() => api.reorderPipelineStages(ids))} onToast={showToast} />}
      {showAddLead && <AddLeadModal branches={data.branches || []} services={data.services || []} onClose={() => setShowAddLead(false)} onCreated={handleLeadCreated} onToast={showToast} />}
      {pendingMove && <StageMoveDialog lead={pendingMove.lead} stage={pendingMove.stage} onCancel={() => setPendingMove(null)} onConfirm={async (patch) => { const updated = await updateLead(pendingMove.lead.id, patch); if (updated) setPendingMove(null); }} />}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function matchesCategory(lead, category) {
  if (category === "all") return true;
  if (category === "hot" || category === "warm") return lead.temperature === category && !lead.is_closed;
  if (category === "unassigned") return !lead.branch_name && !lead.is_closed;
  if (category === "no_reply") return !!lead.no_reply;
  if (category === "reschedule") return lead.appointment_status === "reschedule";
  if (category === "cancelled") return lead.appointment_status === "cancelled";
  if (category === "overdue") return isOverdue(lead);
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

function SearchIcon() {
  return <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
}
