import { useEffect, useMemo, useState } from "react";
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

function displayNodeTitle(node) {
  const titles = {
    "customer-message": "Customer asks",
    "understand-intent": "AI understands",
    "answer-from-knowledge": "AI replies",
    "qualify-naturally": "AI asks what's missing",
    "choose-next-path": "AI decides next step",
    "ask-next-question": "Keep chatting",
    "conversion-next-step": "Ready to proceed",
    "human-handoff": "Human handoff",
  };
  return titles[node?.id] || node?.title || "Conversation step";
}

export default function ConversationFlow() {
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState("answer-from-knowledge");
  const [exampleIndex, setExampleIndex] = useState(0);
  const flow = useMemo(() => buildConversationFlow(config || {}), [config]);
  const ui = useMemo(() => getBusinessTerminology(config || {}), [config]);
  const selectedNode = flow.allNodes.find((node) => node.id === selectedId) || null;
  const examples = selectedNode?.examples || [];
  const selectedExample = examples.length > 0 ? examples[exampleIndex % examples.length] : null;
  const selectedIsOutcome = selectedNode ? flow.outcomes.some((node) => node.id === selectedNode.id) : false;
  const knowledgeLine = [
    `${flow.knowledgeCounts.services} ${flow.knowledgeCounts.services === 1 ? ui.serviceSingular : ui.servicePlural}`,
    `${flow.knowledgeCounts.faqs} ${flow.knowledgeCounts.faqs === 1 ? "FAQ" : "FAQs"}`,
    `${flow.knowledgeCounts.promotions} ${flow.knowledgeCounts.promotions === 1 ? "promotion" : "promotions"}`,
    `${flow.handoffCount} ${flow.handoffCount === 1 ? "handoff rule" : "handoff rules"}`,
  ].join(" · ");

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
    setSelectedId((currentId) => (currentId === id ? null : id));
    setExampleIndex(0);
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
      <div className="mx-auto w-full max-w-[980px] px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-7">
        <header className="mb-4 sm:mb-5">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 sm:mb-2 sm:gap-2">
            <span className="inline-flex min-h-6 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[10px] font-semibold text-[var(--color-text-muted)] sm:min-h-7 sm:text-[11px]">
              {flow.industryLabel}
            </span>
            <span className="inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--color-primary-light)] px-2.5 text-[10px] font-semibold text-[var(--color-primary)] sm:min-h-7 sm:text-[11px]">
              <span aria-hidden="true">●</span>
              Based on current settings
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Conversation Flow</h1>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-[var(--color-text-muted)] sm:mt-2 sm:text-sm sm:leading-6">
            See how your AI handles a customer message, one step at a time.
          </p>
          <p className="mt-1.5 text-[11px] font-medium leading-5 text-[var(--color-text-muted)] sm:mt-2 sm:text-xs">{knowledgeLine}</p>
        </header>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 shadow-sm sm:rounded-3xl sm:p-4 lg:p-5">
          <div className="mb-3 flex items-start justify-between gap-3 sm:mb-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] sm:text-xs">Typical conversation</p>
              <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-muted)] sm:text-xs sm:leading-5">Select a step to preview an example.</p>
            </div>
            <span className="hidden w-fit shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] sm:inline-flex">
              <span aria-hidden="true">↻</span>
              Adapts to each conversation
            </span>
          </div>

          <div className="mx-auto w-full max-w-2xl">
            {flow.mainNodes.map((node, index) => {
              const selected = selectedNode?.id === node.id;
              return (
                <div key={node.id}>
                  <FlowNode
                    node={node}
                    step={index + 1}
                    selected={selected}
                    onSelect={() => selectNode(node.id)}
                  />
                  {selected && (
                    <InlineDetail
                      node={node}
                      example={selectedExample}
                      examples={examples}
                      onNextExample={() => setExampleIndex((value) => (value + 1) % examples.length)}
                      ui={ui}
                    />
                  )}
                  {index < flow.mainNodes.length - 1 && <VerticalConnector />}
                </div>
              );
            })}
          </div>

          <div className="my-3 text-center sm:my-4">
            <span className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
              What happens next
            </span>
          </div>

          <BranchRail />

          <div className="grid gap-2.5 md:grid-cols-3 md:gap-3">
            {flow.outcomes.map((node) => {
              const selected = selectedNode?.id === node.id;
              return (
                <div key={node.id}>
                  <OutcomeNode
                    node={node}
                    selected={selected}
                    onSelect={() => selectNode(node.id)}
                  />
                  {selected && (
                    <div className="md:hidden">
                      <InlineDetail
                        node={node}
                        example={selectedExample}
                        examples={examples}
                        onNextExample={() => setExampleIndex((value) => (value + 1) % examples.length)}
                        ui={ui}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selectedIsOutcome && (
            <div className="mx-auto mt-3 hidden w-full max-w-2xl md:block">
              <InlineDetail
                node={selectedNode}
                example={selectedExample}
                examples={examples}
                onNextExample={() => setExampleIndex((value) => (value + 1) % examples.length)}
                ui={ui}
                standalone
              />
            </div>
          )}

          <p className="mt-3 border-t border-[var(--color-border)] pt-3 text-[10px] leading-4 text-[var(--color-text-muted)] sm:mt-4 sm:text-[11px] sm:leading-5">
            Examples illustrate typical behaviour. The AI adapts to context and your saved settings.
          </p>
        </section>
      </div>
    </main>
  );
}

function InlineDetail({ node, example, examples, onNextExample, ui, standalone = false }) {
  return (
    <div
      className={`${standalone ? "rounded-2xl border" : "-mt-px rounded-b-2xl border border-t-0"} overflow-hidden border-[var(--color-primary)]/35 bg-[var(--color-bg)] px-3 pb-3 pt-2.5 sm:px-5 sm:pb-4 sm:pt-3`}
    >
      <div className="flex min-h-10 items-center justify-between gap-3 sm:min-h-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Example</p>
        {examples.length > 1 && (
          <button
            type="button"
            onClick={onNextExample}
            className="inline-flex min-h-11 items-center px-1 text-[11px] font-semibold text-[var(--color-primary)] hover:underline sm:min-h-0 sm:px-0"
          >
            Another example
          </button>
        )}
      </div>

      <div className="mt-2.5 sm:mt-3">
        {example ? (
          <ChatExample example={example} />
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">No example is available for this step.</p>
        )}
      </div>

      {(node.shortNote || node.settingsTab) && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          {node.shortNote ? (
            <p className="max-w-xl text-[11px] leading-[1.55] text-[var(--color-text-muted)] sm:text-xs sm:leading-5">
              <span className="font-semibold text-[var(--color-text)]">Why this step: </span>
              {node.shortNote}
            </p>
          ) : <span />}

          {node.settingsTab && (
            <Link
              to={settingsDestination(node.settingsTab)}
              className="inline-flex min-h-11 shrink-0 items-center text-xs font-semibold text-[var(--color-primary)] hover:underline sm:min-h-0"
            >
              Edit in {settingsLabel(node.settingsTab, ui)} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function ChatExample({ example }) {
  return (
    <div className="space-y-2.5 sm:space-y-3">
      <div>
        <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Customer</p>
        <div className="w-fit max-w-[94%] break-words rounded-2xl rounded-tl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[13px] leading-5 text-[var(--color-text)] sm:max-w-[88%] sm:px-3.5">
          {example.customer}
        </div>
      </div>
      <div className="flex flex-col items-end">
        <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-primary)]">AI</p>
        <div className="w-fit max-w-[94%] break-words rounded-2xl rounded-tr-md bg-[var(--color-primary-light)] px-3 py-2.5 text-[13px] leading-5 text-[var(--color-text)] sm:max-w-[88%] sm:px-3.5">
          {example.ai}
        </div>
      </div>
    </div>
  );
}

function FlowNode({ node, step, selected, onSelect }) {
  const title = displayNodeTitle(node);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-expanded={selected}
      aria-label={`Step ${step}: ${title}`}
      className={`group flex min-h-[52px] w-full items-center gap-3 border px-3 py-2 text-left transition-all sm:min-h-[50px] sm:px-3.5 ${
        selected
          ? "rounded-t-2xl border-[var(--color-primary)] bg-[var(--color-primary-light)]"
          : "rounded-2xl border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface)]"
      }`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        selected
          ? "bg-[var(--color-primary)] text-white"
          : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)]"
      }`}>
        {step}
      </span>
      <h3 className="min-w-0 flex-1 text-sm font-bold leading-5">{title}</h3>
      <span className="pr-0.5 text-sm text-[var(--color-text-muted)]" aria-hidden="true">{selected ? "⌃" : "›"}</span>
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
  const title = displayNodeTitle(node);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-expanded={selected}
      aria-label={title}
      className={`flex min-h-[58px] w-full items-center gap-2.5 border p-3 text-left transition-all md:min-h-[60px] ${
        selected
          ? "rounded-t-2xl rounded-b-none border-[var(--color-primary)] bg-[var(--color-primary-light)] md:rounded-2xl"
          : `rounded-2xl ${styles.card} bg-[var(--color-bg)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface)]`
      }`}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${styles.icon}`}>
        <NodeIcon kind={node.kind} className="h-4 w-4" />
      </div>
      <h3 className="min-w-0 flex-1 text-sm font-bold leading-5">{title}</h3>
      <span className="pr-0.5 text-sm text-[var(--color-text-muted)]" aria-hidden="true">{selected ? "⌃" : "›"}</span>
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