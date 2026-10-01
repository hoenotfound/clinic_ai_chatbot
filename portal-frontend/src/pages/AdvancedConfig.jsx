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
      setNotice(`Applied ${result.changes?.length || 0} configuration change${result.changes?.length === 1 ? "" : "s"}.`);
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
          Business profile internals and Automation Tools settings are intentionally excluded. Every JSON import creates a backup first, and applying through this page updates the running chatbot immediately without a Render restart.
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
                {action === "apply" ? "Applying…" : `Apply ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </section>

        {preview && (
          <section className="border-b border-[var(--color-border)] py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold">Review changes</h2>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {preview.changes?.length
                    ? "Only these editable fields will change."
                    : "No live values would change."}
                </p>
              </div>
              {editorChangedSincePreview && (
                <span className="rounded-full bg-[var(--color-accent-light)] px-2.5 py-1 text-[10px] font-bold text-[var(--color-text)]">
                  Revalidate
                </span>
              )}
            </div>

            <div className="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {(preview.changes || []).map((change) => (
                <div key={change.key} className="grid gap-1 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
                  <p className="font-mono text-xs font-bold text-[var(--color-text)]">{change.key}</p>
                  <div className="min-w-0 text-xs leading-5">
                    <p className="break-words text-[var(--color-text-muted)]">Before: {change.before}</p>
                    <p className="break-words font-semibold text-[var(--color-text)]">After: {change.after}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="py-5">
          <div>
            <h2 className="font-display text-lg font-bold">Import history</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              The latest automatic backups are kept here. Up to 50 snapshots are retained, and restoring a backup also creates a new backup first.
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
