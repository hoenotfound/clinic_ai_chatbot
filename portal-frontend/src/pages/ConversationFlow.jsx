import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessConfig } from "../context/BusinessConfigContext";
import { buildConversationFlow } from "../utils/conversationFlow";

const SETTINGS_LABELS = {
  general: "General",
  services: "Services",
  aiBehavior: "AI Behavior",
  escalation: "Handoff & Rules",
};

function settingsDestination(tab) {
  return tab === "general" ? "/settings" : `/settings?tab=${encodeURIComponent(tab)}`;
}

export default function ConversationFlow() {
  const { config, loading } = useBusinessConfig();
  const flow = useMemo(() => buildConversationFlow(config || {}), [config]);
  const [selectedId, setSelectedId] = useState("customer-message");
  const selectedNode = flow.allNodes.find((node) => node.id === selectedId) || flow.mainNodes[0];

  if (loading || !config) {
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
      <div className="mx-auto w-full max-w-[1540px] px-3.5 py-5 sm:px-5 sm:py-7 lg:px-8 lg:py-8">
        <header className="mb-5 flex flex-col gap-4 sm:mb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex min-h-7 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[11px] font-semibold text-[var(--color-text-muted)]">
                {flow.industryLabel}
              </span>
              <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full bg-[var(--color-primary-light)] px-2.5 text-[11px] font-semibold text-[var(--color-primary)]">
                <span aria-hidden="true">●</span>
                Read-only preview
              </span>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Conversation Flow</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
              See how the AI normally handles an enquiry from the first customer message to the next sales step or human handoff.
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Current setup</p>
            <p className="mt-1 text-sm font-semibold">{flow.knowledgeSummary}</p>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="min-w-0 rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm sm:p-4 lg:p-5">
            <div
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-4 lg:p-5"
              style={{
                backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
                backgroundSize: "18px 18px",
              }}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Normal enquiry path</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    The AI can answer questions at any point. These cards show the usual decision process, not a rigid script.
                  </p>
                </div>
              </div>

              <div className="flex flex-col items-stretch gap-0 xl:flex-row xl:items-center">
                {flow.mainNodes.map((node, index) => (
                  <div key={node.id} className="contents">
                    <FlowNode
                      node={node}
                      selected={selectedNode.id === node.id}
                      onSelect={() => setSelectedId(node.id)}
                    />
                    {index < flow.mainNodes.length - 1 && <FlowConnector />}
                  </div>
                ))}
              </div>

              <div className="mx-auto my-4 flex w-full max-w-2xl items-center gap-3 sm:my-5">
                <div className="h-px flex-1 bg-[var(--color-border)]" />
                <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  Possible next paths
                </span>
                <div className="h-px flex-1 bg-[var(--color-border)]" />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {flow.outcomes.map((node) => (
                  <OutcomeNode
                    key={node.id}
                    node={node}
                    selected={selectedNode.id === node.id}
                    onSelect={() => setSelectedId(node.id)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <SourceCard
                title="Business knowledge"
                description="Services, FAQs, promotions and factual business information shape what the AI can safely answer."
                to="/settings?tab=services"
                linkLabel="Review services"
              />
              <SourceCard
                title="Conversation behaviour"
                description="Texting style, qualification and conversion instructions control how the AI moves the chat forward."
                to="/settings?tab=aiBehavior"
                linkLabel="Review AI behaviour"
              />
              <SourceCard
                title="Human boundaries"
                description="Handoff triggers and guardrails decide when automation should stop and staff should take over."
                to="/settings?tab=escalation"
                linkLabel="Review handoff rules"
              />
            </div>
          </section>

          <aside className="min-w-0 xl:sticky xl:top-6 xl:self-start">
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
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">{selectedNode.summary}</p>

              {selectedNode.meta && (
                <div className="mt-4 rounded-xl bg-[var(--color-bg)] px-3.5 py-3 text-xs font-semibold text-[var(--color-text-muted)]">
                  {selectedNode.meta}
                </div>
              )}

              <div className="mt-5 border-t border-[var(--color-border)] pt-5">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">What happens here</p>
                <ul className="mt-3 space-y-3">
                  {selectedNode.details.map((detail, index) => (
                    <li key={`${selectedNode.id}-${index}`} className="flex gap-2.5 text-xs leading-5 text-[var(--color-text-muted)]">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" />
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {selectedNode.settingsTab && (
                <Link
                  to={settingsDestination(selectedNode.settingsTab)}
                  className="mt-5 inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm font-semibold transition-colors hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)]"
                >
                  Edit in {SETTINGS_LABELS[selectedNode.settingsTab] || "Settings"}
                </Link>
              )}
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs leading-5 text-[var(--color-text-muted)] shadow-sm">
              <p className="font-bold text-[var(--color-text)]">This is not a fixed script</p>
              <p className="mt-1.5">
                Customers can provide several details in one message, change topic, ask questions or request staff at any time. The AI uses the current conversation instead of forcing every card in order.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function FlowNode({ node, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group min-h-36 w-full rounded-2xl border p-4 text-left shadow-sm transition-all xl:min-h-44 xl:min-w-0 xl:flex-1 ${
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface)] ring-2 ring-[var(--color-primary)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:-translate-y-0.5 hover:border-[var(--color-primary)]/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
          <NodeIcon kind={node.kind} className="h-[18px] w-[18px]" />
        </div>
        <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
          {node.kind}
        </span>
      </div>
      <h3 className="mt-3 text-sm font-bold leading-5">{node.title}</h3>
      <p className="mt-1.5 line-clamp-3 text-[11px] leading-[1.55] text-[var(--color-text-muted)]">{node.summary}</p>
      {node.meta && <p className="mt-2 text-[10px] font-semibold text-[var(--color-primary)]">{node.meta}</p>}
    </button>
  );
}

function OutcomeNode({ node, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-2xl border p-4 text-left transition-all ${
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface)] ring-2 ring-[var(--color-primary)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:-translate-y-0.5 hover:border-[var(--color-primary)]/40"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
          <NodeIcon kind={node.kind} className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{node.kind}</p>
          <h3 className="truncate text-sm font-bold">{node.title}</h3>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-[1.55] text-[var(--color-text-muted)]">{node.summary}</p>
      {node.meta && <p className="mt-2 text-[10px] font-semibold text-[var(--color-primary)]">{node.meta}</p>}
    </button>
  );
}

function FlowConnector() {
  return (
    <div aria-hidden="true" className="flex h-9 shrink-0 items-center justify-center text-[var(--color-text-muted)] xl:h-auto xl:w-8">
      <span className="rotate-90 text-lg font-light xl:rotate-0">→</span>
    </div>
  );
}

function SourceCard({ title, description, to, linkLabel }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1.5 text-[11px] leading-5 text-[var(--color-text-muted)]">{description}</p>
      <Link to={to} className="mt-3 inline-flex text-xs font-semibold text-[var(--color-primary)] hover:underline">
        {linkLabel} →
      </Link>
    </div>
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
    return (
      <svg {...common}>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.5-4A7 7 0 1 1 21 15Z" />
      </svg>
    );
  }

  if (kind === "Knowledge") {
    return (
      <svg {...common}>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" />
      </svg>
    );
  }

  if (kind === "Qualification" || kind === "Continue") {
    return (
      <svg {...common}>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" />
      </svg>
    );
  }

  if (kind === "Decision") {
    return (
      <svg {...common}>
        <path d="M6 3v5a4 4 0 0 0 4 4h8" />
        <path d="m15 9 3 3-3 3" />
        <path d="M6 21v-5a4 4 0 0 1 4-4" />
      </svg>
    );
  }

  if (kind === "Conversion") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="m8.5 12 2.2 2.2 4.8-5" />
      </svg>
    );
  }

  if (kind === "Human") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <circle cx="12" cy="12" r="4" />
      <path d="m5.6 5.6 2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  );
}
