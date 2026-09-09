import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Spinner from "../components/Spinner";

const STATUS_META = {
  ready: {
    label: "Ready to go live",
    eyebrow: "Ready",
    detail: "Business setup, technical health and every purchased messaging channel have passed the go-live gate.",
    badge: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    panel: "border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/45",
  },
  ready_with_warnings: {
    label: "Ready with warnings",
    eyebrow: "Ready",
    detail: "There are no blockers, but review the non-fatal warning before handing the client over.",
    badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]",
    panel: "border-[var(--color-accent)]/30 bg-[var(--color-accent-light)]/45",
  },
  needs_testing: {
    label: "Live testing required",
    eyebrow: "Almost ready",
    detail: "Configuration is ready, but one or more purchased channels still need real customer inbound + verified AI-reply evidence.",
    badge: "bg-[var(--color-accent-light)] text-[var(--color-text)]",
    panel: "border-[var(--color-accent)]/30 bg-[var(--color-accent-light)]/45",
  },
  blocked: {
    label: "Not ready to go live",
    eyebrow: "Blocked",
    detail: "Fix the required setup or technical blockers below before client handover.",
    badge: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
    panel: "border-[var(--color-danger)]/20 bg-[var(--color-danger-light)]/45",
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

function statusText(value) {
  if (value === true) return "Ready";
  if (value === false) return "Needs attention";
  return "Unknown";
}

function Signal({ ok, label, detail }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-3">
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${ok ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)] text-[var(--color-text)]"}`}>
        {ok ? "✓" : "!"}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-bold">{label}</p>
        {detail && <p className="mt-0.5 text-[11px] leading-5 text-[var(--color-text-muted)]">{detail}</p>}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, detail }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-2 font-display text-xl font-bold">{value}</p>
      {detail && <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{detail}</p>}
    </div>
  );
}

function IssueList({ title, items, tone = "warning" }) {
  if (!items?.length) return null;
  const danger = tone === "danger";
  return (
    <section className={`rounded-2xl border p-4 ${danger ? "border-[var(--color-danger)]/20 bg-[var(--color-danger-light)]/40" : "border-[var(--color-accent)]/25 bg-[var(--color-accent-light)]/35"}`}>
      <h3 className={`text-sm font-bold ${danger ? "text-[var(--color-danger)]" : ""}`}>{title}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item, index) => (
          <div key={`${item.key || "issue"}-${index}`} className="rounded-xl bg-white px-3.5 py-3 text-xs leading-5 shadow-sm">
            {item.summary || "Readiness item needs review."}
          </div>
        ))}
      </div>
    </section>
  );
}

function ChannelCard({ channel }) {
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold">{channel.label}</p>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Purchased channel</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${channel.ready ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : channel.blockers?.length ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]" : "bg-[var(--color-accent-light)] text-[var(--color-text)]"}`}>
          {channel.ready ? "Ready" : channel.blockers?.length ? "Blocked" : "Test required"}
        </span>
      </div>

      <div className="mt-4 grid gap-2">
        <Signal ok={channel.configured} label="Configuration" detail={channel.configured ? "Required channel credentials and runtime are present." : "Required channel configuration is incomplete."} />
        <Signal ok={channel.setupReady} label="Connection checks" detail={channel.setupReady ? "Required Setup Status checks are ready." : "Connection or webhook confirmation still needs attention."} />
        <Signal ok={channel.inboundVerified} label="Real customer inbound" detail={channel.lastInboundAt ? `Observed ${formatTime(channel.lastInboundAt)}` : "No real inbound message has been verified yet."} />
        <Signal ok={channel.aiReplyVerified} label="Verified AI reply" detail={channel.lastVerifiedAutomatedReplyAt ? `Provider accepted ${formatTime(channel.lastVerifiedAutomatedReplyAt)}` : "No provider-accepted normal AI reply to the latest inbound has been verified yet."} />
      </div>
    </article>
  );
}

export default function GoLive() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getGoLiveGate()
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Couldn't load go-live readiness.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const meta = STATUS_META[data?.status] || STATUS_META.blocked;
  const incompleteBusinessItems = useMemo(() => (
    data?.businessSetup?.incomplete || []
  ), [data]);

  async function runGate() {
    if (running) return;
    setRunning(true);
    setError("");
    setAnnouncement("Running safe go-live checks.");
    try {
      const payload = await api.runGoLiveGate();
      setData(payload);
      const next = STATUS_META[payload.status] || STATUS_META.blocked;
      setAnnouncement(`Go-live checks complete. ${next.label}.`);
    } catch (err) {
      setError(err.message || "Couldn't run go-live checks.");
      setAnnouncement("Go-live checks could not be completed.");
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
          <h1 className="font-display text-lg font-bold">Couldn't load Go Live</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-danger)]">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white">Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      <header className="border-b border-[var(--color-border)] bg-white px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Go Live</h1>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${meta.badge}`}>{meta.eyebrow}</span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                One server-authoritative decision for business setup, system health and the messaging channels this client actually purchased.
              </p>
            </div>
            <button type="button" onClick={runGate} disabled={running} className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:opacity-60 sm:w-auto">
              {running && <Spinner className="h-4 w-4" />}
              {running ? "Checking…" : "Run go-live checks"}
            </button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-[var(--color-text-muted)] sm:text-xs">
            <span aria-hidden="true">🛡️</span>
            <p>This page never sends a synthetic customer message. Live proof only comes from a real inbound conversation followed by the normal AI reply path.</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        {error && <div role="alert" className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">{error}</div>}

        <section className={`rounded-3xl border p-5 shadow-sm sm:p-6 ${meta.panel}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Final handover decision</p>
              <h2 className="mt-2 font-display text-2xl font-bold">{meta.label}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{meta.detail}</p>
            </div>
            <div className="text-left sm:text-right">
              <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Gate refreshed</p>
              <p className="mt-1 text-xs font-semibold">{formatTime(data.checkedAt)}</p>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard label="Business setup" value={data.businessSetup?.ready ? "Complete" : "Incomplete"} detail={`${data.businessSetup?.completed || 0}/${data.businessSetup?.total || 0} required sections`} />
          <SummaryCard label="System" value={statusText(data.system?.ready)} detail={`${data.system?.applicationReady || 0}/${data.system?.applicationTotal || 0} required application checks`} />
          <SummaryCard label="Purchased channels" value={data.summary?.purchasedChannels || 0} detail={`${data.summary?.channelsReady || 0} fully ready`} />
          <SummaryCard label="Last technical run" value={data.lastTechnicalRunAt ? formatTime(data.lastTechnicalRunAt) : "Not yet"} detail="Malaysia time" />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-bold">Business setup</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Uses the same server-side Client Setup evaluator as the onboarding wizard.</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${data.businessSetup?.ready ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-danger-light)] text-[var(--color-danger)]"}`}>
                {data.businessSetup?.ready ? "Complete" : "Incomplete"}
              </span>
            </div>
            {incompleteBusinessItems.length > 0 ? (
              <div className="mt-4 space-y-2">
                {incompleteBusinessItems.map((item) => (
                  <div key={item.id} className="rounded-xl bg-[var(--color-bg)] px-3.5 py-3">
                    <p className="text-xs font-bold">{item.label}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{item.missing?.join(" · ") || "Required information is incomplete."}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-xl bg-[var(--color-primary-light)] px-3.5 py-3 text-xs leading-5 text-[var(--color-primary)]">All required business information is complete.</p>
            )}
            <button type="button" onClick={() => navigate("/settings/client-setup")} className="mt-4 h-10 rounded-xl border border-[var(--color-border)] px-3.5 text-xs font-semibold">Open Client Setup</button>
          </section>

          <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-bold">System readiness</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Database, inbound processing, AI and required application checks.</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${data.system?.ready ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-danger-light)] text-[var(--color-danger)]"}`}>
                {data.system?.ready ? "Ready" : "Review"}
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <Signal ok={data.system?.health?.database?.status === "healthy"} label="Database" detail={data.system?.health?.database?.summary || "Health unavailable."} />
              <Signal ok={data.system?.health?.inbound?.status === "healthy"} label="Inbound worker" detail={data.system?.health?.inbound?.summary || "Health unavailable."} />
              <Signal ok={["healthy", "warning"].includes(data.system?.health?.ai?.status)} label="AI runtime" detail={data.system?.health?.ai?.summary || "Health unavailable."} />
            </div>
            <button type="button" onClick={() => navigate("/settings/setup")} className="mt-4 h-10 rounded-xl border border-[var(--color-border)] px-3.5 text-xs font-semibold">Open Setup Status</button>
          </section>
        </div>

        <section>
          <div className="mb-3">
            <h2 className="font-display text-base font-bold sm:text-lg">Purchased messaging channels</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Only channels in the server-owned purchased-channel contract can block this gate. Unpurchased channels are ignored.</p>
          </div>
          {data.channels?.length ? (
            <div className="grid gap-3 lg:grid-cols-3">
              {data.channels.map((channel) => <ChannelCard key={channel.channel} channel={channel} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)]/40 p-4 text-sm leading-6">
              No purchased messaging-channel contract is available. Provision this client with <code className="rounded bg-white px-1.5 py-0.5 text-xs">PURCHASED_CHANNELS</code> before handover.
            </div>
          )}
        </section>

        <section>
          <div className="mb-3">
            <h2 className="font-display text-base font-bold sm:text-lg">Before going live</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Fix blockers first. Live-testing items require a genuine customer-side test conversation, not a synthetic send from this dashboard.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <IssueList title="Blocking issues" items={data.blockers} tone="danger" />
            <IssueList title="Live testing required" items={data.testingRequired} />
            <IssueList title="Warnings to review" items={data.warnings} />
            {!data.blockers?.length && !data.testingRequired?.length && !data.warnings?.length && (
              <div className="rounded-2xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/50 p-4 text-sm leading-6 text-[var(--color-primary)]">
                Nothing remains. This client has passed the unified go-live gate.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
