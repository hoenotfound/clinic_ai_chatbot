import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";

const DEFAULT_SETTINGS = {
  enabled: false,
  strategy: "round_robin",
};

const DEFAULT_AI_BRANCH_RECORDING = {
  enabled: false,
  leadScoringEnabled: false,
  telegramSummaryEnabled: false,
};

export default function LeadDistribution() {
  const { permissions } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SETTINGS);
  const [accounts, setAccounts] = useState([]);
  const [configuredBranches, setConfiguredBranches] = useState([]);
  const [aiBranchRecording, setAiBranchRecording] = useState(DEFAULT_AI_BRANCH_RECORDING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  function applyStatus(status) {
    setAccounts(Array.isArray(status?.accounts) ? status.accounts : []);
    setConfiguredBranches(
      Array.isArray(status?.configuredBranches) ? status.configuredBranches : []
    );
    setAiBranchRecording({
      ...DEFAULT_AI_BRANCH_RECORDING,
      ...(status?.aiBranchRecording || {}),
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
    () => settings.enabled !== savedSettings.enabled,
    [settings.enabled, savedSettings.enabled]
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

  async function save() {
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
        },
      });
      const current = {
        ...DEFAULT_SETTINGS,
        ...(updated.leadDistribution || {}),
        strategy: "round_robin",
      };
      setSettings(current);
      setSavedSettings(current);
      showToast(
        current.enabled
          ? "Automatic lead distribution is active."
          : "Automatic lead distribution is paused.",
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

  const savedEnabled = savedSettings.enabled === true;
  const pendingState = hasUnsavedChanges
    ? settings.enabled
      ? "Will activate after saving"
      : "Will pause after saving"
    : savedEnabled
      ? "Currently active"
      : "Currently paused";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl pb-10">
          <div className="mb-5 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Link to="/tools" className="font-semibold text-[var(--color-primary)] hover:underline">Tools</Link>
            <span>/</span>
            <span>Lead distribution</span>
          </div>

          <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">Tools</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Automatic Lead Distribution</h1>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${hasUnsavedChanges ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : savedEnabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"}`}>
                  {hasUnsavedChanges ? "Unsaved" : savedEnabled ? "Active" : "Paused"}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                Assign each new lead to a Sales account immediately and keep that owner stable. If a trusted branch is already known when the lead is created, that branch pool is used first. Otherwise the lead starts in the global Sales rotation. A later AI summary may record the customer's chosen branch without moving the conversation to another salesperson.
              </p>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(24,39,33,0.04)] sm:min-w-56">
              <div>
                <p className="text-xs font-semibold">Automation</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{pendingState}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Enable automatic lead distribution"
                aria-checked={settings.enabled}
                onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))}
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${settings.enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
              >
                <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${settings.enabled ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </header>

          <section className="mt-7 grid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:grid-cols-3 sm:divide-x sm:divide-[var(--color-border)]">
            <Overview label="Assignment" value="Immediate" />
            <Overview label="Owner continuity" value="No automatic rerouting" />
            <Overview label="Branch record" value={aiBranchRecording.enabled ? "AI summary + staff edit" : "Staff edit until AI analysis is enabled"} />
          </section>

          {!aiBranchRecording.enabled && (
            <section className="mt-5 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-4 text-sm">
              <p className="font-semibold">AI branch recording is currently inactive.</p>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Lead assignment still works normally. The branch stays blank until staff edits it unless Lead Scoring or Telegram conversation summaries are enabled, because those existing conversation analyses produce the structured AI summary used for branch recording.
              </p>
            </section>
          )}

          {accounts.length === 0 && (
            <section className="mt-5 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-4 text-sm">
              <p className="font-semibold">No eligible Sales accounts are available.</p>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                The account must be active, use the Sales role, and be allowed to view and reply to assigned leads.
              </p>
              {permissions.manage_users && (
                <Link to="/settings/team" className="mt-3 inline-flex text-xs font-semibold text-[var(--color-primary)] hover:underline">
                  Open Team & Access
                </Link>
              )}
            </section>
          )}

          {staleBranchAccounts.length > 0 && (
            <section className="mt-5 rounded-2xl border border-[var(--color-danger)]/20 bg-white p-4 text-sm">
              <p className="font-semibold text-[var(--color-danger)]">Some Sales accounts use an old branch name.</p>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Update these accounts in Team & Access so branch-specific routing can recognize them: {staleBranchAccounts.map((account) => account.displayName).join(", ")}.
              </p>
            </section>
          )}

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)]">
            <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold">Sales routing pools</h2>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    The global pool contains every eligible Sales account. A branch-specific pool contains only Sales accounts assigned to that branch in Team & Access.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={refreshAccounts}
                  disabled={refreshing}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-50"
                >
                  {refreshing && <Spinner className="h-3.5 w-3.5" />}
                  {refreshing ? "Refreshing…" : "Refresh status"}
                </button>
              </div>

              {permissions.manage_users && (
                <Link to="/settings/team" className="mt-4 inline-flex items-center rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)] hover:bg-[var(--color-bg)]">
                  Configure Sales branches in Team & Access
                </Link>
              )}

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <PoolSummary
                  name="Global pool"
                  count={accounts.length}
                  note="Used when no trusted branch exists at lead creation."
                />
                {branchPools.map((pool) => (
                  <PoolSummary
                    key={pool.branchName}
                    name={pool.branchName}
                    count={pool.accounts.length}
                    note={pool.accounts.length > 1 ? "Round robin within this branch." : pool.accounts.length === 1 ? "Direct assignment when branch is known." : "No fixed Sales account for this branch."}
                  />
                ))}
              </div>

              <h3 className="mt-6 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Eligible accounts</h3>
              <div className="mt-3 space-y-2">
                {accounts.length > 0 ? accounts.map((account, index) => (
                  <div key={account.id} className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-xs font-bold text-[var(--color-primary)] shadow-sm">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{account.displayName}</p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">@{account.username}</p>
                    </div>
                    <span className="max-w-44 truncate rounded-full bg-[var(--color-primary-light)] px-2 py-1 text-[10px] font-semibold text-[var(--color-primary)]" title={account.branchName || "No fixed branch"}>
                      {account.branchName || "No fixed branch"}
                    </span>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
                    No Sales accounts are eligible yet.
                  </div>
                )}
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)]">
                <h2 className="font-display text-sm font-bold">How a lead is assigned</h2>
                <ol className="mt-4 space-y-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  <Step number="1" text="The chatbot stores the customer message first, then creates the lead and assigns an owner immediately." />
                  <Step number="2" text="If a trusted structured branch already exists at creation, one Sales account is assigned directly or multiple accounts rotate within that branch." />
                  <Step number="3" text="If no branch is known yet, the lead uses the global round-robin rotation across every eligible Sales account." />
                  <Step number="4" text="A later conversation summary may fill a blank branch record using the exact configured clinic branch name. This is record-keeping only and never changes the owner." />
                </ol>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <h2 className="font-display text-sm font-bold">Built-in safeguards</h2>
                <ul className="mt-3 space-y-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  <li>• Customer message storage has no branch-routing trigger.</li>
                  <li>• A later AI or staff branch change never changes the Sales owner.</li>
                  <li>• A manually selected owner is never overwritten by automatic distribution.</li>
                  <li>• AI branch recording accepts only an exact configured branch returned by the structured summary.</li>
                  <li>• Disabled accounts, Admin accounts, and Sales accounts without lead viewing or reply access are skipped.</li>
                  <li>• Existing leads are not redistributed just because you enable the tool.</li>
                  <li>• If no eligible Sales account exists at all, the lead stays unassigned instead of blocking the chatbot.</li>
                </ul>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <h2 className="font-display text-sm font-bold">AI branch recording</h2>
                <div className="mt-3 space-y-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  <StatusLine label="Available" enabled={aiBranchRecording.enabled} />
                  <StatusLine label="Lead Scoring" enabled={aiBranchRecording.leadScoringEnabled} />
                  <StatusLine label="Telegram summaries" enabled={aiBranchRecording.telegramSummaryEnabled} />
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
            <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">
              {hasUnsavedChanges ? "You have unsaved changes" : "All changes saved"}
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/tools" className="inline-flex items-center justify-center rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm font-semibold">
              Back to Tools
            </Link>
            <button
              type="button"
              onClick={save}
              disabled={saving || !hasUnsavedChanges}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Spinner />}
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </footer>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function Overview({ label, value }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1.5 text-sm font-semibold text-[var(--color-text)]">{value}</p>
    </div>
  );
}

function PoolSummary({ name, count, note }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs font-semibold">{name}</p>
        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">{count}</span>
      </div>
      <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{note}</p>
    </div>
  );
}

function Step({ number, text }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary-light)] text-[10px] font-bold text-[var(--color-primary)]">{number}</span>
      <span>{text}</span>
    </li>
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
