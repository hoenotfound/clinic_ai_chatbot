import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { useAuth } from "../context/AuthContext";

function pretty(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseConfig(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Configuration must be a JSON object." };
  }
  return { value };
}

function historyReason(reason) {
  return reason === "before_restore" ? "Before restore" : "Before JSON import";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SECTION_LABELS = {
  businessName: "Business name",
  businessDescription: "Business description",
  aiAssistantName: "AI assistant name",
  branches: "Branches",
  serviceAreas: "Service areas",
  hours: "Hours",
  contact: "Contact",
  introMessage: "Intro message",
  promotions: "Promotions",
  services: "Services",
  serviceAliases: "Service terms",
  faqs: "FAQs",
  closingPlaybook: "Sales playbook",
  tone: "Tone",
  messagingStyle: "Messaging style",
  sop: "SOP",
  escalation: "Handoff & rules",
  guardrails: "Guardrails",
};

const FIELD_LABELS = {
  address: "Address",
  phone: "Phone",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  description: "Description",
  priceRange: "Price",
  duration: "Duration",
  officialService: "Maps to service",
  a: "Answer",
  linkedService: "Linked service",
  sendOnPriceQuery: "Send on price enquiry",
  caption: "Caption",
  validFrom: "Valid from",
  validUntil: "Valid until",
  imageUrl: "Image",
  general: "Opening hours",
  closed: "Closed days / note",
  outOfScopeTriggers: "Handoff triggers",
  handoffMessage: "Handoff message",
  handoffNote: "Internal note",
};

function sectionLabel(key) {
  return SECTION_LABELS[key] || key;
}

function fieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function changeBadge(change) {
  const details = change?.details;
  if (!details) return "Changed";
  if (details.kind === "collection") {
    const parts = [];
    if (details.added?.length) parts.push(`+${details.added.length}`);
    if (details.updated?.length) parts.push(`${details.updated.length} updated`);
    if (details.removed?.length) parts.push(`−${details.removed.length}`);
    return parts.join(" · ") || "Changed";
  }
  if (details.kind === "string_list") {
    const parts = [];
    if (details.added?.length) parts.push(`+${details.added.length}`);
    if (details.removed?.length) parts.push(`−${details.removed.length}`);
    if (details.orderChanged) parts.push("Order changed");
    return parts.join(" · ") || "Changed";
  }
  if (details.kind === "object") {
    return countLabel(details.changes?.length || 0, "field") + " changed";
  }
  if (details.kind === "text") return "Text changed";
  return "Changed";
}

function reviewSummary(changes = []) {
  const parts = [countLabel(changes.length, "section") + " changed"];

  const collectionLabels = {
    faqs: "FAQ",
    services: "service",
    branches: "branch",
    promotions: "promotion",
    serviceAliases: "service term",
  };

  for (const change of changes) {
    const details = change?.details;
    if (details?.kind === "collection" && collectionLabels[change.key]) {
      if (details.added?.length) {
        parts.push(countLabel(details.added.length, collectionLabels[change.key]) + " added");
      }
      if (details.updated?.length) {
        parts.push(countLabel(details.updated.length, collectionLabels[change.key]) + " updated");
      }
      if (details.removed?.length) {
        parts.push(countLabel(details.removed.length, collectionLabels[change.key]) + " removed");
      }
    }
    if (change.key === "guardrails" && details?.kind === "string_list") {
      if (details.added?.length) parts.push(countLabel(details.added.length, "guardrail") + " added");
      if (details.removed?.length) parts.push(countLabel(details.removed.length, "guardrail") + " removed");
    }
  }

  return parts.slice(0, 5).join(" · ");
}

function visibleLineGroups(segments = []) {
  const output = [];
  for (const segment of segments) {
    if (segment.type !== "same" || segment.lines.length <= 6) {
      output.push(segment);
      continue;
    }
    output.push({ type: "same", lines: segment.lines.slice(0, 2) });
    output.push({ type: "skipped", lines: [`${segment.lines.length - 4} unchanged lines`] });
    output.push({ type: "same", lines: segment.lines.slice(-2) });
  }
  return output;
}

function TextDiff({ diff }) {
  if (!diff) return null;

  if (diff.mode === "words") {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-xs leading-6">
        {(diff.segments || []).map((segment, index) => {
          const className = segment.type === "added"
            ? "rounded bg-[var(--color-primary-light)] px-0.5 font-semibold text-[var(--color-primary)]"
            : segment.type === "removed"
              ? "rounded bg-[var(--color-danger-light)] px-0.5 text-[var(--color-danger)] line-through"
              : "text-[var(--color-text)]";
          return <span key={`${segment.type}-${index}`} className={className}>{segment.text}</span>;
        })}
      </div>
    );
  }

  if (diff.mode === "lines") {
    return (
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-white font-mono text-[11px] leading-5">
        {visibleLineGroups(diff.segments || []).flatMap((segment, segmentIndex) =>
          (segment.lines || []).map((line, lineIndex) => {
            const added = segment.type === "added";
            const removed = segment.type === "removed";
            const skipped = segment.type === "skipped";
            const prefix = added ? "+" : removed ? "−" : skipped ? "…" : " ";
            const className = added
              ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
              : removed
                ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]"
                : skipped
                  ? "text-[var(--color-text-muted)] italic"
                  : "text-[var(--color-text-muted)]";
            return (
              <div
                key={`${segmentIndex}-${lineIndex}`}
                className={`grid grid-cols-[18px_minmax(0,1fr)] px-2.5 py-0.5 ${className}`}
              >
                <span aria-hidden="true">{prefix}</span>
                <span className={`whitespace-pre-wrap break-words ${removed ? "line-through" : ""}`}>{line || " "}</span>
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="rounded-xl border border-[var(--color-danger)]/15 bg-[var(--color-danger-light)] px-3 py-2.5 text-xs">
        <p className="mb-1 font-semibold text-[var(--color-danger)]">Before</p>
        <p className="whitespace-pre-wrap break-words">{diff.before}</p>
      </div>
      <div className="rounded-xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] px-3 py-2.5 text-xs">
        <p className="mb-1 font-semibold text-[var(--color-primary)]">After</p>
        <p className="whitespace-pre-wrap break-words">{diff.after}</p>
      </div>
    </div>
  );
}

function StringListDiff({ details }) {
  return (
    <div className="space-y-3">
      {details.added?.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-bold text-[var(--color-primary)]">Added</p>
          <div className="space-y-1">
            {details.added.map((item, index) => (
              <div key={`add-${index}`} className="break-words rounded-lg bg-[var(--color-primary-light)] px-3 py-2 text-xs leading-5 text-[var(--color-text)]">
                <span className="mr-2 font-bold text-[var(--color-primary)]">+</span>{item}
              </div>
            ))}
          </div>
        </div>
      )}
      {details.removed?.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-bold text-[var(--color-danger)]">Removed</p>
          <div className="space-y-1">
            {details.removed.map((item, index) => (
              <div key={`remove-${index}`} className="break-words rounded-lg bg-[var(--color-danger-light)] px-3 py-2 text-xs leading-5 text-[var(--color-text)]">
                <span className="mr-2 font-bold text-[var(--color-danger)]">−</span>
                <span className="line-through">{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {details.orderChanged && (
        <div>
          <p className="mb-1.5 text-xs font-bold text-[var(--color-text)]">Order changed</p>
          <div className="grid gap-2 lg:grid-cols-2">
            <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5">
              <p className="mb-2 text-[11px] font-bold text-[var(--color-text-muted)]">Before</p>
              <ol className="space-y-1.5 text-xs leading-5">
                {(details.beforeOrder || []).map((item, index) => (
                  <li key={`before-order-${index}`} className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-1">
                    <span className="text-[var(--color-text-muted)]">{index + 1}.</span>
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5">
              <p className="mb-2 text-[11px] font-bold text-[var(--color-text-muted)]">After</p>
              <ol className="space-y-1.5 text-xs leading-5">
                {(details.afterOrder || []).map((item, index) => (
                  <li key={`after-order-${index}`} className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-1">
                    <span className="text-[var(--color-text-muted)]">{index + 1}.</span>
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SimpleBeforeAfter({ before, after }) {
  return (
    <div className="grid gap-1.5 text-xs leading-5">
      <p className="break-words text-[var(--color-text-muted)]"><span className="font-semibold">Before:</span> {before}</p>
      <p className="break-words text-[var(--color-text)]"><span className="font-semibold">After:</span> {after}</p>
    </div>
  );
}

function FieldDiff({ change }) {
  return (
    <div className="border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0 last:pb-0">
      <p className="mb-2 text-xs font-bold text-[var(--color-text)]">{fieldLabel(change.field)}</p>
      {change.details?.kind === "string_list" ? (
        <StringListDiff details={change.details} />
      ) : change.textDiff ? (
        <TextDiff diff={change.textDiff} />
      ) : (
        <SimpleBeforeAfter before={change.before} after={change.after} />
      )}
    </div>
  );
}

function ItemSnapshot({ item }) {
  const entries = Object.entries(item || {}).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
  if (!entries.length) return null;
  return (
    <div className="mt-2 space-y-1 text-xs leading-5 text-[var(--color-text-muted)]">
      {entries.map(([key, value]) => (
        <p key={key} className="break-words"><span className="font-semibold text-[var(--color-text)]">{fieldLabel(key)}:</span> {String(value)}</p>
      ))}
    </div>
  );
}

function CollectionDiff({ details }) {
  return (
    <div className="space-y-5">
      {details.added?.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold text-[var(--color-primary)]">{countLabel(details.added.length, "item")} added</p>
          <div className="space-y-2">
            {details.added.map((entry, index) => (
              <div key={`added-${entry.identity}-${index}`} className="min-w-0 rounded-xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] px-3 py-2.5">
                <p className="break-words text-sm font-semibold text-[var(--color-text)]"><span className="mr-2 text-[var(--color-primary)]">+</span>{entry.identity}</p>
                <ItemSnapshot item={entry.item} />
              </div>
            ))}
          </div>
        </div>
      )}

      {details.updated?.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold text-[var(--color-text)]">{countLabel(details.updated.length, "item")} updated</p>
          <div className="space-y-2">
            {details.updated.map((entry, index) => (
              <details key={`updated-${entry.identity}-${index}`} className="rounded-xl border border-[var(--color-border)] bg-white">
                <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-semibold">
                  <span className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                    <span className="min-w-0 break-words">{entry.identity}</span>
                    <span className="max-w-full break-words text-left text-[10px] font-bold text-[var(--color-text-muted)] sm:shrink-0 sm:text-right">
                      {(entry.changes || []).map((change) => fieldLabel(change.field)).join(" · ") || "Changed"}
                    </span>
                  </span>
                </summary>
                <div className="border-t border-[var(--color-border)] px-3 py-3">
                  {(entry.changes || []).map((fieldChange) => (
                    <FieldDiff key={fieldChange.field} change={fieldChange} />
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {details.removed?.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold text-[var(--color-danger)]">{countLabel(details.removed.length, "item")} removed</p>
          <div className="space-y-2">
            {details.removed.map((entry, index) => (
              <div key={`removed-${entry.identity}-${index}`} className="min-w-0 rounded-xl border border-[var(--color-danger)]/15 bg-[var(--color-danger-light)] px-3 py-2.5">
                <p className="break-words text-sm font-semibold text-[var(--color-text)]"><span className="mr-2 text-[var(--color-danger)]">−</span><span className="line-through">{entry.identity}</span></p>
                <ItemSnapshot item={entry.item} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChangeDetails({ change }) {
  const details = change.details;
  if (!details) return <SimpleBeforeAfter before={change.before} after={change.after} />;
  if (details.kind === "collection") return <CollectionDiff details={details} />;
  if (details.kind === "string_list") return <StringListDiff details={details} />;
  if (details.kind === "object") {
    return (
      <div>
        {(details.changes || []).map((fieldChange) => (
          <FieldDiff key={fieldChange.field} change={fieldChange} />
        ))}
      </div>
    );
  }
  if (details.kind === "text") return <TextDiff diff={details} />;
  return <SimpleBeforeAfter before={change.before} after={change.after} />;
}

function ChangeSection({ change }) {
  return (
    <details
      data-testid={`config-change-${change.key}`}
      className="group border-b border-[var(--color-border)] last:border-b-0"
    >
      <summary className="cursor-pointer list-none py-3.5">
        <span className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[var(--color-text)]">{sectionLabel(change.key)}</span>
            <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">{changeBadge(change)}</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-sm text-[var(--color-text-muted)] transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="pb-4">
        <ChangeDetails change={change} />
      </div>
    </details>
  );
}

export default function AdvancedConfig() {
  const { refreshUser } = useAuth();
  const [data, setData] = useState(null);
  const [editor, setEditor] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewText, setPreviewText] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const editorChangedSincePreview = Boolean(preview && previewText !== editor);
  const history = data?.history || [];
  const allowedKeys = data?.editableKeys || [];

  const parsed = useMemo(() => parseConfig(editor), [editor]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const next = await api.getAdvancedConfig();
      setData(next);
      setEditor(pretty(next.config));
      setPreview(null);
      setPreviewText("");
    } catch (err) {
      setError(err.message || "Couldn't load Advanced Config.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateEditor(value) {
    setEditor(value);
    setNotice("");
    if (previewText !== value) setPreview(null);
  }

  function resetToCurrent() {
    if (!data) return;
    setEditor(pretty(data.config));
    setPreview(null);
    setPreviewText("");
    setError("");
    setNotice("Editor reset to the current live configuration.");
  }

  async function copyCurrent() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(pretty(data.config));
      setNotice("Current editable configuration copied.");
      setError("");
    } catch {
      setError("Couldn't copy to the clipboard. Select the JSON and copy it manually.");
    }
  }

  async function validateAndPreview() {
    setError("");
    setNotice("");
    setPreview(null);

    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setAction("preview");
    try {
      const result = await api.previewAdvancedConfig(parsed.value);
      setPreview(result);
      setPreviewText(editor);
      if (!result.changes?.length) {
        setNotice("Valid JSON, but it does not change the current configuration.");
      }
    } catch (err) {
      setError(err.message || "Couldn't validate this configuration.");
    } finally {
      setAction("");
    }
  }

  async function applyChanges() {
    if (!preview || editorChangedSincePreview || parsed.error) {
      setError("Validate the current JSON again before applying it.");
      return;
    }
    if (!preview.changes?.length) {
      setError("There are no changes to apply.");
      return;
    }

    setAction("apply");
    setError("");
    setNotice("");
    try {
      const result = await api.applyAdvancedConfig(parsed.value, preview.baseFingerprint);
      setData((current) => ({
        ...(current || {}),
        config: result.config,
        fingerprint: result.fingerprint,
        history: result.history || current?.history || [],
      }));
      setEditor(pretty(result.config));
      setPreview(null);
      setPreviewText("");
      await refreshUser().catch(() => {});
      setNotice("Configuration changes applied.");
    } catch (err) {
      setError(err.message || "Couldn't apply this configuration.");
      if (err.code === "CONFIG_PREVIEW_STALE") {
        setPreview(null);
        setPreviewText("");
      }
    } finally {
      setAction("");
    }
  }

  async function restoreSnapshot(snapshot) {
    const confirmed = window.confirm(
      `Restore the editable configuration saved ${formatDate(snapshot.createdAt)}? A backup of the current configuration will be created first.`
    );
    if (!confirmed) return;

    setAction(`restore:${snapshot.id}`);
    setError("");
    setNotice("");
    try {
      const result = await api.restoreAdvancedConfig(snapshot.id);
      setData((current) => ({
        ...(current || {}),
        config: result.config,
        fingerprint: result.fingerprint,
        history: result.history || current?.history || [],
      }));
      setEditor(pretty(result.config));
      setPreview(null);
      setPreviewText("");
      await refreshUser().catch(() => {});
      setNotice("Configuration restored. The previous live version was backed up automatically.");
    } catch (err) {
      setError(err.message || "Couldn't restore this configuration snapshot.");
    } finally {
      setAction("");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-7 w-7 text-[var(--color-primary)]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full overflow-y-auto px-3.5 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[var(--color-border)] bg-white p-5">
          <h2 className="font-display text-lg font-bold">Advanced Config unavailable</h2>
          <p className="mt-2 text-sm text-[var(--color-danger)]">{error || "Couldn't load the configuration."}</p>
          <button
            type="button"
            onClick={load}
            className="mt-4 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-bg)] px-3.5 py-4 sm:px-5 sm:py-6 lg:px-8">
      <div className="mx-auto w-full max-w-5xl pb-10">
        <header className="mb-5">
          <p className="text-xs font-semibold text-[var(--color-primary)]">Admin only</p>
          <h1 className="mt-1 font-display text-2xl font-bold">Advanced Config</h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
            Paste a full or partial JSON configuration, validate it against the same server rules as Settings, review the changes, then apply it live.
          </p>
        </header>

        <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs leading-5 text-[var(--color-text-muted)]">
          Business profile internals and Automation Tools settings are intentionally excluded. Every JSON import creates a backup first, and applying through this page updates the running chatbot immediately without a Render restart. Backups preserve JSON values only, not uploaded image files that are later deleted or pruned.
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] px-4 py-3 text-sm text-[var(--color-primary)]">
            {notice}
          </div>
        )}

        <section className="border-y border-[var(--color-border)] py-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-bold">JSON editor</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Partial JSON is supported. Include only the top-level fields you want to change.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyCurrent}
                className="h-10 rounded-xl border border-[var(--color-border)] bg-white px-3.5 text-xs font-semibold"
              >
                Copy current
              </button>
              <button
                type="button"
                onClick={resetToCurrent}
                className="h-10 rounded-xl border border-[var(--color-border)] bg-white px-3.5 text-xs font-semibold"
              >
                Reset
              </button>
            </div>
          </div>

          <textarea
            aria-label="JSON configuration"
            spellCheck={false}
            value={editor}
            onChange={(event) => updateEditor(event.target.value)}
            className="min-h-[28rem] w-full resize-y rounded-xl border border-[var(--color-border)] bg-[#111814] p-4 font-mono text-[12px] leading-5 text-[#e8eee9] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/25 sm:min-h-[34rem] sm:text-[13px]"
          />

          {parsed.error && editor.trim() && (
            <p className="mt-2 text-xs text-[var(--color-danger)]">{parsed.error}</p>
          )}

          <details className="mt-3 text-xs text-[var(--color-text-muted)]">
            <summary className="cursor-pointer font-semibold text-[var(--color-text)]">
              Allowed top-level fields ({allowedKeys.length})
            </summary>
            <p className="mt-2 break-words leading-5">{allowedKeys.join(" · ")}</p>
          </details>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={validateAndPreview}
              disabled={Boolean(action) || Boolean(parsed.error)}
              className="inline-flex h-11 items-center justify-center rounded-xl border border-[var(--color-primary)] px-4 text-sm font-semibold text-[var(--color-primary)] disabled:opacity-50"
            >
              {action === "preview" ? "Validating…" : "Validate & review"}
            </button>
            {preview?.changes?.length > 0 && !editorChangedSincePreview && (
              <button
                type="button"
                onClick={applyChanges}
                disabled={Boolean(action)}
                className="inline-flex h-11 items-center justify-center rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {action === "apply" ? "Applying…" : "Apply changes"}
              </button>
            )}
          </div>
        </section>

        {preview && (
          <section className="border-b border-[var(--color-border)] py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold">Review changes</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--color-text-muted)]">
                  {preview.changes?.length
                    ? reviewSummary(preview.changes)
                    : "No live values would change."}
                </p>
              </div>
              {editorChangedSincePreview && (
                <span className="rounded-full bg-[var(--color-accent-light)] px-2.5 py-1 text-[10px] font-bold text-[var(--color-text)]">
                  Revalidate
                </span>
              )}
            </div>

            {preview.changes?.length > 0 && (
              <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4">
                {(preview.changes || []).map((change) => (
                  <ChangeSection key={change.key} change={change} />
                ))}
              </div>
            )}
          </section>
        )}

        <section className="py-5">
          <div>
            <h2 className="font-display text-lg font-bold">Import history</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              The latest automatic backups are shown here. Up to 50 snapshots are retained, and restoring a backup also creates a new backup first.
            </p>
          </div>

          {history.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-5 text-sm text-[var(--color-text-muted)]">
              No JSON imports have been applied yet.
            </p>
          ) : (
            <div className="mt-4 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {history.map((snapshot) => (
                <div key={snapshot.id} className="py-3.5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold">{historyReason(snapshot.reason)}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        {formatDate(snapshot.createdAt)} · {snapshot.createdBy}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => restoreSnapshot(snapshot)}
                      disabled={Boolean(action)}
                      className="h-10 rounded-xl border border-[var(--color-border)] bg-white px-3.5 text-xs font-semibold disabled:opacity-50"
                    >
                      {action === `restore:${snapshot.id}` ? "Restoring…" : "Restore"}
                    </button>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--color-primary)]">View JSON</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-[#111814] p-3 text-[11px] leading-5 text-[#e8eee9]">
                      {pretty(snapshot.editableConfig)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
