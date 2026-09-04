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

const HEALTH_STYLE = {
  healthy: {
    label: "Healthy",
    dot: "bg-[var(--color-primary)]",
    badge: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    border: "border-[var(--color-primary)]/20",
  },
  warning: {
    label: "Check needed",
    dot: "bg-[var(--color-accent)]",
    badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]",
    border: "border-[var(--color-accent)]/30",
  },
  error: {
    label: "Needs attention",
    dot: "bg-[var(--color-danger)]",
    badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
    border: "border-[var(--color-danger)]/25",
  },
  not_configured: {
    label: "Not configured",
    dot: "bg-[var(--color-border)]",
    badge: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
    border: "border-[var(--color-border)]",
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

const PASSIVE_ACTIVITY_KEYS = new Set([
  "facebook",
  "instagram",
  "whatsapp_webhook",
  "meta_webhook",
]);

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

function formatRelativeTime(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No activity yet";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return formatTime(value);
}

function formatDuration(seconds) {
  if (seconds == null) return "Unavailable";
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${Math.floor(value)} sec`;
  if (value < 3600) return `${Math.floor(value / 60)} min`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function isPassiveActivityWarning(check) {
  return check?.status === "warning" && PASSIVE_ACTIVITY_KEYS.has(check.key);
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
      const overall = nextData?.systemHealth?.overall;
      setAnnouncement(
        overall?.status === "error"
          ? "Connection checks complete. System health needs attention."
          : overall?.status === "warning"
            ? "Connection checks complete. System health has something to review."
            : "Connection checks complete. System health is healthy."
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
  const systemHealth = data.systemHealth || null;
  const overall = systemHealth?.overall || null;
  const overallStyle = HEALTH_STYLE[overall?.status] || HEALTH_STYLE.warning;
  const hasMetaMessaging = (data.checks || []).some(
    (check) => ["facebook", "instagram"].includes(check.key) && check.configured
  );
  const actionableChecks = (data.checks || []).filter(
    (check) => ["warning", "error"].includes(check.status) && !isPassiveActivityWarning(check)
  );
  const requiredAttention = actionableChecks.filter((check) => !check.optional).length;
  const optionalAttention = actionableChecks.filter((check) => check.optional).length;
  const attentionBreakdown = [
    requiredAttention ? `${requiredAttention} required` : null,
    optionalAttention ? `${optionalAttention} optional` : null,
  ].filter(Boolean).join(" · ") || "Nothing actionable";

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-white px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Setup status</h1>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${overallStyle.badge}`}>
                  {overall?.label || "Health loading"}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                See whether this client's chatbot is working now, then drill into connection checks only when something needs review.
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

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
        {error && (
          <div role="alert" className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <section>
          <SectionHeading title="System health" subtitle="Live operational signals, not just configuration checks." />
          {systemHealth ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <DatabaseHealthCard health={systemHealth.database} />
              <InboundHealthCard health={systemHealth.inbound} />
              <AiHealthCard health={systemHealth.ai} />
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-text-muted)] shadow-sm">
              Operational health metrics are temporarily unavailable. Connection checks below are still usable.
            </div>
          )}
        </section>

        {systemHealth?.messaging?.length > 0 && (
          <section>
            <SectionHeading
              title="Messaging"
              subtitle="Real inbound and outbound activity is stronger evidence than a superficial connection check. No recent inbound is not an error."
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {systemHealth.messaging.map((channel) => (
                <MessagingHealthCard key={channel.channel} health={channel} />
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <div>
              <h2 className="font-display text-base font-bold sm:text-lg">Connection checks</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Manual setup diagnostics. An inactive but correctly configured channel may show Awaiting activity without being unhealthy.
              </p>
            </div>
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Last run: {data.lastRunAt ? formatTime(data.lastRunAt) : "Not yet"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
            <SummaryCard label="Required ready" value={`${summary.requiredReady || 0}/${summary.requiredTotal || 0}`} tone="primary" />
            <SummaryCard label="Needs attention" value={actionableChecks.length} hint={attentionBreakdown} tone={actionableChecks.length ? "warning" : "neutral"} />
            <SummaryCard label="Optional not set up" value={summary.optionalNotConfigured || 0} tone="neutral" />
            <SummaryCard label="Health refreshed" value={systemHealth?.checkedAt ? formatTime(systemHealth.checkedAt) : "Unavailable"} hint="Malaysia time" compact />
          </div>
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

function SectionHeading({ title, subtitle }) {
  return (
    <div className="mb-3 px-0.5">
      <h2 className="font-display text-base font-bold sm:text-lg">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{subtitle}</p>
    </div>
  );
}

function HealthHeader({ title, status, label }) {
  const style = HEALTH_STYLE[status] || HEALTH_STYLE.warning;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
        <h3 className="truncate text-sm font-bold">{title}</h3>
      </div>
      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${style.badge}`}>
        {label || style.label}
      </span>
    </div>
  );
}

function HealthRow({ label, value, danger = false }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt>{label}</dt>
      <dd className={`text-right font-semibold ${danger ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"}`}>{value}</dd>
    </div>
  );
}

function DatabaseHealthCard({ health }) {
  const current = health?.currentVersion == null ? "—" : String(health.currentVersion).padStart(3, "0");
  const expected = health?.expectedVersion == null ? "—" : String(health.expectedVersion).padStart(3, "0");
  const state = health?.migrationState === "up_to_date"
    ? "Up to date"
    : health?.migrationState === "behind"
      ? "Behind"
      : health?.migrationState === "incompatible"
        ? "Incompatible"
        : "Unavailable";
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <HealthHeader title="Database" status={health?.status} label={health?.label} />
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{health?.summary}</p>
      <dl className="mt-4 space-y-2 border-t border-[var(--color-border)]/70 pt-3 text-[11px] text-[var(--color-text-muted)]">
        <HealthRow label="Migration version" value={current} />
        <HealthRow label="Expected version" value={expected} />
        <HealthRow label="Migration state" value={state} danger={health?.status === "error"} />
      </dl>
    </article>
  );
}

function InboundHealthCard({ health }) {
  const openCount = (Number(health?.pending) || 0) + (Number(health?.processing) || 0) + (Number(health?.retrying) || 0);
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <HealthHeader title="Inbound processing" status={health?.status} label={health?.label} />
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{health?.summary}</p>
      <dl className="mt-4 space-y-2 border-t border-[var(--color-border)]/70 pt-3 text-[11px] text-[var(--color-text-muted)]">
        <HealthRow label="Open jobs" value={health?.pending == null ? "Unavailable" : openCount} />
        <HealthRow label="Pending" value={health?.pending ?? "—"} />
        <HealthRow label="Oldest open job" value={openCount ? formatDuration(health?.oldestPendingAgeSeconds) : "None"} danger={health?.status === "error" && openCount > 0} />
        <HealthRow label="Failed jobs (24h)" value={health?.failedLast24h ?? "—"} />
        <HealthRow label="Needs staff attention" value={health?.terminalFailures ?? "—"} danger={(health?.terminalFailures || 0) > 0} />
        <HealthRow label="Restart recoveries (24h)" value={health?.restartRecoveriesLast24h ?? "—"} />
      </dl>
    </article>
  );
}

function AiHealthCard({ health }) {
  const keyCooldowns = (health?.keyHealth || []).filter((item) => item.cooldownUntil);
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <HealthHeader title="AI" status={health?.status} label={health?.label} />
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">{health?.summary}</p>
      <div className="mt-3 space-y-2">
        {(health?.geminiModels || []).map((model) => (
          <ProviderRow
            key={model.model}
            name={model.model === "gemini-2.5-flash" ? "Gemini 2.5 Flash" : model.model === "gemini-2.5-flash-lite" ? "Gemini 2.5 Flash-Lite" : model.model}
            status={model.status}
            label={model.label}
            detail={model.cooldownUntil ? `Cooldown until ${formatTime(model.cooldownUntil)}` : null}
          />
        ))}
        <ProviderRow name="Claude fallback" status={health?.claude?.status} label={health?.claude?.label} />
      </div>
      <dl className="mt-4 space-y-2 border-t border-[var(--color-border)]/70 pt-3 text-[11px] text-[var(--color-text-muted)]">
        <HealthRow label="Gemini fallbacks (24h)" value={health?.fallbacksLast24h?.geminiModel ?? "—"} />
        <HealthRow label="Claude fallbacks (24h)" value={health?.fallbacksLast24h?.claude ?? "—"} />
        <HealthRow label="Final AI failures (24h)" value={health?.failuresLast24h ?? "—"} danger={(health?.failuresLast24h || 0) > 0} />
        <HealthRow label="Gemini keys cooling down" value={keyCooldowns.length} />
      </dl>
      {keyCooldowns.length > 0 && (
        <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
          {keyCooldowns.map((item) => `${item.label} until ${formatTime(item.cooldownUntil)}`).join(" · ")}
        </p>
      )}
    </article>
  );
}

function ProviderRow({ name, status, label, detail = null }) {
  const style = HEALTH_STYLE[status] || HEALTH_STYLE.not_configured;
  return (
    <div className="rounded-xl bg-[var(--color-bg)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-bold text-[var(--color-text)]">{name}</span>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${style.badge}`}>{label || style.label}</span>
      </div>
      {detail && <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{detail}</p>}
    </div>
  );
}

function MessagingHealthCard({ health }) {
  const name = health.channel === "facebook" ? "Messenger" : health.channel === "instagram" ? "Instagram" : "WhatsApp";
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <HealthHeader title={name} status={health.status} label={health.label} />
      <p className="mt-3 min-h-10 text-xs leading-5 text-[var(--color-text-muted)]">{health.evidence}</p>
      <dl className="mt-4 space-y-2 border-t border-[var(--color-border)]/70 pt-3 text-[11px] text-[var(--color-text-muted)]">
        <HealthRow label="Last inbound" value={formatRelativeTime(health.lastInboundAt)} />
        <HealthRow label="Last successful outbound" value={health.lastSuccessfulOutboundAt ? formatRelativeTime(health.lastSuccessfulOutboundAt) : "No confirmed outbound yet"} />
        <HealthRow label="Delivery failures (24h)" value={health.recentDeliveryFailures ?? "—"} danger={(health.recentDeliveryFailures || 0) > 0 && health.status !== "healthy"} />
      </dl>
    </article>
  );
}

function ConnectionCard({ check }) {
  const style = STATUS_STYLE[check.status] || STATUS_STYLE.warning;
  const awaitingActivity = isPassiveActivityWarning(check);
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
  const awaiting = checks.filter(isPassiveActivityWarning).length;
  const attention = checks.filter(
    (check) => ["warning", "error"].includes(check.status) && !isPassiveActivityWarning(check)
  ).length;
  const optionalNotSetUp = checks.filter(
    (check) => check.optional && check.status === "not_configured"
  ).length;
  return [
    ready ? `${ready} ready` : null,
    attention ? `${attention} ${attention === 1 ? "needs" : "need"} attention` : null,
    awaiting ? `${awaiting} awaiting activity` : null,
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
