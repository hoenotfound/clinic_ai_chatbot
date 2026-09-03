import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "../components/Spinner";

const GROUP_ORDER = ["Core system", "AI", "Messaging channels", "Supporting services"];

const STATUS_STYLE = {
  ready: {
    label: "Ready",
    dot: "bg-[var(--color-primary)]",
    badge: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
  },
  warning: {
    label: "Check needed",
    dot: "bg-[var(--color-accent)]",
    badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]",
  },
  error: {
    label: "Needs attention",
    dot: "bg-[var(--color-danger)]",
    badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
  },
  not_configured: {
    label: "Not configured",
    dot: "bg-[var(--color-border)]",
    badge: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
  },
};

function formatTime(value) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function SetupStatus() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getSetupStatus()
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Couldn't load setup status.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const checks = data?.checks || [];
    return GROUP_ORDER.map((name) => ({
      name,
      checks: checks.filter((check) => check.group === name),
    })).filter((group) => group.checks.length > 0);
  }, [data]);

  async function runChecks() {
    if (running) return;
    setRunning(true);
    setError("");
    try {
      setData(await api.runSetupChecks());
    } catch (err) {
      setError(err.message || "Couldn't run setup checks.");
    } finally {
      setRunning(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)]">
        <Spinner className="h-7 w-7 text-[var(--color-primary)]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-white p-6 text-center shadow-sm">
          <h1 className="font-display text-lg font-bold">Couldn't load setup status</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-danger)]">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white">Try again</button>
        </div>
      </div>
    );
  }

  const summary = data.summary || {};
  const allRequiredReady = summary.requiredTotal > 0 && summary.requiredReady === summary.requiredTotal;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-white px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-2xl font-bold sm:text-3xl">Setup status</h1>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${allRequiredReady ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)] text-[var(--color-text)]"}`}>
                {allRequiredReady ? "Core setup ready" : "Check setup"}
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
              Confirm this clinic's database, AI, messaging channels and supporting services before going live.
            </p>
          </div>
          <button
            type="button"
            onClick={runChecks}
            disabled={running}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] disabled:cursor-wait disabled:opacity-65 sm:w-auto"
          >
            {running ? <Spinner className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
            {running ? "Checking connections…" : "Run all checks"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        {error && (
          <div className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
          <SummaryCard label="Required ready" value={`${summary.requiredReady || 0}/${summary.requiredTotal || 0}`} tone="primary" />
          <SummaryCard label="Need checking" value={summary.attention || 0} tone={summary.attention ? "warning" : "neutral"} />
          <SummaryCard label="Optional unused" value={summary.optionalNotConfigured || 0} tone="neutral" />
          <SummaryCard label="Last run" value={data.lastRunAt ? formatTime(data.lastRunAt) : "Not yet"} compact />
        </section>

        <div className="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3.5 shadow-sm">
          <ShieldIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" />
          <div>
            <p className="text-xs font-bold">Credentials stay private</p>
            <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
              Tokens, passwords and API keys are checked only by the server. They are never returned to this page. Connection tests do not message customers.
            </p>
          </div>
        </div>

        {groups.map((group) => (
          <section key={group.name}>
            <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
              <h2 className="font-display text-sm font-bold sm:text-base">{group.name}</h2>
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {group.checks.filter((check) => check.status === "ready").length}/{group.checks.length} ready
              </span>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.checks.map((check) => <ConnectionCard key={check.key} check={check} />)}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function ConnectionCard({ check }) {
  const style = STATUS_STYLE[check.status] || STATUS_STYLE.warning;
  return (
    <article className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
          <h3 className="truncate text-sm font-bold">{check.label}</h3>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${style.badge}`}>
          {style.label}
        </span>
      </div>

      <p className="mt-3 min-h-10 text-xs leading-5 text-[var(--color-text-muted)]">{check.summary}</p>

      {check.key === "ai" && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <MiniBadge text={`Preferred: ${check.aiProvider || "gemini"}`} />
          <MiniBadge text={`${check.geminiKeyCount || 0} Gemini key${check.geminiKeyCount === 1 ? "" : "s"}`} />
          {check.claudeFallback && <MiniBadge text="Claude available" />}
        </div>
      )}
      {check.displayValue && <p className="mt-3 truncate rounded-lg bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">{check.displayValue}</p>}

      <dl className="mt-4 space-y-1.5 border-t border-[var(--color-border)]/70 pt-3 text-[10px] text-[var(--color-text-muted)]">
        <div className="flex items-start justify-between gap-3">
          <dt>Last checked</dt>
          <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(check.checkedAt)}</dd>
        </div>
        {check.lastSuccessAt && (
          <div className="flex items-start justify-between gap-3">
            <dt>Last successful</dt>
            <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(check.lastSuccessAt)}</dd>
          </div>
        )}
        {check.lastWebhookAt && (
          <div className="flex items-start justify-between gap-3">
            <dt>Latest webhook</dt>
            <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(check.lastWebhookAt)}</dd>
          </div>
        )}
        {check.optional && (
          <div className="flex items-start justify-between gap-3">
            <dt>Requirement</dt>
            <dd className="text-right font-medium text-[var(--color-text)]">Optional</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function SummaryCard({ label, value, tone = "neutral", compact = false }) {
  const valueClass = tone === "primary"
    ? "text-[var(--color-primary)]"
    : tone === "warning"
      ? "text-[var(--color-danger)]"
      : "text-[var(--color-text)]";
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-white p-3.5 shadow-sm sm:p-4">
      <p className="text-[10px] font-semibold text-[var(--color-text-muted)] sm:text-xs">{label}</p>
      <p className={`mt-1.5 font-display font-bold ${compact ? "text-xs leading-5 sm:text-sm" : "text-xl sm:text-2xl"} ${valueClass}`}>{value}</p>
    </div>
  );
}

function MiniBadge({ text }) {
  return <span className="rounded-lg bg-[var(--color-bg)] px-2 py-1 text-[9px] font-semibold text-[var(--color-text-muted)]">{text}</span>;
}

function RefreshIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 11a8 8 0 1 0 2 5" strokeLinecap="round" /><path d="M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ShieldIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinejoin="round" /><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
