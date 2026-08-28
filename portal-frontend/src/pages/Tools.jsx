import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";

const DEFAULT_FOLLOW_UP = {
  enabled: false,
  delayMinutes: 120,
  triggerMode: "all",
  message: "Hi! Just checking in to see if you still need any help. Feel free to reply whenever you're ready 😊",
  imageUrl: "",
};

const MAX_FOLLOW_UP_IMAGE_BYTES = 5 * 1024 * 1024;
const FOLLOW_UP_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

const DELAY_PRESETS = [
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1380, label: "23 hours" },
];

export default function Tools() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(DEFAULT_FOLLOW_UP);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef(null);
  const { toasts, showToast, dismissToast } = useToasts();

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        const settings = { ...DEFAULT_FOLLOW_UP, ...(data.automatedFollowUp || {}) };
        setConfig(data);
        setForm({
          enabled: !!settings.enabled,
          delayMinutes: Number(settings.delayMinutes) || DEFAULT_FOLLOW_UP.delayMinutes,
          triggerMode: settings.triggerMode === "staff" ? "staff" : "all",
          message: settings.message || DEFAULT_FOLLOW_UP.message,
          imageUrl: settings.imageUrl || "",
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "Failed to load tools.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const delayDescription = useMemo(
    () => formatDelay(Number(form.delayMinutes)),
    [form.delayMinutes]
  );
  const savedSettings = { ...DEFAULT_FOLLOW_UP, ...(config?.automatedFollowUp || {}) };
  const savedEnabled = !!savedSettings.enabled;
  const hasUnsavedChanges =
    form.enabled !== savedEnabled ||
    Number(form.delayMinutes) !== Number(savedSettings.delayMinutes) ||
    form.triggerMode !== savedSettings.triggerMode ||
    form.message !== savedSettings.message ||
    form.imageUrl !== (savedSettings.imageUrl || "");

  async function handleImagePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!FOLLOW_UP_IMAGE_TYPES.has(file.type)) {
      showToast("Please choose a JPG or PNG image.", "error");
      return;
    }
    if (file.size > MAX_FOLLOW_UP_IMAGE_BYTES) {
      showToast("That image is larger than 5MB. Please choose a smaller file.", "error");
      return;
    }

    setUploadingImage(true);
    try {
      const { url } = await api.uploadFollowUpImage(file);
      setForm((current) => ({ ...current, imageUrl: url }));
    } catch (err) {
      showToast(err.message || "Couldn't upload that image.", "error");
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleSave() {
    const delayMinutes = Number(form.delayMinutes);
    const message = form.message.trim();

    if (!Number.isInteger(delayMinutes) || delayMinutes < 5 || delayMinutes > 1380) {
      showToast("Choose a delay between 5 minutes and 23 hours.", "error");
      return;
    }
    if (!message) {
      showToast("Add a follow-up message before saving.", "error");
      return;
    }
    if (message.length > 1000) {
      showToast("Keep the follow-up message under 1,000 characters.", "error");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateConfig({
        automatedFollowUp: {
          enabled: form.enabled,
          delayMinutes,
          triggerMode: form.triggerMode,
          message,
          imageUrl: form.imageUrl,
        },
      });
      const saved = updated.automatedFollowUp;
      setConfig(updated);
      setForm({
        enabled: !!saved.enabled,
        delayMinutes: saved.delayMinutes,
        triggerMode: saved.triggerMode,
        message: saved.message,
        imageUrl: saved.imageUrl || "",
      });
      showToast(saved.enabled ? "Automated follow-up is active." : "Automated follow-up is paused.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't save the follow-up tool.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-sm text-[var(--color-danger)]">Couldn't load tools: {loadError}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] lg:flex-row">
      <aside className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:h-full lg:w-72 lg:border-b-0 lg:border-r lg:p-5">
        <h1 className="font-display text-xl font-bold">Tools</h1>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
          Simple automations for daily customer follow-up.
        </p>

        <nav className="mt-5" aria-label="Available tools">
          <button
            type="button"
            className="flex w-full items-start gap-3 rounded-2xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] p-3.5 text-left"
            aria-current="page"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--color-primary)] shadow-sm">
              <ClockIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--color-text)]">Automated follow-up</span>
              <span className="mt-1 block text-[11px] leading-4 text-[var(--color-text-muted)]">
                Follow up when a customer goes quiet
              </span>
            </span>
            <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${savedEnabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`} title={savedEnabled ? "Active" : "Paused"} />
          </button>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-4xl pb-10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl font-bold sm:text-2xl">Automated follow-up</h2>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${hasUnsavedChanges ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]" : savedEnabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-white text-[var(--color-text-muted)]"}`}>
                  {hasUnsavedChanges ? "Unsaved" : savedEnabled ? "Active" : "Paused"}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                Send one gentle reminder when your last message has not received a customer reply.
              </p>
            </div>

            <label className="flex shrink-0 cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5">
              <span className="text-xs font-semibold">{form.enabled ? "Enabled" : "Disabled"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.enabled}
                onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
                className={`relative h-6 w-11 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${form.enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
              >
                <span aria-hidden="true" className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${form.enabled ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </label>
          </div>

          <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.04)] sm:p-6">
              <h3 className="font-display text-base font-bold">Follow-up settings</h3>

              <div className="mt-6">
                <label htmlFor="follow-up-delay" className="text-xs font-semibold text-[var(--color-text)]">
                  Wait before following up
                </label>
                <div className="mt-2 flex max-w-sm items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
                  <input
                    id="follow-up-delay"
                    type="number"
                    min="5"
                    max="1380"
                    step="1"
                    value={form.delayMinutes}
                    onChange={(event) => setForm((current) => ({ ...current, delayMinutes: event.target.value }))}
                    className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none"
                  />
                  <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-xs font-medium text-[var(--color-text-muted)]">minutes</span>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                  Current wait: {delayDescription}. The scheduler checks once per minute.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {DELAY_PRESETS.map((preset) => (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, delayMinutes: preset.minutes }))}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${Number(form.delayMinutes) === preset.minutes ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <label htmlFor="follow-up-trigger" className="text-xs font-semibold text-[var(--color-text)]">
                  Start the timer after
                </label>
                <select
                  id="follow-up-trigger"
                  value={form.triggerMode}
                  onChange={(event) => setForm((current) => ({ ...current, triggerMode: event.target.value }))}
                  className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                >
                  <option value="all">Any outgoing message (AI or staff)</option>
                  <option value="staff">Staff messages only</option>
                </select>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="follow-up-message" className="text-xs font-semibold text-[var(--color-text)]">
                    Follow-up message
                  </label>
                  <span className="text-[10px] text-[var(--color-text-muted)]">{form.message.length}/1000</span>
                </div>
                <textarea
                  id="follow-up-message"
                  rows="5"
                  maxLength="1000"
                  value={form.message}
                  onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
                  className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                />
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-[var(--color-text)]">Promotional graphic</p>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Optional. The message above becomes the image caption.</p>
                  </div>
                  {form.imageUrl && !uploadingImage && (
                    <button
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, imageUrl: "" }))}
                      className="text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-danger)]"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {form.imageUrl && (
                  <img
                    src={form.imageUrl}
                    alt="Follow-up graphic preview"
                    className="mt-3 max-h-56 w-full rounded-xl border border-[var(--color-border)] object-cover"
                  />
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={handleImagePicked}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploadingImage}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-xs font-semibold transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
                >
                  {uploadingImage && <Spinner className="h-3.5 w-3.5" />}
                  {uploadingImage ? "Uploading…" : form.imageUrl ? "Replace graphic" : "Upload graphic"}
                </button>
              </div>

              <div className="mt-6 flex flex-col-reverse gap-3 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[11px] leading-5 text-[var(--color-text-muted)]">
                  Enabling starts with messages sent after you save. Older chats are not backfilled.
                </p>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || uploadingImage || !hasUnsavedChanges}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                >
                  {saving && <Spinner />}
                  {saving ? "Saving…" : "Save tool"}
                </button>
              </div>
            </section>

            <div className="space-y-5">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <h3 className="font-display text-sm font-bold">Message preview</h3>
                <div className="mt-4 rounded-2xl bg-[#f5f7f5] p-4">
                  <div className="ml-auto max-w-[92%] overflow-hidden rounded-2xl rounded-br-md bg-[var(--color-primary)] text-white shadow-sm">
                    {form.imageUrl && (
                      <img src={form.imageUrl} alt="" className="max-h-52 w-full object-cover" />
                    )}
                    <div className="px-3.5 py-2.5">
                      <p className="mb-1 text-[10px] font-semibold text-white/70">Automated follow-up</p>
                      <p className="whitespace-pre-wrap break-words text-xs leading-5">
                        {form.message || "Your follow-up message will appear here."}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <h3 className="font-display text-sm font-bold">How it works</h3>
                <ol className="mt-4 space-y-4">
                  <Step number="1" text="A successful outgoing message starts the timer." />
                  <Step number="2" text="A customer reply cancels that timer immediately." />
                  <Step number="3" text="If they stay quiet, one follow-up is sent and shown in the Inbox." />
                </ol>
              </section>

              <section className="rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-5 text-[var(--color-text)]">
                <div className="flex items-start gap-3">
                  <InfoIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
                  <div>
                    <h3 className="text-xs font-bold">WhatsApp 24-hour rule</h3>
                    <p className="mt-1.5 text-[11px] leading-5 text-[var(--color-text-muted)]">
                      This tool currently applies to WhatsApp conversations. It skips a follow-up when the customer's 24-hour reply window is nearly closed. Only use promotional text or graphics for customers who agreed to receive marketing messages.
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function Step({ number, text }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-[10px] font-bold text-[var(--color-primary)]">
        {number}
      </span>
      <p className="pt-0.5 text-[11px] leading-5 text-[var(--color-text-muted)]">{text}</p>
    </li>
  );
}

function formatDelay(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "not set";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""}`;
}

function ClockIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}
