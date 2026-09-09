import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { buildConversationFlow } from "../utils/conversationFlow";
import { getBusinessTerminology } from "../utils/businessTerminology";

function settingsDestination(tab) {
  return tab === "general" ? "/settings" : `/settings?tab=${encodeURIComponent(tab)}`;
}

function settingsLabel(tab, ui) {
  if (tab === "general") return "General";
  if (tab === "services") return ui.servicesLabel;
  if (tab === "aiBehavior") return "AI Behavior";
  if (tab === "escalation") return "Handoff & Rules";
  return "Settings";
}

export default function ConversationFlow() {
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState("customer-message");
  const [exampleIndex, setExampleIndex] = useState(0);
  const detailRef = useRef(null);
  const flow = useMemo(() => buildConversationFlow(config || {}), [config]);
  const ui = useMemo(() => getBusinessTerminology(config || {}), [config]);
  const selectedNode = flow.allNodes.find((node) => node.id === selectedId) || flow.mainNodes[0];
  const examples = selectedNode.examples || [];
  const selectedExample = examples.length > 0 ? examples[exampleIndex % examples.length] : null;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .getConfig()
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "Failed to load the conversation flow.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function selectNode(id) {
    setSelectedId(id);
    setExampleIndex(0);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches) {
      window.requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  if (loadError && !config) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm sm:p-8">
          <h1 className="font-display text-lg font-bold">Couldn't load conversation flow</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-danger)]">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setConfig(null);
              setReloadToken((value) => value + 1);
            }}
            className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-muted)] shadow-sm">
          Loading conversation flow…
        </div>
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto w-full max-w-[1480px] px-3.5 py-5 sm:px-5 sm:py-6 lg:px-8 lg:py-7">
        <header className="mb-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex min-h-7 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[11px] font-semibold text-[var(--color-text-muted)]">
              {flow.industryLabel}
            </span>
            <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full bg-[var(--color-primary-light)] px-2.5 text-[11px] font-semibold text-[var(--color-primary)]">
              <span aria-hidden="true">●</span>
              Based on current settings
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Conversation Flow</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
            See how your AI replies to enquiries, collects useful details, and knows when to involve your team.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <SummaryPill>{flow.knowledgeCounts.services} {flow.knowledgeCounts.services === 1 ? ui.serviceSingular : ui.servicePlural}</SummaryPill>
            <SummaryPill>{flow.knowledgeCounts.faqs} {flow.knowledgeCounts.faqs === 1 ? "FAQ" : "FAQs"}</SummaryPill>
            <SummaryPill>{flow.knowledgeCounts.promotions} {flow.knowledgeCounts.promotions === 1 ? "promotion" : "promotions"}</SummaryPill>
            <SummaryPill>{flow.handoffCount} {flow.handoffCount === 1 ? "handoff trigger" : "handoff triggers"}</SummaryPill>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
          <section className="min-w-0 rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm sm:p-4 lg:p-5">
            <div
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-4"
              style={{
                backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
                backgroundSize: "18px 18px",
              }}
            >
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Typical customer journey</p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">Choose a step to see a real chat example.</p>
                </div>
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
                  <span aria-hidden="true">↻</span>
                  Adapts to each conversation
                </span>
              </div>

              <div className="mx-auto w-full max-w-3xl">
                {flow.mainNodes.map((node, index) => (
                  <div key={node.id}>
                    <FlowNode
                      node={node}
                      step={index + 1}
                      selected={selectedNode.id === node.id}
                      onSelect={() => selectNode(node.id)}
                    />
                    {index < flow.mainNodes.length - 1 && <VerticalConnector />}
                  </div>
                ))}
              </div>

              <div className="my-4 text-center">
                <span className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  What happens next
                </span>
              </div>

              <BranchRail />

              <div className="grid gap-3 md:grid-cols-3">
                {flow.outcomes.map((node) => (
                  <OutcomeNode
                    key={node.id}
                    node={node}
                    selected={selectedNode.id === node.id}
                    onSelect={() => selectNode(node.id)}
                  />
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3 text-[11px] leading-5 text-[var(--color-text-muted)] sm:flex-row sm:items-center sm:justify-between">
                <span>Examples illustrate typical behaviour. Your saved settings remain the source of truth.</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <Link to="/settings?tab=services" className="font-semibold text-[var(--color-primary)] hover:underline">{ui.servicesLabel}</Link>
                  <Link to="/settings?tab=aiBehavior" className="font-semibold text-[var(--color-primary)] hover:underline">AI behaviour</Link>
                  <Link to="/settings?tab=escalation" className="font-semibold text-[var(--color-primary)] hover:underline">Handoff rules</Link>
                </div>
              </div>
            </div>
          </section>

          <aside ref={detailRef} className="min-w-0 scroll-mt-4 xl:sticky xl:top-6 xl:self-start">
            <div className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
                  <NodeIcon kind={selectedNode.kind} className="h-5 w-5" />
                </div>
                <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  {selectedNode.kind}
                </span>
              </div>

              <h2 className="mt-4 font-display text-xl font-bold">{selectedNode.title}</h2>
              <p className="mt-1.5 text-sm leading-6 text-[var(--color-text-muted)]">{selectedNode.summary}</p>

              <div className="mt-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Example chat</p>
                  {examples.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setExampleIndex((value) => (value + 1) % examples.length)}
                      className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline"
                    >
                      Show another example
                    </button>
                  )}
                </div>
                <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5">
                  {selectedExample ? (
                    <ChatExample example={selectedExample} />
                  ) : (
                    <p className="text-xs text-[var(--color-text-muted)]">No example is available for this step.</p>
                  )}
                </div>
              </div>

              {selectedNode.shortNote && (
                <div className="mt-4 rounded-2xl bg-[var(--color-primary-light)] p-3.5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-primary)]">Why this happens</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{selectedNode.shortNote}</p>
                </div>
              )}

              {selectedNode.settingsTab && (
                <Link
                  to={settingsDestination(selectedNode.settingsTab)}
                  className="mt-4 inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm font-semibold transition-colors hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)]"
                >
                  Open {settingsLabel(selectedNode.settingsTab, ui)} settings
                </Link>
              )}

              <p className="mt-4 text-center text-[10px] leading-4 text-[var(--color-text-muted)]">
                {flow.flexibilityNote}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function SummaryPill({ children }) {
  return (
    <span className="inline-flex min-h-8 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold text-[var(--color-text-muted)] shadow-sm">
      {children}
    </span>
  );
}

function ChatExample({ example }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Customer</p>
        <div className="mr-8 rounded-2xl rounded-tl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-xs leading-5 text-[var(--color-text)]">
          {example.customer}
        </div>
      </div>
      <div className="flex flex-col items-end">
        <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-primary)]">AI</p>
        <div className="ml-8 rounded-2xl rounded-tr-md bg-[var(--color-primary-light)] px-3.5 py-2.5 text-xs leading-5 text-[var(--color-text)]">
          {example.ai}
        </div>
      </div>
    </div>
  );
}

function FlowNode({ node, step, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Step ${step}: ${node.title}`}
      className={`group flex min-h-[62px] w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition-all sm:px-3.5 ${
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface)] ring-2 ring-[var(--color-primary)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:-translate-y-0.5 hover:border-[var(--color-primary)]/40 hover:shadow-md"
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
        <NodeIcon kind={node.kind} className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--color-primary)]">Step {step}</p>
        <div className="mt-0.5 flex flex-col gap-0.5 lg:flex-row lg:items-baseline lg:gap-2.5">
          <h3 className="shrink-0 text-sm font-bold leading-5">{node.title}</h3>
          <p className="line-clamp-2 text-[11px] leading-[1.5] text-[var(--color-text-muted)] lg:line-clamp-1">{node.summary}</p>
        </div>
      </div>
      <span className="text-sm text-[var(--color-text-muted)]" aria-hidden="true">›</span>
    </button>
  );
}

function VerticalConnector() {
  return (
    <div aria-hidden="true" className="flex h-3 justify-center">
      <div className="relative h-2.5 w-px bg-[var(--color-border)]">
        <span className="absolute -bottom-0.5 -left-[3px] h-2 w-2 rotate-45 border-b border-r border-[var(--color-text-muted)]" />
      </div>
    </div>
  );
}

function BranchRail() {
  return (
    <div aria-hidden="true" className="relative mx-[16.6667%] hidden h-6 md:block">
      <div className="absolute left-1/2 top-0 h-2.5 w-px -translate-x-1/2 bg-[var(--color-border)]" />
      <div className="absolute left-0 right-0 top-2.5 h-px bg-[var(--color-border)]" />
      <div className="absolute left-0 top-2.5 h-3.5 w-px bg-[var(--color-border)]" />
      <div className="absolute left-1/2 top-2.5 h-3.5 w-px -translate-x-1/2 bg-[var(--color-border)]" />
      <div className="absolute right-0 top-2.5 h-3.5 w-px bg-[var(--color-border)]" />
    </div>
  );
}

function outcomeStyles(kind) {
  if (kind === "Conversion") {
    return {
      card: "border-[var(--color-primary)]/35",
      icon: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    };
  }
  if (kind === "Human") {
    return {
      card: "border-[var(--color-accent)]/50",
      icon: "bg-[var(--color-accent-light)] text-[var(--color-accent)]",
    };
  }
  return {
    card: "border-[var(--color-border)]",
    icon: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
  };
}

function OutcomeNode({ node, selected, onSelect }) {
  const styles = outcomeStyles(node.kind);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`min-h-28 rounded-2xl border bg-[var(--color-surface)] p-3 text-left transition-all sm:p-3.5 ${
        selected
          ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/10"
          : `${styles.card} hover:-translate-y-0.5 hover:shadow-md`
      }`}
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{node.branchLabel}</p>
      <div className="mt-2 flex items-center gap-2.5">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${styles.icon}`}>
          <NodeIcon kind={node.kind} className="h-4 w-4" />
        </div>
        <h3 className="text-sm font-bold leading-5">{node.title}</h3>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-[1.55] text-[var(--color-text-muted)]">{node.summary}</p>
    </button>
  );
}

function NodeIcon({ kind, className = "h-5 w-5" }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };

  if (kind === "Customer") {
    return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.5-4A7 7 0 1 1 21 15Z" /></svg>;
  }
  if (kind === "Knowledge") {
    return <svg {...common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></svg>;
  }
  if (kind === "Qualification" || kind === "Continue") {
    return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></svg>;
  }
  if (kind === "Decision") {
    return <svg {...common}><path d="M6 3v5a4 4 0 0 0 4 4h8" /><path d="m15 9 3 3-3 3" /><path d="M6 21v-5a4 4 0 0 1 4-4" /></svg>;
  }
  if (kind === "Conversion") {
    return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>;
  }
  if (kind === "Human") {
    return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>;
  }
  return <svg {...common}><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /><path d="m5.6 5.6 2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>;
}
