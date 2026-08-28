import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";

const DEFAULT_FOLLOW_UP = {
  enabled: false,
  delayMinutes: 120,
  triggerMode: "all",
  message: "Hi! Just checking in to see if you still need any help. Feel free to reply whenever you're ready 😊",
  translations: {
    en: "Hi! Just checking in to see if you still need any help. Feel free to reply whenever you're ready 😊",
    ms: "Hai! Saya cuma ingin bertanya sama ada anda masih memerlukan bantuan. Balas sahaja apabila anda sudah bersedia 😊",
    zh: "嗨！想跟进一下，看看您是否还需要任何帮助。方便时回复我们就可以了 😊",
  },
  imageUrl: "",
};

const DEFAULT_LEAD_SCORING = {
  enabled: false,
  inactivityMinutes: 10,
  maxConversationMinutes: 60,
  maxMessages: 40,
};

const FOLLOW_UP_LANGUAGES = [
  { key: "en", label: "English" },
  { key: "ms", label: "Bahasa Malaysia" },
  { key: "zh", label: "中文" },
];

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

function hasCompleteTranslations(value) {
  return !!value && FOLLOW_UP_LANGUAGES.every(({ key }) => value[key]?.trim());
}

function normalizeFollowUpSettings(value = {}) {
  const settings = { ...DEFAULT_FOLLOW_UP, ...value };
  const hasSavedTranslations = hasCompleteTranslations(value.translations);
  const usesDefaultMessage = settings.message === DEFAULT_FOLLOW_UP.message;

  return {
    ...settings,
    translations: hasSavedTranslations
      ? Object.fromEntries(
          FOLLOW_UP_LANGUAGES.map(({ key }) => [key, value.translations[key]])
        )
      : {
          en: settings.message || DEFAULT_FOLLOW_UP.message,
          ms: usesDefaultMessage ? DEFAULT_FOLLOW_UP.translations.ms : "",
          zh: usesDefaultMessage ? DEFAULT_FOLLOW_UP.translations.zh : "",
        },
  };
}

export default function Tools() {
  const [activeTool, setActiveTool] = useState("followUp");
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(DEFAULT_FOLLOW_UP);
  const [scoringForm, setScoringForm] = useState(DEFAULT_LEAD_SCORING);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [scoringSaving, setScoringSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState("en");
  const [translationsSource, setTranslationsSource] = useState(DEFAULT_FOLLOW_UP.message);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef(null);
  const { toasts, showToast, dismissToast } = useToasts();

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        const settings = normalizeFollowUpSettings(data.automatedFollowUp);
        setConfig(data);
        setForm({
          enabled: !!settings.enabled,
          delayMinutes: Number(settings.delayMinutes) || DEFAULT_FOLLOW_UP.delayMinutes,
          triggerMode: settings.triggerMode === "staff" ? "staff" : "all",
          message: settings.message || DEFAULT_FOLLOW_UP.message,
          translations: settings.translations,
          imageUrl: settings.imageUrl || "",
        });
        const scoring = { ...DEFAULT_LEAD_SCORING, ...(data.leadScoring || {}) };
        setScoringForm({
          enabled: !!scoring.enabled,
          inactivityMinutes: Number(scoring.inactivityMinutes),
          maxConversationMinutes: Number(scoring.maxConversationMinutes),
          maxMessages: Number(scoring.maxMessages),
        });
        setTranslationsSource(settings.message || DEFAULT_FOLLOW_UP.message);
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
  const savedSettings = normalizeFollowUpSettings(config?.automatedFollowUp);
  const hasStoredTranslations = hasCompleteTranslations(
    config?.automatedFollowUp?.translations
  );
  const savedEnabled = !!savedSettings.enabled;
  const savedScoring = {
    ...DEFAULT_LEAD_SCORING,
    ...(config?.leadScoring || {}),
  };
  const hasUnsavedScoringChanges =
    scoringForm.enabled !== !!savedScoring.enabled ||
    Number(scoringForm.inactivityMinutes) !== Number(savedScoring.inactivityMinutes) ||
    Number(scoringForm.maxConversationMinutes) !== Number(savedScoring.maxConversationMinutes) ||
    Number(scoringForm.maxMessages) !== Number(savedScoring.maxMessages);
  const hasUnsavedChanges =
    !hasStoredTranslations ||
    form.enabled !== savedEnabled ||
    Number(form.delayMinutes) !== Number(savedSettings.delayMinutes) ||
    form.triggerMode !== savedSettings.triggerMode ||
    form.message !== savedSettings.message ||
    FOLLOW_UP_LANGUAGES.some(
      ({ key }) => form.translations[key] !== savedSettings.translations[key]
    ) ||
    form.imageUrl !== (savedSettings.imageUrl || "");
  const translationsNeedReview =
    form.message.trim() !== translationsSource ||
    FOLLOW_UP_LANGUAGES.some(({ key }) => !form.translations[key].trim());
  const sourceMessageChanged = form.message.trim() !== translationsSource;
  const translationReadyCount = FOLLOW_UP_LANGUAGES.filter(({ key }) =>
    form.translations[key].trim()
  ).length;
  const activeLanguage = FOLLOW_UP_LANGUAGES.find(
    ({ key }) => key === translationLanguage
  );
  const triggerLabel =
    form.triggerMode === "staff" ? "Staff messages only" : "AI or staff messages";
  const saveStatus = translationsNeedReview
    ? "Update the language versions to save"
    : hasUnsavedChanges
      ? "You have unsaved changes"
      : "All changes saved";
  const enabledStateChanged = form.enabled !== savedEnabled;
  const automationStatus = enabledStateChanged
    ? form.enabled
      ? "Will run after saving"
      : "Will pause after saving"
    : savedEnabled
      ? "Currently active"
      : "Currently paused";

  async function handleGenerateTranslations() {
    const message = form.message.trim();
    if (!message) {
      showToast("Add the main follow-up message first.", "error");
      return;
    }

    setTranslating(true);
    try {
      const { translations } = await api.translateFollowUp(message);
      setForm((current) => ({ ...current, translations }));
      setTranslationsSource(message);
      showToast("English, Bahasa Malaysia, and Chinese versions are ready.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't generate the translations.", "error");
    } finally {
      setTranslating(false);
    }
  }

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
    if (message !== translationsSource) {
      showToast("Regenerate the language versions after changing the main message.", "error");
      return;
    }
    const translations = Object.fromEntries(
      FOLLOW_UP_LANGUAGES.map(({ key }) => [key, form.translations[key].trim()])
    );
    if (FOLLOW_UP_LANGUAGES.some(({ key }) => !translations[key])) {
      showToast("Generate or enter all three language versions before saving.", "error");
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
          translations,
          imageUrl: form.imageUrl,
        },
      });
      const saved = updated.automatedFollowUp;
      setConfig(updated);
      const normalizedSaved = normalizeFollowUpSettings(saved);
      setForm({
        enabled: !!saved.enabled,
        delayMinutes: saved.delayMinutes,
        triggerMode: saved.triggerMode,
        message: saved.message,
        translations: normalizedSaved.translations,
        imageUrl: saved.imageUrl || "",
      });
      setTranslationsSource(saved.message);
      showToast(saved.enabled ? "Automated follow-up is active." : "Automated follow-up is paused.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't save the follow-up tool.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveScoring() {
    const inactivityMinutes = Number(scoringForm.inactivityMinutes);
    const maxConversationMinutes = Number(scoringForm.maxConversationMinutes);
    const maxMessages = Number(scoringForm.maxMessages);
    if (!Number.isInteger(inactivityMinutes) || inactivityMinutes < 5 || inactivityMinutes > 30) {
      showToast("Choose a quiet period between 5 and 30 minutes.", "error");
      return;
    }
    if (!Number.isInteger(maxConversationMinutes) || maxConversationMinutes < 30 || maxConversationMinutes > 120) {
      showToast("Choose a conversation limit between 30 and 120 minutes.", "error");
      return;
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 20 || maxMessages > 80) {
      showToast("Choose a message limit between 20 and 80 messages.", "error");
      return;
    }

    setScoringSaving(true);
    try {
      const updated = await api.updateConfig({
        leadScoring: {
          enabled: scoringForm.enabled,
          inactivityMinutes,
          maxConversationMinutes,
          maxMessages,
        },
      });
      const saved = { ...DEFAULT_LEAD_SCORING, ...updated.leadScoring };
      setConfig(updated);
      setScoringForm({
        enabled: !!saved.enabled,
        inactivityMinutes: saved.inactivityMinutes,
        maxConversationMinutes: saved.maxConversationMinutes,
        maxMessages: saved.maxMessages,
      });
      showToast(saved.enabled ? "AI lead scoring is active." : "AI lead scoring is paused.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't save the lead scoring tool.", "error");
    } finally {
      setScoringSaving(false);
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

  if (activeTool === "leadScoring") {
    return (
      <LeadScoringTool
        form={scoringForm}
        setForm={setScoringForm}
        savedEnabled={!!savedScoring.enabled}
        hasUnsavedChanges={hasUnsavedScoringChanges}
        saving={scoringSaving}
        onSave={handleSaveScoring}
        activeTool={activeTool}
        onSelectTool={setActiveTool}
        followUpActive={savedEnabled}
        toasts={toasts}
        dismissToast={dismissToast}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] lg:flex-row">
      <ToolsSidebar
        activeTool={activeTool}
        onSelect={setActiveTool}
        followUpActive={savedEnabled}
        scoringActive={!!savedScoring.enabled}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl pb-10">
          <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">
                Tools
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Automated follow-up</h1>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${hasUnsavedChanges ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : savedEnabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"}`}>
                  {hasUnsavedChanges ? "Unsaved" : savedEnabled ? "Active" : "Paused"}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                Send one helpful reminder when a customer has not replied to your last message.
              </p>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(24,39,33,0.04)] sm:min-w-52">
              <div>
                <p className="text-xs font-semibold">Automation</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {automationStatus}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Enable automated follow-up"
                aria-checked={form.enabled}
                onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${form.enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
              >
                <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${form.enabled ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </header>

          <section className="mt-7 grid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:grid-cols-3 sm:divide-x sm:divide-[var(--color-border)]">
            <OverviewItem
              icon={<ClockIcon className="h-4 w-4" />}
              label="Wait time"
              value={delayDescription}
            />
            <OverviewItem
              icon={<MessageIcon className="h-4 w-4" />}
              label="Timer starts after"
              value={triggerLabel}
            />
            <OverviewItem
              icon={<LanguageIcon className="h-4 w-4" />}
              label="Message language"
              value="Matches the customer"
            />
          </section>

          <div className="mt-5 grid gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
            <div className="space-y-5">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
                <SectionHeading
                  number="1"
                  title="Choose when it sends"
                  description="Set the wait time and which outgoing messages should start the timer."
                />

                <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                  <div>
                    <label htmlFor="follow-up-delay" className="text-xs font-semibold text-[var(--color-text)]">
                      Wait before following up
                    </label>
                    <div className="mt-2 flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
                      <input
                        id="follow-up-delay"
                        type="number"
                        min="5"
                        max="1380"
                        step="1"
                        inputMode="numeric"
                        value={form.delayMinutes}
                        onChange={(event) => setForm((current) => ({ ...current, delayMinutes: event.target.value }))}
                        className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none"
                      />
                      <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-xs font-medium text-[var(--color-text-muted)]">minutes</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                      5 minutes to 23 hours. Current wait: {delayDescription}.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2" aria-label="Wait time presets">
                      {DELAY_PRESETS.map((preset) => (
                        <button
                          key={preset.minutes}
                          type="button"
                          onClick={() => setForm((current) => ({ ...current, delayMinutes: preset.minutes }))}
                          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${Number(form.delayMinutes) === preset.minutes ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <fieldset>
                    <legend className="text-xs font-semibold text-[var(--color-text)]">Start the timer after</legend>
                    <div className="mt-2 space-y-2">
                      <TriggerChoice
                        checked={form.triggerMode === "all"}
                        label="Any outgoing message"
                        description="Includes messages sent by the AI and clinic staff."
                        onChange={() => setForm((current) => ({ ...current, triggerMode: "all" }))}
                      />
                      <TriggerChoice
                        checked={form.triggerMode === "staff"}
                        label="Staff messages only"
                        description="AI replies will not start a follow-up timer."
                        onChange={() => setForm((current) => ({ ...current, triggerMode: "staff" }))}
                      />
                    </div>
                  </fieldset>
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <SectionHeading
                    number="2"
                    title="Write the message"
                    description="Create one source message, then review the versions customers may receive."
                  />
                  <span className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${translationsNeedReview ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
                    {!translationsNeedReview && <CheckIcon className="h-3 w-3" />}
                    {sourceMessageChanged
                      ? "Needs regeneration"
                      : `${translationReadyCount} of ${FOLLOW_UP_LANGUAGES.length} ready`}
                  </span>
                </div>

                <div className="mt-6">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="follow-up-message" className="text-xs font-semibold text-[var(--color-text)]">
                      Source message
                    </label>
                    <span className="text-[10px] text-[var(--color-text-muted)]">{form.message.length}/1000</span>
                  </div>
                  <textarea
                    id="follow-up-message"
                    rows="4"
                    maxLength="1000"
                    value={form.message}
                    onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
                    className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                </div>

                <div className="mt-5 border-t border-[var(--color-border)] pt-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold text-[var(--color-text)]">Customer language versions</p>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                        Recent customer messages decide which version is sent.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerateTranslations}
                      disabled={translating || !form.message.trim()}
                      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-primary)]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-50"
                    >
                      {translating && <Spinner className="h-3.5 w-3.5" />}
                      {translating ? "Generating…" : translationsNeedReview ? "Generate versions" : "Regenerate versions"}
                    </button>
                  </div>

                  {translationsNeedReview && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl bg-[var(--color-accent-light)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-text)]">
                      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                      <p>
                        {sourceMessageChanged
                          ? "The source message changed. Generate fresh language versions before saving."
                          : "Generate or complete all three language versions before saving."}
                      </p>
                    </div>
                  )}

                  <div className="mt-4 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label="Follow-up language">
                    {FOLLOW_UP_LANGUAGES.map((language) => (
                      <button
                        key={language.key}
                        type="button"
                        role="tab"
                        aria-selected={translationLanguage === language.key}
                        onClick={() => setTranslationLanguage(language.key)}
                        className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[11px] font-semibold transition-colors ${translationLanguage === language.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
                      >
                        {language.label}
                        {form.translations[language.key].trim() && <CheckIcon className="h-3 w-3" />}
                      </button>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <label htmlFor={`follow-up-${translationLanguage}`} className="text-[11px] font-semibold text-[var(--color-text)]">
                      {activeLanguage?.label} message
                    </label>
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      {form.translations[translationLanguage].length}/1000
                    </span>
                  </div>
                  <textarea
                    id={`follow-up-${translationLanguage}`}
                    rows="4"
                    maxLength="1000"
                    value={form.translations[translationLanguage]}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        translations: {
                          ...current.translations,
                          [translationLanguage]: event.target.value,
                        },
                      }))
                    }
                    className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
                <SectionHeading
                  number="3"
                  title="Add a graphic"
                  description="Optional. The selected language version is used as the image caption."
                />
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={handleImagePicked}
                  className="hidden"
                />

                {form.imageUrl ? (
                  <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <img
                      src={form.imageUrl}
                      alt="Follow-up graphic preview"
                      className="max-h-72 w-full object-contain"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-white px-4 py-3">
                      <span className="inline-flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                        <CheckIcon className="h-3.5 w-3.5 text-[var(--color-primary)]" />
                        Graphic attached
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => imageInputRef.current?.click()}
                          disabled={uploadingImage}
                          className="text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50"
                        >
                          {uploadingImage ? "Uploading…" : "Replace"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setForm((current) => ({ ...current, imageUrl: "" }))}
                          disabled={uploadingImage}
                          className="text-xs font-semibold text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-danger)] disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={uploadingImage}
                    className="mt-5 flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-8 text-center transition-colors hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-primary-light)]/30 disabled:opacity-50"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-[var(--color-primary)] shadow-sm">
                      {uploadingImage ? <Spinner className="h-4 w-4" /> : <ImageIcon className="h-5 w-5" />}
                    </span>
                    <span className="mt-3 text-xs font-semibold">
                      {uploadingImage ? "Uploading graphic…" : "Choose a graphic"}
                    </span>
                    <span className="mt-1 text-[11px] text-[var(--color-text-muted)]">JPG or PNG, up to 5MB</span>
                  </button>
                )}
              </section>
            </div>

            <aside className="space-y-5 2xl:sticky 2xl:top-6 2xl:self-start">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Preview</p>
                    <h2 className="mt-1 font-display text-sm font-bold">Customer message</h2>
                  </div>
                  <span className="rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-primary)]">
                    {activeLanguage?.label}
                  </span>
                </div>
                <div className="inbox-thread-bg mt-4 min-h-48 rounded-2xl border border-[var(--color-border)] p-4">
                  <div className="ml-auto max-w-[94%] overflow-hidden rounded-2xl rounded-br-md bg-[var(--color-primary)] text-white shadow-sm">
                    {form.imageUrl && (
                      <img src={form.imageUrl} alt="" className="max-h-56 w-full object-cover" />
                    )}
                    <div className="px-3.5 py-2.5">
                      <p className="mb-1 text-[10px] font-semibold text-white/70">Automated follow-up</p>
                      <p className="whitespace-pre-wrap break-words text-xs leading-5">
                        {form.translations[translationLanguage] || "This language version will appear here."}
                      </p>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  Select a language tab in the message section to preview each version.
                </p>
              </section>

              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                <h2 className="font-display text-sm font-bold">Before it sends</h2>
                <ul className="mt-4 space-y-3">
                  <Rule text="A customer reply cancels the timer immediately." />
                  <Rule text="Each timer sends only one automated follow-up." />
                  <Rule text="Saving does not add timers to older conversations." />
                </ul>
              </section>
            </aside>
          </div>
        </div>
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${translationsNeedReview || hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
            <p className={`truncate text-xs font-medium ${translationsNeedReview ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
              {saveStatus}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || translating || uploadingImage || translationsNeedReview || !hasUnsavedChanges}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Spinner />}
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </footer>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function LeadScoringTool({
  form,
  setForm,
  savedEnabled,
  hasUnsavedChanges,
  saving,
  onSave,
  activeTool,
  onSelectTool,
  followUpActive,
  toasts,
  dismissToast,
}) {
  const enabledStateChanged = form.enabled !== savedEnabled;
  const automationStatus = enabledStateChanged
    ? form.enabled
      ? "Will run after saving"
      : "Will pause after saving"
    : savedEnabled
      ? "Currently active"
      : "Currently paused";

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] lg:flex-row">
      <ToolsSidebar
        activeTool={activeTool}
        onSelect={onSelectTool}
        followUpActive={followUpActive}
        scoringActive={savedEnabled}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-6xl pb-10">
            <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">
                  Tools
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                  <h1 className="font-display text-2xl font-bold sm:text-3xl">AI lead scoring</h1>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${hasUnsavedChanges ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : savedEnabled ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"}`}>
                    {hasUnsavedChanges ? "Unsaved" : savedEnabled ? "Active" : "Paused"}
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                  Review a conversation after it quiets down and keep the lead temperature current.
                </p>
              </div>

              <div className="flex shrink-0 items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(24,39,33,0.04)] sm:min-w-52">
                <div>
                  <p className="text-xs font-semibold">Automation</p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{automationStatus}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Enable AI lead scoring"
                  aria-checked={form.enabled}
                  onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 ${form.enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                >
                  <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${form.enabled ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            </header>

            <section className="mt-7 grid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:grid-cols-3 sm:divide-x sm:divide-[var(--color-border)]">
              <OverviewItem icon={<QuietIcon className="h-4 w-4" />} label="Quiet period" value={`${form.inactivityMinutes} minutes`} />
              <OverviewItem icon={<ClockIcon className="h-4 w-4" />} label="Time ceiling" value={`${form.maxConversationMinutes} minutes`} />
              <OverviewItem icon={<MessageIcon className="h-4 w-4" />} label="Message ceiling" value={`${form.maxMessages} messages`} />
            </section>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
              <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
                <SectionHeading
                  number="1"
                  title="Choose when AI reviews the chat"
                  description="The first limit reached creates one scoring pass. New messages begin the next pass."
                />
                <div className="mt-6 grid gap-4 md:grid-cols-3">
                  <ScoringField
                    id="scoring-inactivity"
                    label="Conversation quiet for"
                    hint="5 to 30 minutes"
                    value={form.inactivityMinutes}
                    min="5"
                    max="30"
                    suffix="minutes"
                    onChange={(value) => setForm((current) => ({ ...current, inactivityMinutes: value }))}
                  />
                  <ScoringField
                    id="scoring-duration"
                    label="Maximum active time"
                    hint="30 to 120 minutes"
                    value={form.maxConversationMinutes}
                    min="30"
                    max="120"
                    suffix="minutes"
                    onChange={(value) => setForm((current) => ({ ...current, maxConversationMinutes: value }))}
                  />
                  <ScoringField
                    id="scoring-messages"
                    label="Maximum chat length"
                    hint="20 to 80 messages"
                    value={form.maxMessages}
                    min="20"
                    max="80"
                    suffix="messages"
                    onChange={(value) => setForm((current) => ({ ...current, maxMessages: value }))}
                  />
                </div>

                <div className="mt-6 rounded-2xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)]/45 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--color-primary)] shadow-sm">
                      <ScoreIcon className="h-5 w-5" />
                    </span>
                    <div>
                      <h2 className="text-sm font-semibold">Immediate rules stay active</h2>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                        Clear booking intent can move Warm to Hot immediately, while an explicit rejection can move it to Cold. The AI review later considers the recent conversation context and may update any automatically managed temperature.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="space-y-5">
                <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)]">
                  <h2 className="font-display text-sm font-bold">How a score is applied</h2>
                  <ul className="mt-4 space-y-3">
                    <Rule text="High-confidence scores update automatic temperatures." />
                    <Rule text="Medium and low confidence scores are recorded without changing the lead." />
                    <Rule text="A staff-controlled temperature always wins." />
                    <Rule text="Silence alone never makes a lead Cold." />
                  </ul>
                </section>
                <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5">
                  <h2 className="font-display text-sm font-bold">Safe activation</h2>
                  <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                    Only customer activity after you enable this tool is eligible. Old chats will not create a sudden batch of AI requests.
                  </p>
                </section>
              </aside>
            </div>
          </div>
        </main>

        <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
              <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">
                {hasUnsavedChanges ? "You have unsaved changes" : "All changes saved"}
              </p>
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !hasUnsavedChanges}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Spinner />}
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </footer>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ScoringField({ id, label, hint, value, min, max, suffix, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold text-[var(--color-text)]">{label}</label>
      <div className="mt-2 flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step="1"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none"
        />
        <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-[11px] font-medium text-[var(--color-text-muted)]">{suffix}</span>
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );
}

function ToolsSidebar({ activeTool, onSelect, followUpActive, scoringActive }) {
  return (
    <aside className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:h-full lg:w-72 lg:border-b-0 lg:border-r lg:p-5">
      <div className="flex items-start justify-between gap-3 lg:block">
        <div>
          <p className="font-display text-xl font-bold">Tools</p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Automations that help your team follow up and convert more customers.
          </p>
        </div>
        <span className="mt-0.5 shrink-0 rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-primary)] lg:hidden">
          More coming
        </span>
      </div>

      <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:mt-5 lg:block lg:space-y-2 lg:overflow-visible lg:pb-0" aria-label="Available tools">
        <button
          type="button"
          onClick={() => onSelect("followUp")}
          className={`flex w-full min-w-[13.5rem] items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors lg:min-w-0 ${activeTool === "followUp" ? "border-[var(--color-primary)]/15 bg-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-white hover:bg-[var(--color-bg)]"}`}
          aria-current={activeTool === "followUp" ? "page" : undefined}
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
          <span
            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${followUpActive ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
            title={followUpActive ? "Active" : "Paused"}
          />
        </button>

        <button
          type="button"
          onClick={() => onSelect("leadScoring")}
          className={`flex w-full min-w-[13.5rem] items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors lg:min-w-0 ${activeTool === "leadScoring" ? "border-[var(--color-primary)]/15 bg-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-white hover:bg-[var(--color-bg)]"}`}
          aria-current={activeTool === "leadScoring" ? "page" : undefined}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--color-primary)] shadow-sm">
            <ScoreIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[var(--color-text)]">AI lead scoring</span>
            <span className="mt-1 block text-[11px] leading-4 text-[var(--color-text-muted)]">
              Review lead intent after chats quiet down
            </span>
          </span>
          <span
            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${scoringActive ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
            title={scoringActive ? "Active" : "Paused"}
          />
        </button>

        <p className="hidden px-1 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] lg:block">
          Coming soon
        </p>
        <ComingSoonTool
          icon={<CalendarIcon className="h-5 w-5" />}
          title="Appointment reminders"
          description="Reduce missed bookings automatically"
        />
        <ComingSoonTool
          icon={<MegaphoneIcon className="h-5 w-5" />}
          title="Promotional campaigns"
          description="Send offers to selected customers"
        />
        <ComingSoonTool
          icon={<StarIcon className="h-5 w-5" />}
          title="Review requests"
          description="Ask happy customers for a review"
        />
      </nav>
    </aside>
  );
}

function ComingSoonTool({ icon, title, description }) {
  return (
    <div
      className="flex w-full min-w-[13.5rem] items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-white p-3.5 lg:min-w-0"
      aria-disabled="true"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg)] text-[var(--color-text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-[var(--color-text)]">{title}</span>
          <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Soon
          </span>
        </span>
        <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </div>
  );
}

function SectionHeading({ number, title, description }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-light)] text-[11px] font-bold text-[var(--color-primary)]">
        {number}
      </span>
      <div>
        <h2 className="font-display text-base font-bold">{title}</h2>
        <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{description}</p>
      </div>
    </div>
  );
}

function OverviewItem({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3.5 last:border-b-0 sm:border-b-0 sm:px-5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium text-[var(--color-text-muted)]">{label}</p>
        <p className="mt-0.5 truncate text-xs font-semibold text-[var(--color-text)]">{value}</p>
      </div>
    </div>
  );
}

function TriggerChoice({ checked, label, description, onChange }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]/25 ${checked ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/55" : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"}`}>
      <input
        type="radio"
        name="follow-up-trigger"
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}
      </span>
      <span>
        <span className="block text-xs font-semibold text-[var(--color-text)]">{label}</span>
        <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

function Rule({ text }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)]">
        <CheckIcon className="h-2.5 w-2.5" />
      </span>
      <p className="text-[11px] leading-5 text-[var(--color-text-muted)]">{text}</p>
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

function MessageIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20 15a3 3 0 0 1-3 3H8l-4 3v-6a3 3 0 0 1-1-2.2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function QuietIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 9v6M9 7v10M13 10v4M17 8v8M21 11v2" strokeLinecap="round" />
    </svg>
  );
}

function ScoreIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V8" strokeLinecap="round" />
      <path d="m3 7 6-4 6 7 6-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LanguageIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" strokeLinecap="round" />
    </svg>
  );
}

function CalendarIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" strokeLinecap="round" />
    </svg>
  );
}

function MegaphoneIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m3 11 14-6v14L3 13zM17 9a4 4 0 0 1 0 6M6 14l1.5 6h3L9 13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StarIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" strokeLinejoin="round" />
    </svg>
  );
}

function ImageIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4 17 4.5-4.5 3.5 3 2.5-2.5 5.5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon(props) {
  return (
    <svg {...props} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden="true">
      <path d="m4 10 3.5 3.5L16 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon(props) {
  return (
    <svg {...props} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8.4 3.2 2.3 14a1.8 1.8 0 0 0 1.6 2.7h12.2a1.8 1.8 0 0 0 1.6-2.7L11.6 3.2a1.8 1.8 0 0 0-3.2 0Z" strokeLinejoin="round" />
      <path d="M10 7v3.5M10 13.5h.01" strokeLinecap="round" />
    </svg>
  );
}
