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

export default function LeadDistribution() {
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
    setConfiguredBranches(
      Array.isArray(status?.configuredBranches) ? status.configuredBranches : []
    );
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
  }, []);

  const hasUnsavedChanges = useMemo(
    () =>
      settings.enabled !== savedSettings.enabled ||
      settings.assignByBranch !== savedSettings.assignByBranch,
    [
      settings.enabled,
      settings.assignByBranch,
      savedSettings.enabled,
      savedSettings.assignByBranch,
    ]
  );

  const branchPools = useMemo(
    () => configuredBranches.map((branchName) => ({
      branchName,
      accounts: accounts.filter((account) => account.branchName === branchName),
    })),
    [accounts, configuredBranches]
  );

  const staleBranchAccounts = useMemo(() => {
    const configured = new Set(configuredBranches);
    return accounts.filter(
      (account) => account.branchName && !configured.has(account.branchName)
    );
  }, [accounts, configuredBranches]);

  const savedEnabled = savedSettings.enabled === true;
  const savedBranchRouting = savedSettings.assignByBranch !== false;

  async function refreshAccounts() {
    setRefreshing(true);
    try {
      const status = await api.getLeadDistributionStatus();
      applyStatus(status);
      showToast("Lead distribution status refreshed.", "info");
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
      showToast("Enable and save Automatic Lead Distribution before recovering leads.", "error");
      return;
    }
    if (accounts.length === 0) {
      showToast("Add or reactivate an eligible Sales account first.", "error");
      return;
    }
    if (unassigned.recoverableUnassignedCount === 0) {
      showToast("There are no never-owned open leads to recover.", "info");
      return;
    }

    const routingLabel = savedBranchRouting
      ? "the current branch/global routing rules"
      : "the global Sales rotation";
    const confirmed = window.confirm(
      `Assign up to ${Math.min(unassigned.recoverableUnassignedCount, 100)} never-owned open leads using ${routingLabel}? Leads manually unassigned by staff will stay unassigned.`
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
          : "No leads were assigned. Refresh the Sales pool and try again.",
        recovered > 0 ? "info" : "warning"
      );
    } catch (err) {
      showToast(err.message || "Couldn't recover unassigned leads.", "error");
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
      showToast(
        !current.enabled
          ? "Automatic lead distribution is paused."
          : current.assignByBranch
            ? "Lead distribution is active with branch routing."
            : "Lead distribution is active using the global Sales rotation.",
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
          <Link to="/tools" className="mt-5 inline-flex h-11 items-center rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold">
            Back to Tools
          </Link>
        </div>
      </div>
    );
  }

  const pendingState = hasUnsavedChanges
    ? "Changes not saved"
    : savedEnabled
      ? savedBranchRouting
        ? "Active · Branch-aware"
        : "Active · Global rotation"
      : "Paused";

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
      text: "These leads can be assigned safely using the routing rules currently saved below.",
    });
  }
  if (staleBranchAccounts.length > 0) {
    attentionItems.push({
      tone: settings.assignByBranch ? "danger" : "neutral",
      title: "Old branch mapping detected",
      text: `${staleBranchAccounts.map((account) => account.displayName).join(", ")} ${staleBranchAccounts.length === 1 ? "has" : "have"} a branch name that is no longer configured.${settings.assignByBranch ? " Fix it before relying on branch-specific routing." : " It does not affect global-only assignment, but should still be cleaned up."}`,
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl pb-10">
          <div className="mb-5 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Link to="/tools" className="font-semibold text-[var(--color-primary)] hover:underline">Tools</Link>
            <span>/</span>
            <span>Lead distribution</span>
          </div>

          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Automatic Lead Distribution</h1>
                <StatusBadge active={savedEnabled} unsaved={hasUnsavedChanges} />
                {!canManageDistribution && (
                  <span className="rounded-full border border-[var(--color-border)] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                    View only
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
                Decide how new leads are shared across your Sales team. Ownership stays with the assigned salesperson unless staff explicitly reassigns it.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-right shadow-[0_6px_20px_rgba(24,39,33,0.035)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Current state</p>
              <p className="mt-1 text-xs font-semibold">{pendingState}</p>
            </div>
          </header>

          {!canManageDistribution && (
            <section className="mt-5 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] px-4 py-3.5 text-xs leading-5 text-[var(--color-text-muted)]">
              You can review routing health and Sales pools, but changing assignment rules or recovering leads also requires <strong className="text-[var(--color-text)]">Assign Leads</strong> permission.
            </section>
          )}

          <section className="mt-6 overflow-hidden rounded-3xl border border-[var(--color-border)] bg-white shadow-[0_10px_34px_rgba(24,39,33,0.04)]">
            <div className="border-b border-[var(--color-border)] px-5 py-4 sm:px-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-primary)]">Routing settings</p>
              <h2 className="mt-1 font-display text-lg font-bold">Choose how new leads are assigned</h2>
            </div>

            <SettingToggle
              title="Automatic lead distribution"
              description="Assign every new unowned lead immediately using round robin. Turn this off to leave new leads unassigned for staff to handle manually."
              checked={settings.enabled}
              disabled={!canManageDistribution}
              onChange={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))}
              badge={settings.enabled ? "On" : "Off"}
            />

            <div className="mx-5 border-t border-[var(--color-border)] sm:mx-6" />

            <SettingToggle
              title="Assign leads by branch"
              description="When a branch is already known at lead creation, use that branch's Sales pool first. Turn this off if one centralized Sales team should receive every lead. The branch is still recorded for CRM, reporting and appointments."
              checked={settings.assignByBranch}
              disabled={!canManageDistribution}
              onChange={() => setSettings((current) => ({
                ...current,
                assignByBranch: !current.assignByBranch,
              }))}
              badge={settings.assignByBranch ? "Branch-aware" : "Global only"}
              hint={!settings.enabled ? "This preference will apply when automatic distribution is turned on." : null}
            />
          </section>

          <section className="mt-5 grid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white shadow-[0_8px_24px_rgba(24,39,33,0.03)] sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-[var(--color-border)]">
            <Metric label="Eligible Sales" value={String(accounts.length)} />
            <Metric label="Routing mode" value={settings.assignByBranch ? "Branch-aware" : "Global only"} />
            <Metric label="Open unassigned" value={String(unassigned.openUnassignedCount)} />
            <Metric label="Owner continuity" value="Sticky" />
          </section>

          {attentionItems.length > 0 && (
            <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-[0_8px_24px_rgba(24,39,33,0.03)] sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Needs attention</p>
                  <h2 className="mt-1 text-sm font-bold">Routing health</h2>
                </div>
                {permissions?.manage_users && (
                  <Link to="/settings/team" className="text-xs font-semibold text-[var(--color-primary)] hover:underline">
                    Team & Access
                  </Link>
                )}
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {attentionItems.map((item) => (
                  <AttentionItem key={item.title} {...item} />
                ))}
              </div>
            </section>
          )}

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Sales pools</p>
                  <h2 className="mt-1 font-display text-lg font-bold">Who can receive a lead?</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--color-text-muted)]">
                    {settings.assignByBranch
                      ? "Known branches use their matching pool first. Unknown branches, or branches with no eligible salesperson, fall back to the global pool."
                      : "Branch is ignored for ownership. Every new lead rotates through the global pool, even when a branch is already recorded."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={refreshAccounts}
                  disabled={refreshing}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold hover:bg-[var(--color-bg)] disabled:opacity-50"
                >
                  {refreshing && <Spinner className="h-3.5 w-3.5" />}
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <PoolSummary
                  name="Global Sales pool"
                  count={accounts.length}
                  active
                  note={settings.assignByBranch
                    ? "Fallback for leads without a usable branch pool."
                    : "Used for every automatically assigned lead."}
                />
                {branchPools.map((pool) => (
                  <PoolSummary
                    key={pool.branchName}
                    name={pool.branchName}
                    count={pool.accounts.length}
                    active={settings.assignByBranch}
                    note={!settings.assignByBranch
                      ? "Not used for ownership while branch routing is off."
                      : pool.accounts.length > 1
                        ? "Round robin within this branch."
                        : pool.accounts.length === 1
                          ? "Direct assignment for this branch."
                          : "Falls back to the global pool."}
                  />
                ))}
              </div>

              <div className="mt-6 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Eligible Sales accounts</h3>
                {permissions?.manage_users && (
                  <Link to="/settings/team" className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline">
                    Configure team
                  </Link>
                )}
              </div>

              <div className="mt-3 divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)]">
                {accounts.length > 0 ? accounts.map((account) => (
                  <div key={account.id} className="flex items-center gap-3 bg-white px-3.5 py-3">
                    <Avatar name={account.displayName} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{account.displayName}</p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">@{account.username}</p>
                    </div>
                    <div className="text-right">
                      <p className="max-w-44 truncate text-[11px] font-semibold" title={account.branchName || "No fixed branch"}>
                        {account.branchName || "No fixed branch"}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {settings.assignByBranch && account.branchName ? "Branch + global pool" : "Global pool"}
                      </p>
                    </div>
                  </div>
                )) : (
                  <div className="bg-[var(--color-bg)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
                    No Sales accounts are eligible yet.
                  </div>
                )}
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)]">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Assignment flow</p>
                <h2 className="mt-1 font-display text-sm font-bold">What happens to a new lead</h2>
                <div className="mt-4 space-y-3">
                  <FlowStep number="1" title="New lead arrives" text="The customer message is stored first, then the lead is created." />
                  <FlowStep
                    number="2"
                    title={settings.assignByBranch ? "Choose the right pool" : "Use the global pool"}
                    text={settings.assignByBranch
                      ? "If a branch is already known, use that branch pool. Otherwise use the global Sales pool."
                      : "Branch does not affect ownership. Round robin uses all eligible Sales accounts."}
                  />
                  <FlowStep number="3" title="Keep the owner" text="Later branch changes or AI updates never move the lead to another salesperson." />
                </div>
              </section>

              {unassigned.openUnassignedCount > 0 && (
                <section className="rounded-2xl border border-[var(--color-accent)]/30 bg-white p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-display text-sm font-bold">Unassigned leads</h2>
                    <span className="rounded-full bg-[var(--color-accent-light)] px-2 py-0.5 text-[10px] font-bold">{unassigned.openUnassignedCount}</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                    {unassigned.recoverableUnassignedCount} can be safely assigned. {unassigned.manualUnassignedCount > 0 ? `${unassigned.manualUnassignedCount} ${unassigned.manualUnassignedCount === 1 ? "was" : "were"} deliberately left unassigned by staff.` : "Staff-cleared owners are never recovered automatically."}
                  </p>
                  <button
                    type="button"
                    onClick={recoverUnassignedLeads}
                    disabled={recovering || !savedEnabled || !canManageDistribution || accounts.length === 0 || unassigned.recoverableUnassignedCount === 0}
                    className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {recovering && <Spinner className="h-3.5 w-3.5" />}
                    {recovering ? "Assigning…" : "Assign never-owned leads"}
                  </button>
                </section>
              )}

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Branch data</p>
                    <h2 className="mt-1 font-display text-sm font-bold">AI branch recording</h2>
                  </div>
                  <StatusDot enabled={aiBranchRecording.enabled} />
                </div>
                <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {aiBranchRecording.enabled
                    ? "AI can fill a blank branch after the conversation is analyzed. This never changes the Sales owner."
                    : "Branch can still be edited by staff. Enable Lead Scoring or Telegram summaries if you also want AI to record a clear branch preference."}
                </p>
                <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-text-muted)]">
                  <StatusLine label="Lead Scoring" enabled={aiBranchRecording.leadScoringEnabled} />
                  <StatusLine label="Telegram summaries" enabled={aiBranchRecording.telegramSummaryEnabled} />
                </div>
              </section>
            </aside>
          </div>

          <details className="mt-5 rounded-2xl border border-[var(--color-border)] bg-white px-5 py-4 text-xs text-[var(--color-text-muted)]">
            <summary className="cursor-pointer select-none font-semibold text-[var(--color-text)]">Advanced behavior & safeguards</summary>
            <div className="mt-4 grid gap-4 leading-5 md:grid-cols-2">
              <ul className="space-y-2">
                <li>• Round robin uses durable PostgreSQL cursors, so restarts do not reset the rotation.</li>
                <li>• Disabled or ineligible Sales accounts are skipped.</li>
                <li>• A manually selected owner is never overwritten by automation.</li>
                <li>• A manually cleared owner stays unassigned until staff changes it.</li>
              </ul>
              <ul className="space-y-2">
                <li>• Branch routing only affects ownership when the branch is already known at lead creation.</li>
                <li>• A later AI or staff branch correction is CRM data only and never reroutes ownership.</li>
                <li>• If branch routing is on but a branch has no eligible salesperson, the lead falls back to the global pool.</li>
                <li>• If no eligible Sales account exists at all, the chatbot continues and the lead remains recoverable.</li>
              </ul>
            </div>
          </details>
        </div>
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
            <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">
              {hasUnsavedChanges ? "You have unsaved routing changes" : "All routing changes saved"}
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/tools" className="inline-flex items-center justify-center rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--color-bg)]">
              Back to Tools
            </Link>
            <button
              type="button"
              onClick={save}
              disabled={saving || !hasUnsavedChanges || !canManageDistribution}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Spinner />}
              {saving ? "Saving…" : "Save routing"}
            </button>
          </div>
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
  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {unsaved ? "Unsaved" : active ? "Active" : "Paused"}
    </span>
  );
}

function SettingToggle({ title, description, checked, disabled, onChange, badge, hint }) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="max-w-3xl pr-0 sm:pr-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold">{title}</h3>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${checked ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
            {badge}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">{description}</p>
        {hint && <p className="mt-1.5 text-[10px] font-medium text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={title}
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className={`relative h-8 w-14 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
      >
        <span aria-hidden="true" className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-7" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="border-b border-[var(--color-border)] px-4 py-4 last:border-b-0 sm:px-5 lg:border-b-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1.5 text-sm font-bold text-[var(--color-text)]">{value}</p>
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

function Avatar({ name }) {
  const initial = String(name || "S").trim().charAt(0).toUpperCase() || "S";
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-xs font-bold text-[var(--color-primary)]">
      {initial}
    </span>
  );
}

function FlowStep({ number, title, text }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-light)] text-[10px] font-bold text-[var(--color-primary)]">{number}</span>
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{text}</p>
      </div>
    </div>
  );
}

function StatusDot({ enabled }) {
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold ${enabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-text-muted)]"}`} />
      {enabled ? "Available" : "Off"}
    </span>
  );
}

function StatusLine({ label, enabled }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${enabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
        {enabled ? "On" : "Off"}
      </span>
    </div>
  );
}
