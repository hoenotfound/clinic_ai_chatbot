import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";

function displayName(contact) {
  return (
    contact?.name ||
    contact?.whatsapp_profile_name ||
    contact?.whatsapp_number ||
    "this contact"
  );
}

function categoryLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : "Template";
}

function replaceVariables(text, values) {
  return String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, rawIndex) => {
    const value = values?.[Number(rawIndex) - 1];
    return value?.trim() ? value.trim() : `{{${rawIndex}}}`;
  });
}

function templatePreview(template, values) {
  if (!template) return "";
  const parts = [];
  if (template.header?.text) {
    parts.push(replaceVariables(template.header.text, values.header));
  }
  if (template.body?.text) {
    parts.push(replaceVariables(template.body.text, values.body));
  }
  if (template.footer?.text) parts.push(template.footer.text);
  return parts.filter(Boolean).join("\n\n");
}

function emptyValuesFor(template) {
  const result = { header: [], body: [] };
  for (const field of template?.variableFields || []) {
    const values = result[field.component];
    if (!values) continue;
    while (values.length < field.index) values.push("");
  }
  return result;
}

function eligibilityCopy(eligibility) {
  if (eligibility?.code === "opted_out") {
    return "This customer previously opted out. Only record a new opt-in if they have explicitly agreed to receive WhatsApp messages again.";
  }
  if (eligibility?.code === "missing_opt_in") {
    return "A WhatsApp template needs an explicit opt-in record. Record where the customer agreed to receive WhatsApp messages before sending.";
  }
  return eligibility?.message || "This contact is not currently eligible for a WhatsApp template.";
}

function TemplatePicker({ templates, selectedKey, onSelect }) {
  if (!templates.length) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-6 text-center">
        <p className="text-sm font-semibold">No approved templates found</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
          Create and approve a WhatsApp template in Meta first, then reopen this window.
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
      {templates.map((template) => {
        const key = `${template.name}::${template.language}`;
        const selected = key === selectedKey;
        return (
          <button
            key={key}
            type="button"
            disabled={!template.sendable}
            onClick={() => onSelect(template)}
            className={`w-full rounded-2xl border px-3.5 py-3 text-left transition ${
              selected
                ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]"
                : "border-[var(--color-border)] bg-white hover:border-[var(--color-primary)]/50"
            } disabled:cursor-not-allowed disabled:opacity-55`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--color-text)]">
                  {template.name}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {template.language}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
                {categoryLabel(template.category)}
              </span>
            </div>
            {template.body?.text && (
              <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
                {template.body.text}
              </p>
            )}
            {!template.sendable && (
              <p className="mt-2 text-[10px] font-medium leading-4 text-amber-700">
                {template.unsupportedReason}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function WhatsAppTemplateModal({
  contact,
  onClose,
  onSent,
  onOptInRecorded,
}) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [values, setValues] = useState({ header: [], body: [] });
  const [optInSource, setOptInSource] = useState("");
  const [recordingOptIn, setRecordingOptIn] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");

  const contactId = contact?.contact_id ?? contact?.id;

  async function loadCatalog() {
    if (!contactId) return;
    setLoading(true);
    setLoadError("");
    try {
      const data = await api.listWhatsAppTemplates(contactId);
      setCatalog(data);
      const firstSendable = (data.templates || []).find((template) => template.sendable);
      if (firstSendable) {
        const key = `${firstSendable.name}::${firstSendable.language}`;
        setSelectedKey((current) => current || key);
        setValues((current) =>
          current.header.length || current.body.length
            ? current
            : emptyValuesFor(firstSendable)
        );
      }
    } catch (err) {
      setLoadError(err.message || "Couldn't load WhatsApp templates.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCatalog(null);
    setSelectedKey("");
    setValues({ header: [], body: [] });
    setOptInSource("");
    setActionError("");
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const selected = useMemo(
    () =>
      (catalog?.templates || []).find(
        (template) => `${template.name}::${template.language}` === selectedKey
      ) || null,
    [catalog, selectedKey]
  );

  const preview = useMemo(
    () => templatePreview(selected, values),
    [selected, values]
  );

  function chooseTemplate(template) {
    setSelectedKey(`${template.name}::${template.language}`);
    setValues(emptyValuesFor(template));
    setActionError("");
  }

  function updateVariable(field, nextValue) {
    setValues((current) => {
      const next = {
        header: [...current.header],
        body: [...current.body],
      };
      const target = next[field.component];
      while (target.length < field.index) target.push("");
      target[field.index - 1] = nextValue;
      return next;
    });
  }

  async function recordOptIn(event) {
    event.preventDefault();
    const source = optInSource.trim();
    if (!source) return;
    setRecordingOptIn(true);
    setActionError("");
    try {
      const updated = await api.recordWhatsAppOptIn(contactId, source);
      setOptInSource("");
      onOptInRecorded?.(updated);
      await loadCatalog();
    } catch (err) {
      setActionError(err.message || "Couldn't record WhatsApp opt-in.");
    } finally {
      setRecordingOptIn(false);
    }
  }

  async function sendTemplate() {
    if (!selected || !catalog?.eligibility?.allowed) return;
    setSending(true);
    setActionError("");
    try {
      const result = await api.sendWhatsAppTemplate(contactId, {
        templateName: selected.name,
        languageCode: selected.language,
        values,
      });
      onSent?.(result);
      onClose();
    } catch (err) {
      setActionError(err.message || "Couldn't send this WhatsApp template.");
      if (err.policyBlocked) await loadCatalog();
    } finally {
      setSending(false);
    }
  }

  const allValuesFilled = (selected?.variableFields || []).every((field) =>
    Boolean(values[field.component]?.[field.index - 1]?.trim())
  );
  const canSend =
    catalog?.eligibility?.allowed === true &&
    selected?.sendable === true &&
    allValuesFilled &&
    !sending;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-4"
      onMouseDown={() => !sending && !recordingOptIn && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsapp-template-title"
        className="flex max-h-[94dvh] w-full max-w-2xl flex-col rounded-t-3xl bg-[var(--color-surface)] shadow-2xl sm:max-h-[88dvh] sm:rounded-3xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id="whatsapp-template-title" className="font-display text-lg font-bold">
              Send WhatsApp template
            </h2>
            <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
              {displayName(contact)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending || recordingOptIn}
            className="rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {loading && (
            <div className="flex items-center gap-2 rounded-2xl bg-[var(--color-bg)] px-4 py-5 text-sm text-[var(--color-text-muted)]">
              <Spinner />
              Loading approved templates from Meta…
            </div>
          )}

          {loadError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">
              {loadError}
            </div>
          )}

          {!loading && catalog && !catalog.eligibility?.allowed && (
            <form onSubmit={recordOptIn} className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-bold text-amber-900">WhatsApp opt-in required</p>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                {eligibilityCopy(catalog.eligibility)}
              </p>
              <label className="mt-3 block text-[11px] font-semibold text-amber-900">
                Where did the customer opt in?
                <input
                  value={optInSource}
                  onChange={(event) => setOptInSource(event.target.value)}
                  maxLength={240}
                  placeholder="e.g. Customer requested WhatsApp follow-up by phone on 29 Sep"
                  className="mt-1.5 w-full rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                />
              </label>
              <p className="mt-2 text-[10px] leading-4 text-amber-700">
                Do not use this to bypass an opt-out. Record it only when you have a real, new explicit consent source.
              </p>
              <button
                type="submit"
                disabled={recordingOptIn || optInSource.trim().length < 3}
                className="mt-3 inline-flex items-center gap-2 rounded-xl bg-amber-900 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {recordingOptIn && <Spinner />}
                {recordingOptIn ? "Recording…" : "Record opt-in"}
              </button>
            </form>
          )}

          {!loading && catalog && (
            <>
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-bold">Approved templates</h3>
                    <p className="text-[10px] text-[var(--color-text-muted)]">
                      Loaded from the configured WhatsApp Business Account
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={loadCatalog}
                    disabled={loading}
                    className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[10px] font-semibold"
                  >
                    Refresh
                  </button>
                </div>
                <TemplatePicker
                  templates={catalog.templates || []}
                  selectedKey={selectedKey}
                  onSelect={chooseTemplate}
                />
              </section>

              {selected && (
                <section className="space-y-3 rounded-2xl border border-[var(--color-border)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold">{selected.name}</h3>
                    <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
                      {selected.language}
                    </span>
                    <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
                      {categoryLabel(selected.category)}
                    </span>
                  </div>

                  {(selected.variableFields || []).map((field) => (
                    <label key={`${field.component}-${field.index}`} className="block">
                      <span className="text-[11px] font-semibold">{field.label}</span>
                      <input
                        value={values[field.component]?.[field.index - 1] || ""}
                        onChange={(event) => updateVariable(field, event.target.value)}
                        maxLength={1024}
                        placeholder={field.example ? `Example: ${field.example}` : "Enter value"}
                        className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
                      />
                    </label>
                  ))}

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                      Preview
                    </p>
                    <div className="mt-1.5 whitespace-pre-wrap rounded-xl bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6">
                      {preview || "No text preview available."}
                    </div>
                  </div>

                  {selected.category === "MARKETING" && (
                    <p className="rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-4 text-amber-800">
                      Marketing template: make sure the customer's opt-in covers this type of message.
                    </p>
                  )}
                </section>
              )}
            </>
          )}

          {actionError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
              {actionError}
            </div>
          )}
        </div>

        <footer className="border-t border-[var(--color-border)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <p className="max-w-sm text-[10px] leading-4 text-[var(--color-text-muted)]">
              This is a staff action. AI, scheduled messages and automated follow-ups do not use this template path.
            </p>
            <button
              type="button"
              onClick={sendTemplate}
              disabled={!canSend}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending && <Spinner />}
              {sending ? "Sending…" : "Send template"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
