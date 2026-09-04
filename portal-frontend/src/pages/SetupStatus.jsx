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

const AI_KEY_STATUS = {
  ready: { label: "Succeeded last attempt", badge: "bg-[var(--color-primary-light)] text-[var(--color-primary)]" },
  rate_limited: { label: "Rate limited last attempt", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  unavailable: { label: "Unavailable last attempt", badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]" },
  invalid: { label: "Credentials rejected", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  failed: { label: "Failed last attempt", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  not_checked: { label: "Not checked", badge: "bg-[var(--color-bg)] text-[var(--color-text-muted)]" },
};

const SETUP_KEY_STATUS = {
  ready: { label: "Accessible", badge: "bg-[var(--color-primary-light)] text-[var(--color-primary)]" },
  rate_limited: { label: "Metadata rate limited", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  unavailable: { label: "Metadata unavailable", badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]" },
  invalid: { label: "Credentials rejected", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  failed: { label: "Metadata check failed", badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]" },
  not_checked: { label: "Not checked", badge: "bg-[var(--color-bg)] text-[var(--color-text-muted)]" },
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
  const [announcement, setAnnouncement] = useState("");

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
    setAnnouncement("Running all connection checks.");
    try {
      const nextData = await api.runSetupChecks();
      setData(nextData);
      const attention = Number(nextData?.summary?.attention) || 0;
      setAnnouncement(
        attention > 0
          ? `Connection checks complete. ${attention} ${attention === 1 ? "check needs" : "checks need"} attention.`
          : "Connection checks complete. No connection issues were found."
      );
    } catch (err) {
      setError(err.message || "Couldn't run setup checks.");
      setAnnouncement("Connection checks could not be completed.");
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
  const hasMetaMessaging = (data.checks || []).some(
    (check) => ["facebook", "instagram"].includes(check.key) && check.configured
  );
  const requiredAttention = (data.checks || []).filter(
    (check) => !check.optional && ["warning", "error"].includes(check.status)
  ).length;
  const optionalAttention = (data.checks || []).filter(
    (check) => check.optional && ["warning", "error"].includes(check.status)
  ).length;
  const attentionBreakdown = [
    requiredAttention ? `${requiredAttention} required` : null,
    optionalAttention ? `${optionalAttention} optional` : null,
  ].filter(Boolean).join(" · ") || "Nothing flagged";

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-white px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Setup status</h1>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${allRequiredReady ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)] text-[var(--color-text)]"}`}>
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
              aria-busy={running}
              className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] disabled:cursor-wait disabled:opacity-65 sm:w-auto"
            >
              {running ? <Spinner className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
              {running ? "Checking connections…" : "Run all checks"}
            </button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-[var(--color-text-muted)] sm:text-xs">
            <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" />
            <p>Credentials remain on the server, these checks never message customers, and Gemini setup checks use model metadata only.</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
        {error && (
          <div role="alert" className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
          <SummaryCard label="Required ready" value={`${summary.requiredReady || 0}/${summary.requiredTotal || 0}`} tone="primary" />
          <SummaryCard label="Needs attention" value={summary.attention || 0} hint={attentionBreakdown} tone={summary.attention ? "warning" : "neutral"} />
          <SummaryCard label="Optional not set up" value={summary.optionalNotConfigured || 0} tone="neutral" />
          <SummaryCard label="Last run" value={data.lastRunAt ? formatTime(data.lastRunAt) : "Not yet"} hint="Malaysia time" compact />
        </section>

        {groups.map((group) => (
          <section key={group.name}>
            <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
              <h2 className="font-display text-sm font-bold sm:text-base">{group.name}</h2>
              <span className="text-right text-[11px] leading-4 text-[var(--color-text-muted)]">
                {groupStatusLabel(group.checks)}
              </span>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.checks.map((check) => <ConnectionCard key={check.key} check={check} />)}
            </div>
            {group.name === "Messaging channels" && hasMetaMessaging && <MetaReviewNote />}
          </section>
        ))}
      </main>
    </div>
  );
}

function ConnectionCard({ check }) {
  const style = STATUS_STYLE[check.status] || STATUS_STYLE.warning;
  const awaitingActivity = check.status === "warning" && [
    "facebook",
    "instagram",
    "whatsapp_webhook",
    "meta_webhook",
  ].includes(check.key);
  return (
    <article className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
          <h3 className="truncate text-sm font-bold">{check.label}</h3>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${style.badge}`}>
          {awaitingActivity ? "Awaiting activity" : style.label}
        </span>
      </div>

      <p className="mt-3 min-h-10 text-xs leading-5 text-[var(--color-text-muted)]">{check.summary}</p>

      {check.key === "ai" && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <MiniBadge text={`Preferred: ${check.aiProvider || "gemini"}`} />
            <MiniBadge text={`${check.geminiKeyCount || 0} Gemini key${check.geminiKeyCount === 1 ? "" : "s"}`} />
            {check.claudeFallback && <MiniBadge text="Claude available" />}
          </div>
          <AiKeyHealth
            candidates={check.candidateHealth || []}
            metadataMode={check.setupCheckMode === "model_metadata"}
          />
        </>
      )}
      {check.displayValue && <p className="mt-3 truncate rounded-lg bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">{check.displayValue}</p>}

      <dl className="mt-4 space-y-1.5 border-t border-[var(--color-border)]/70 pt-3 text-[11px] text-[var(--color-text-muted)]">
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
        {check.lastActivityAt && (
          <div className="flex items-start justify-between gap-3">
            <dt>Latest customer message</dt>
            <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(check.lastActivityAt)}</dd>
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

function AiKeyHealth({ candidates, metadataMode }) {
  if (!candidates.length) return null;
  return (
    <details className="group mt-3 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs font-bold text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/30 [&::-webkit-details-marker]:hidden">
        <span>View AI key checks</span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-[var(--color-border)] bg-white p-2.5">
        {candidates.map((candidate) => {
          const runtimeStyle = AI_KEY_STATUS[candidate.status] || AI_KEY_STATUS.not_checked;
          const setup = candidate.setupCheck || { status: "not_checked" };
          const setupStyle = SETUP_KEY_STATUS[setup.status] || SETUP_KEY_STATUS.not_checked;
          const showSetupCheck = metadataMode && candidate.provider === "gemini";
          return (
            <div key={`${candidate.provider}:${candidate.label}`} className="rounded-lg border border-[var(--color-border)]/70 px-2.5 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-[var(--color-text)]">{candidate.label}</span>
                {showSetupCheck && (
                  <span className={`max-w-full rounded-full px-2 py-1 text-[11px] font-bold leading-4 ${setupStyle.badge}`}>
                    {setupStyle.label}
                  </span>
                )}
              </div>

              {showSetupCheck && (
                <div className="mt-2 rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Setup check</p>
                  <dl className="mt-1.5 space-y-1 text-[11px] text-[var(--color-text-muted)]">
                    <div className="flex items-start justify-between gap-2">
                      <dt>Last setup check</dt>
                      <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(setup.checkedAt)}</dd>
                    </div>
                    {setup.successAt && (
                      <div className="flex items-start justify-between gap-2">
                        <dt>Last successful setup check</dt>
                        <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(setup.successAt)}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              <div className={showSetupCheck ? "mt-2.5" : "mt-2"}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Runtime history</p>
                  <span className={`max-w-full rounded-full px-2 py-1 text-[10px] font-bold leading-4 ${runtimeStyle.badge}`}>
                    {runtimeStyle.label}
                  </span>
                </div>
                {candidate.lastAttemptAt ? (
                  <dl className="mt-1.5 space-y-1 text-[11px] text-[var(--color-text-muted)]">
                    <div className="flex items-start justify-between gap-2">
                      <dt>Last runtime attempt</dt>
                      <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(candidate.lastAttemptAt)}</dd>
                    </div>
                    {candidate.lastSuccessAt && (
                      <div className="flex items-start justify-between gap-2">
                        <dt>Last runtime success</dt>
                        <dd className="text-right font-medium text-[var(--color-text)]">{formatTime(candidate.lastSuccessAt)}</dd>
                      </div>
                    )}
                    {candidate.lastRateLimitedAt && (
                      <div className="flex items-start justify-between gap-2">
                        <dt>Last rate limited</dt>
                        <dd className="text-right font-medium text-[var(--color-danger)]">{formatTime(candidate.lastRateLimitedAt)}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-5 text-[var(--color-text-muted)]">No runtime AI attempt recorded yet.</p>
                )}
              </div>
            </div>
          );
        })}
        <p className="px-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
          Run all checks refreshes every configured Gemini key using model metadata only. It does not generate AI text or consume prompt/output tokens. Runtime history comes from real AI traffic and is kept separately.
        </p>
      </div>
    </details>
  );
}

function MetaReviewNote() {
  return (
    <details className="group mt-2.5 overflow-hidden rounded-xl border border-[var(--color-border)] bg-white shadow-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/30 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <InfoIcon className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>About Meta app review</span>
        </span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <p className="border-t border-[var(--color-border)] px-3.5 py-3 text-[11px] leading-5 text-[var(--color-text-muted)] sm:text-xs">
        Facebook and Instagram checks confirm configured credentials and real customer messaging activity. They cannot confirm that Meta has approved public messaging access.
      </p>
    </details>
  );
}

function groupStatusLabel(checks) {
  const ready = checks.filter((check) => check.status === "ready").length;
  const attention = checks.filter((check) => ["warning", "error"].includes(check.status)).length;
  const optionalNotSetUp = checks.filter(
    (check) => check.optional && check.status === "not_configured"
  ).length;
  return [
    ready ? `${ready} ready` : null,
    attention ? `${attention} ${attention === 1 ? "needs" : "need"} attention` : null,
    optionalNotSetUp ? `${optionalNotSetUp} optional not set up` : null,
  ].filter(Boolean).join(" · ") || "No checks available";
}

function SummaryCard({ label, value, hint = null, tone = "neutral", compact = false }) {
  const valueClass = tone === "primary"
    ? "text-[var(--color-primary)]"
    : tone === "warning"
      ? "text-[var(--color-danger)]"
    : "text-[var(--color-text)]";
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-white p-3.5 shadow-sm sm:p-4">
      <p className="text-[11px] font-semibold leading-4 text-[var(--color-text-muted)] sm:text-xs">{label}</p>
      <p className={`mt-1.5 font-display font-bold ${compact ? "text-xs leading-5 sm:text-sm" : "text-xl sm:text-2xl"} ${valueClass}`}>{value}</p>
      {hint && <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function MiniBadge({ text }) {
  return <span className="rounded-lg bg-[var(--color-bg)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-muted)]">{text}</span>;
}

function RefreshIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 11a8 8 0 1 0 2 5" strokeLinecap="round" /><path d="M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ShieldIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinejoin="round" /><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function InfoIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" strokeLinecap="round" /></svg>;
}

function ChevronIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
