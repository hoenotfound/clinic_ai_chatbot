import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";

const DEFAULT_SETTINGS = {
  enabled: false,
  strategy: "round_robin",
  assignByBranch: true,
};

const DEFAULT_AI_BRANCH_RECORDING = {
  enabled: false,
  leadScoringEnabled: false,
  telegramSummaryEnabled: false,
};

const DEFAULT_UNASSIGNED = {
  openUnassignedCount: 0,
  recoverableUnassignedCount: 0,
  manualUnassignedCount: 0,
};

export default function LeadDistribution({ onDirtyChange, onSavedStatus }) {
  const { permissions } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SETTINGS);
  const [accounts, setAccounts] = useState([]);
  const [configuredBranches, setConfiguredBranches] = useState([]);
  const [aiBranchRecording, setAiBranchRecording] = useState(DEFAULT_AI_BRANCH_RECORDING);
  const [unassigned, setUnassigned] = useState(DEFAULT_UNASSIGNED);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState("");

  const canManageDistribution = Boolean(
    permissions?.manage_tools && permissions?.manage_lead_assignment
  );

  function applyStatus(status) {
    setAccounts(Array.isArray(status?.accounts) ? status.accounts : []);
    setConfiguredBranches(Array.isArray(status?.configuredBranches) ? status.configuredBranches : []);
    setAiBranchRecording({
      ...DEFAULT_AI_BRANCH_RECORDING,
      ...(status?.aiBranchRecording || {}),
    });
    setUnassigned({
      openUnassignedCount: Number(status?.openUnassignedCount) || 0,
      recoverableUnassignedCount: Number(status?.recoverableUnassignedCount) || 0,
      manualUnassignedCount: Number(status?.manualUnassignedCount) || 0,
    });
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getConfig(), api.getLeadDistributionStatus()])
      .then(([config, status]) => {
        if (cancelled) return;
        const current = {
          ...DEFAULT_SETTINGS,
          ...(config.leadDistribution || {}),
          strategy: "round_robin",
          assignByBranch: config.leadDistribution?.assignByBranch !== false,
        };
        setSettings(current);
        setSavedSettings(current);
        applyStatus(status);
        onSavedStatus?.(current.enabled);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load lead distribution.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onSavedStatus]);

  const hasUnsavedChanges = useMemo(
    () =>
      settings.enabled !== savedSettings.enabled ||
      settings.assignByBranch !== savedSettings.assignByBranch,
    [settings.enabled, settings.assignByBranch, savedSettings.enabled, savedSettings.assignByBranch]
  );

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
    return () => onDirtyChange?.(false);
  }, [hasUnsavedChanges, onDirtyChange]);

  const branchPools = useMemo(
    () =>
      configuredBranches.map((branchName) => ({
        branchName,
        accounts: accounts.filter((account) => account.branchName === branchName),
      })),
    [accounts, configuredBranches]
  );

  const staleBranchAccounts = useMemo(() => {
    const configured = new Set(configuredBranches);
    return accounts.filter((account) => account.branchName && !configured.has(account.branchName));
  }, [accounts, configuredBranches]);

  const savedEnabled = savedSettings.enabled === true;
  const savedBranchRouting = savedSettings.assignByBranch !== false;

  const attentionItems = [];
  if (accounts.length === 0) {
    attentionItems.push({
      tone: "warning",
      title: "No eligible Sales accounts",
      text: "Add or reactivate a Sales account that can view and reply to assigned leads before turning automation on.",
    });
  }
  if (unassigned.recoverableUnassignedCount > 0) {
    attentionItems.push({
      tone: "warning",
      title: `${unassigned.recoverableUnassignedCount} never-owned open ${unassigned.recoverableUnassignedCount === 1 ? "lead" : "leads"}`,
      text: "These leads can be assigned safely using the routing rules currently saved.",
    });
  }
  if (staleBranchAccounts.length > 0) {
    attentionItems.push({
      tone: settings.assignByBranch ? "danger" : "neutral",
      title: "Old branch mapping detected",
      text: `${staleBranchAccounts.map((account) => account.displayName).join(", ")} ${staleBranchAccounts.length === 1 ? "has" : "have"} a branch that is no longer configured.${settings.assignByBranch ? " Fix it before relying on branch routing." : " It does not affect global routing, but should still be cleaned up."}`,
    });
  }

  async function refreshAccounts() {
    setRefreshing(true);
    try {
      const status = await api.getLeadDistributionStatus();
      applyStatus(status);
      showToast("Sales routing status refreshed.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't refresh Sales accounts.", "error");
    } finally {
      setRefreshing(false);
    }
  }

  async function recoverUnassignedLeads() {
    if (!canManageDistribution) {
      showToast("Assign Leads permission is required to recover leads.", "error");
      return;
    }
    if (!savedEnabled) {
      showToast("Enable and save Automatic Lead Distribution before assigning older leads.", "error");
      return;
    }
    if (accounts.length === 0) {
      showToast("Add or reactivate an eligible Sales account first.", "error");
      return;
    }
    if (unassigned.recoverableUnassignedCount === 0) {
      showToast("There are no never-owned open leads to assign.", "info");
      return;
    }

    const routingLabel = savedBranchRouting ? "the saved branch routing rules" : "the global Sales rotation";
    const confirmed = window.confirm(
      `Assign up to ${Math.min(unassigned.recoverableUnassignedCount, 100)} never-owned open leads using ${routingLabel}? Leads manually left unassigned by staff will stay unassigned.`
    );
    if (!confirmed) return;

    setRecovering(true);
    try {
      const outcome = await api.recoverUnassignedLeads();
      const status = await api.getLeadDistributionStatus();
      applyStatus(status);
      const recovered = Number(outcome?.recoveredCount) || 0;
      showToast(
        recovered > 0
          ? `${recovered} previously unassigned ${recovered === 1 ? "lead was" : "leads were"} assigned.`
          : "No leads were assigned. Refresh the Sales team and try again.",
        recovered > 0 ? "info" : "warning"
      );
    } catch (err) {
      showToast(err.message || "Couldn't assign unowned leads.", "error");
    } finally {
      setRecovering(false);
    }
  }

  async function save() {
    if (!canManageDistribution) {
      showToast("Assign Leads permission is required to change lead distribution.", "error");
      return;
    }
    if (settings.enabled && accounts.length === 0) {
      showToast("Add at least one eligible Sales account before enabling lead distribution.", "error");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateConfig({
        leadDistribution: {
          enabled: settings.enabled,
          strategy: "round_robin",
          assignByBranch: settings.assignByBranch,
        },
      });
      const current = {
        ...DEFAULT_SETTINGS,
        ...(updated.leadDistribution || {}),
        strategy: "round_robin",
        assignByBranch: updated.leadDistribution?.assignByBranch !== false,
      };
      setSettings(current);
      setSavedSettings(current);
      onSavedStatus?.(current.enabled);
      showToast(
        !current.enabled
          ? "Automatic lead distribution is paused."
          : current.assignByBranch
            ? "Lead distribution is active by branch."
            : "Lead distribution is active across all Sales staff.",
        "info"
      );
    } catch (err) {
      showToast(err.message || "Couldn't save lead distribution.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)]">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-white p-6 text-center shadow-sm">
          <h1 className="font-display text-lg font-bold">Couldn't load lead distribution</h1>
          <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-5 inline-flex h-10 items-center rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold hover:bg-[var(--color-bg)]">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl pb-10">
          <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">Tools</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Automatic Lead Distribution</h1>
                <StatusBadge active={savedEnabled} unsaved={hasUnsavedChanges} />
                {!canManageDistribution && (
                  <span className="rounded-full border border-[var(--color-border)] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">View only</span>
                )}
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
                Automatically share new leads across your Sales team while keeping ownership stable after assignment.
              </p>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(24,39,33,0.04)] sm:min-w-56">
              <div>
                <p className="text-xs font-semibold">Automation</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {hasUnsavedChanges
                    ? settings.enabled
                      ? "Will be active after saving"
                      : "Will be paused after saving"
                    : savedEnabled
                      ? "Currently active"
                      : "Currently paused"}
                </p>
              </div>
              <Switch checked={settings.enabled} disabled={!canManageDistribution} onChange={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))} />
            </div>
          </header>

          {!canManageDistribution && (
            <div className="mt-5 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] px-4 py-3.5 text-xs leading-5 text-[var(--color-text-muted)]">
              You can review this setup, but changing routing or assigning older leads also requires <strong className="text-[var(--color-text)]">Assign Leads</strong> permission.
            </div>
          )}

          <section className="mt-7 rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
            <div>
              <h2 className="font-display text-base font-bold">How should leads be shared?</h2>
              <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">Choose the routing style that matches how your Sales team works.</p>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <RoutingChoice
                checked={settings.assignByBranch}
                disabled={!canManageDistribution}
                title="By branch"
                badge="Branch-aware"
                description="When the branch is already known, use that branch's Sales team first. If it is unknown or the branch has no eligible salesperson, use the global pool."
                onChange={() => setSettings((current) => ({ ...current, assignByBranch: true }))}
              />
              <RoutingChoice
                checked={!settings.assignByBranch}
                disabled={!canManageDistribution}
                title="Across all Sales staff"
                badge="Global"
                description="Ignore branch for ownership and rotate every new lead across all eligible Sales staff."
                onChange={() => setSettings((current) => ({ ...current, assignByBranch: false }))}
              />
            </div>
            <p className="mt-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
              The branch is still recorded for CRM, reporting and appointments even when global routing is selected.
              {!settings.enabled && " This choice will apply when automatic distribution is turned on."}
            </p>
          </section>

          <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3.5 shadow-[0_8px_24px_rgba(24,39,33,0.03)] sm:px-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
              <HealthItem value={accounts.length} label="eligible Sales" />
              <Separator />
              <HealthItem value={configuredBranches.length} label={configuredBranches.length === 1 ? "branch" : "branches"} />
              <Separator />
              <HealthItem value={unassigned.openUnassignedCount} label="open unassigned" attention={unassigned.openUnassignedCount > 0} />
              <span className="ml-auto text-[11px] font-medium text-[var(--color-text-muted)]">{settings.assignByBranch ? "Branch routing" : "Global routing"}</span>
            </div>
          </section>

          {attentionItems.length > 0 && (
            <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-[0_8px_24px_rgba(24,39,33,0.03)] sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Needs attention</p>
                  <h2 className="mt-1 text-sm font-bold">Routing health</h2>
                </div>
                {permissions?.manage_users && <Link to="/settings/team" className="text-xs font-semibold text-[var(--color-primary)] hover:underline">Team & Access</Link>}
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {attentionItems.map((item) => <AttentionItem key={item.title} {...item} />)}
              </div>
            </section>
          )}

          {unassigned.openUnassignedCount > 0 && (
            <section className="mt-5 flex flex-col gap-4 rounded-2xl border border-[var(--color-accent)]/30 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-sm font-bold">Unassigned leads</h2>
                  <span className="rounded-full bg-[var(--color-accent-light)] px-2 py-0.5 text-[10px] font-bold">{unassigned.openUnassignedCount}</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {unassigned.recoverableUnassignedCount} never-owned {unassigned.recoverableUnassignedCount === 1 ? "lead can" : "leads can"} be assigned safely. Staff-cleared owners stay unassigned.
                </p>
              </div>
              <button
                type="button"
                onClick={recoverUnassignedLeads}
                disabled={recovering || !savedEnabled || !canManageDistribution || accounts.length === 0 || unassigned.recoverableUnassignedCount === 0}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {recovering && <Spinner className="h-3.5 w-3.5" />}
                {recovering ? "Assigning…" : "Assign never-owned leads"}
              </button>
            </section>
          )}

          <details className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white shadow-[0_8px_24px_rgba(24,39,33,0.03)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
              <div>
                <h2 className="font-display text-sm font-bold">Sales routing team</h2>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{accounts.length} eligible Sales across {configuredBranches.length} configured {configuredBranches.length === 1 ? "branch" : "branches"}</p>
              </div>
              <span className="text-xs font-semibold text-[var(--color-primary)]">View team & branch pools</span>
            </summary>
            <div className="border-t border-[var(--color-border)] px-5 py-5 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {settings.assignByBranch
                    ? "Known branches use their matching pool first. Global is the fallback."
                    : "Branch pools are shown for reference, but global routing currently uses every eligible Sales account."}
                </p>
                <div className="flex items-center gap-3">
                  {permissions?.manage_users && <Link to="/settings/team" className="text-xs font-semibold text-[var(--color-primary)] hover:underline">Configure team</Link>}
                  <button type="button" onClick={refreshAccounts} disabled={refreshing} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold hover:bg-[var(--color-bg)] disabled:opacity-50">
                    {refreshing && <Spinner className="h-3.5 w-3.5" />}
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <PoolSummary name="Global Sales pool" count={accounts.length} active note={settings.assignByBranch ? "Fallback for leads without a usable branch pool." : "Used for every automatically assigned lead."} />
                {branchPools.map((pool) => (
                  <PoolSummary
                    key={pool.branchName}
                    name={pool.branchName}
                    count={pool.accounts.length}
                    active={settings.assignByBranch}
                    note={!settings.assignByBranch ? "Reference only while global routing is selected." : pool.accounts.length > 1 ? "Round robin within this branch." : pool.accounts.length === 1 ? "Direct assignment for this branch." : "Falls back to the global pool."}
                  />
                ))}
              </div>

              <div className="mt-6 divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)]">
                {accounts.length > 0 ? accounts.map((account) => (
                  <div key={account.id} className="flex items-center gap-3 bg-white px-3.5 py-3">
                    <Avatar name={account.displayName} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{account.displayName}</p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">@{account.username}</p>
                    </div>
                    <div className="text-right">
                      <p className="max-w-44 truncate text-[11px] font-semibold" title={account.branchName || "No fixed branch"}>{account.branchName || "No fixed branch"}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{settings.assignByBranch && account.branchName ? "Branch + global pool" : "Global pool"}</p>
                    </div>
                  </div>
                )) : (
                  <div className="bg-[var(--color-bg)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">No Sales accounts are eligible yet.</div>
                )}
              </div>
            </div>
          </details>

          <details className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white px-5 py-4 text-xs text-[var(--color-text-muted)] sm:px-6">
            <summary className="cursor-pointer select-none font-display text-sm font-bold text-[var(--color-text)]">How it works & advanced behavior</summary>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Assignment flow</p>
                <div className="mt-3 space-y-3">
                  <FlowStep number="1" title="New lead arrives" text="The customer message is stored first, then the lead is created." />
                  <FlowStep number="2" title={settings.assignByBranch ? "Choose the right pool" : "Use the global pool"} text={settings.assignByBranch ? "If the branch is already known, use that branch pool. Otherwise use the global Sales pool." : "Branch does not affect ownership. Round robin uses all eligible Sales accounts."} />
                  <FlowStep number="3" title="Keep the owner" text="Later branch changes or AI updates never move the lead to another salesperson." />
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Branch data</p>
                    <h3 className="mt-1 text-xs font-semibold text-[var(--color-text)]">AI branch recording</h3>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${aiBranchRecording.enabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>{aiBranchRecording.enabled ? "Available" : "Off"}</span>
                </div>
                <p className="mt-2 text-[11px] leading-5">
                  {aiBranchRecording.enabled
                    ? "AI can fill a blank branch after the conversation is analyzed. This records CRM data only and never changes the owner."
                    : "Staff can still edit the branch manually. AI branch recording becomes available through Lead Temperature or Telegram summaries."}
                </p>
                <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                  <StatusLine label="Lead Temperature" enabled={aiBranchRecording.leadScoringEnabled} />
                  <StatusLine label="Telegram summaries" enabled={aiBranchRecording.telegramSummaryEnabled} />
                </div>
              </section>
            </div>

            <div className="mt-5 border-t border-[var(--color-border)] pt-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Safeguards</p>
              <div className="mt-3 grid gap-x-8 gap-y-2 md:grid-cols-2">
                <Rule text="Round robin uses durable database cursors, so restarts do not reset the rotation." />
                <Rule text="Disabled or ineligible Sales accounts are skipped." />
                <Rule text="A manually selected owner is never overwritten by automation." />
                <Rule text="A manually cleared owner stays unassigned until staff changes it." />
                <Rule text="Branch routing only affects ownership when the branch is already known at lead creation." />
                <Rule text="If a branch has no eligible salesperson, assignment falls back to the global pool." />
                <Rule text="Later AI or staff branch corrections never reroute ownership." />
                <Rule text="If nobody is eligible, the chatbot continues and the lead remains recoverable." />
              </div>
            </div>
          </details>
        </div>
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
            <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">{hasUnsavedChanges ? "You have unsaved routing changes" : "All routing changes saved"}</p>
          </div>
          <button type="button" onClick={save} disabled={saving || !hasUnsavedChanges || !canManageDistribution} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Spinner />}
            {saving ? "Saving…" : "Save routing"}
          </button>
        </div>
      </footer>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function StatusBadge({ active, unsaved }) {
  const className = unsaved
    ? "bg-[var(--color-accent-light)] text-[var(--color-text)]"
    : active
      ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]";
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${className}`}>{unsaved ? "Unsaved" : active ? "Active" : "Paused"}</span>;
}

function Switch({ checked, disabled, onChange }) {
  return (
    <button type="button" role="switch" aria-label="Enable automatic lead distribution" aria-checked={checked} disabled={disabled} onClick={onChange} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
      <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function RoutingChoice({ checked, disabled, title, badge, description, onChange }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors ${disabled ? "cursor-not-allowed opacity-60" : ""} ${checked ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/45" : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"}`}>
      <input type="radio" name="lead-routing-mode" checked={checked} disabled={disabled} onChange={onChange} className="sr-only" />
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>{checked && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">{badge}</span>
        </span>
        <span className="mt-1.5 block text-[11px] leading-5 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

function HealthItem({ value, label, attention = false }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <strong className={attention ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}>{value}</strong>
      <span className="text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

function Separator() {
  return <span className="text-[var(--color-border)]" aria-hidden="true">•</span>;
}

function AttentionItem({ tone, title, text }) {
  const styles = tone === "danger"
    ? "border-[var(--color-danger)]/20 bg-[var(--color-danger)]/[0.03]"
    : tone === "warning"
      ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-light)]/50"
      : "border-[var(--color-border)] bg-[var(--color-bg)]";
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${styles}`}>
      <p className={`text-xs font-semibold ${tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"}`}>{title}</p>
      <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{text}</p>
    </div>
  );
}

function PoolSummary({ name, count, note, active }) {
  return (
    <div className={`rounded-xl border p-3.5 ${active ? "border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/35" : "border-[var(--color-border)] bg-[var(--color-bg)] opacity-70"}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs font-semibold">{name}</p>
        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">{count}</span>
      </div>
      <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{note}</p>
    </div>
  );
}

function Avatar({ name }) {
  const initial = String(name || "S").trim().charAt(0).toUpperCase() || "S";
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-xs font-bold text-[var(--color-primary)]">{initial}</span>;
}

function FlowStep({ number, title, text }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-light)] text-[10px] font-bold text-[var(--color-primary)]">{number}</span>
      <div>
        <p className="text-xs font-semibold text-[var(--color-text)]">{title}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{text}</p>
      </div>
    </div>
  );
}

function StatusLine({ label, enabled }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${enabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>{enabled ? "On" : "Off"}</span>
    </div>
  );
}

function Rule({ text }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-[10px] text-[var(--color-primary)]">✓</span>
      <p className="text-[11px] leading-5">{text}</p>
    </div>
  );
}
