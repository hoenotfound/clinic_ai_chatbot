import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";
import LeadDistribution from "./LeadDistribution";

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
      ? Object.fromEntries(FOLLOW_UP_LANGUAGES.map(({ key }) => [key, value.translations[key]]))
      : {
          en: settings.message || DEFAULT_FOLLOW_UP.message,
          ms: usesDefaultMessage ? DEFAULT_FOLLOW_UP.translations.ms : "",
          zh: usesDefaultMessage ? DEFAULT_FOLLOW_UP.translations.zh : "",
        },
  };
}

function toolFromQuery(value) {
  if (value === "lead-temperature") return "leadScoring";
  if (value === "lead-distribution") return "leadDistribution";
  return "followUp";
}

function queryForTool(tool) {
  if (tool === "leadScoring") return "lead-temperature";
  if (tool === "leadDistribution") return "lead-distribution";
  return "";
}

export default function Tools() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTool = toolFromQuery(searchParams.get("tool"));
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(DEFAULT_FOLLOW_UP);
  const [scoringForm, setScoringForm] = useState(DEFAULT_LEAD_SCORING);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [scoringSaving, setScoringSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState("en");
  const [translationsSource, setTranslationsSource] = useState(DEFAULT_FOLLOW_UP.message);
  const [reviewTranslations, setReviewTranslations] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [distributionDirty, setDistributionDirty] = useState(false);
  const [distributionActive, setDistributionActive] = useState(false);
  const imageInputRef = useRef(null);
  const { toasts, showToast, dismissToast } = useToasts();

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        const settings = normalizeFollowUpSettings(data.automatedFollowUp);
        const scoring = { ...DEFAULT_LEAD_SCORING, ...(data.leadScoring || {}) };
        setConfig(data);
        setForm({
          enabled: !!settings.enabled,
          delayMinutes: Number(settings.delayMinutes) || DEFAULT_FOLLOW_UP.delayMinutes,
          triggerMode: settings.triggerMode === "staff" ? "staff" : "all",
          message: settings.message || DEFAULT_FOLLOW_UP.message,
          translations: settings.translations,
          imageUrl: settings.imageUrl || "",
        });
        setScoringForm({
          enabled: !!scoring.enabled,
          inactivityMinutes: Number(scoring.inactivityMinutes),
          maxConversationMinutes: Number(scoring.maxConversationMinutes),
          maxMessages: Number(scoring.maxMessages),
        });
        setTranslationsSource(settings.message || DEFAULT_FOLLOW_UP.message);
        setDistributionActive(Boolean(data.leadDistribution?.enabled));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "Failed to load tools.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const savedSettings = normalizeFollowUpSettings(config?.automatedFollowUp);
  const savedEnabled = !!savedSettings.enabled;
  const savedScoring = { ...DEFAULT_LEAD_SCORING, ...(config?.leadScoring || {}) };
  const hasUnsavedScoringChanges =
    scoringForm.enabled !== !!savedScoring.enabled ||
    Number(scoringForm.inactivityMinutes) !== Number(savedScoring.inactivityMinutes) ||
    Number(scoringForm.maxConversationMinutes) !== Number(savedScoring.maxConversationMinutes) ||
    Number(scoringForm.maxMessages) !== Number(savedScoring.maxMessages);
  const hasUnsavedChanges =
    form.enabled !== savedEnabled ||
    Number(form.delayMinutes) !== Number(savedSettings.delayMinutes) ||
    form.triggerMode !== savedSettings.triggerMode ||
    form.message !== savedSettings.message ||
    FOLLOW_UP_LANGUAGES.some(({ key }) => form.translations[key] !== savedSettings.translations[key]) ||
    form.imageUrl !== (savedSettings.imageUrl || "");
  const translationsNeedRefresh =
    form.message.trim() !== translationsSource || !hasCompleteTranslations(form.translations);
  const translationReadyCount = FOLLOW_UP_LANGUAGES.filter(({ key }) => form.translations[key]?.trim()).length;
  const activeLanguage = FOLLOW_UP_LANGUAGES.find(({ key }) => key === translationLanguage);
  const delayDescription = useMemo(() => formatDelay(Number(form.delayMinutes)), [form.delayMinutes]);

  function currentToolHasUnsavedChanges() {
    if (activeTool === "followUp") return hasUnsavedChanges;
    if (activeTool === "leadScoring") return hasUnsavedScoringChanges;
    if (activeTool === "leadDistribution") return distributionDirty;
    return false;
  }

  function selectTool(tool) {
    if (tool === activeTool) return;
    if (
      currentToolHasUnsavedChanges() &&
      !window.confirm("You have unsaved changes in this tool. Leave without saving them?")
    ) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    const queryValue = queryForTool(tool);
    if (queryValue) next.set("tool", queryValue);
    else next.delete("tool");
    setSearchParams(next, { replace: true });
  }

  const handleDistributionDirty = useCallback((dirty) => {
    setDistributionDirty(Boolean(dirty));
  }, []);

  const handleDistributionSavedStatus = useCallback((enabled) => {
    setDistributionActive(Boolean(enabled));
  }, []);

  async function generateTranslations(message, { announce = true } = {}) {
    setTranslating(true);
    try {
      const { translations } = await api.translateFollowUp(message);
      setForm((current) => ({ ...current, translations }));
      setTranslationsSource(message);
      if (announce) showToast("Language versions updated.", "info");
      return translations;
    } catch (err) {
      showToast(err.message || "Couldn't generate the language versions.", "error");
      return null;
    } finally {
      setTranslating(false);
    }
  }

  async function handleGenerateTranslations() {
    const message = form.message.trim();
    if (!message) {
      showToast("Add the follow-up message first.", "error");
      return;
    }
    await generateTranslations(message);
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

    setSaving(true);
    try {
      let translations = Object.fromEntries(
        FOLLOW_UP_LANGUAGES.map(({ key }) => [key, form.translations[key]?.trim() || ""])
      );
      if (translationsNeedRefresh) {
        const generated = await generateTranslations(message, { announce: false });
        if (!generated) return;
        translations = generated;
      }

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
      const saved = normalizeFollowUpSettings(updated.automatedFollowUp);
      setConfig(updated);
      setForm({
        enabled: !!saved.enabled,
        delayMinutes: Number(saved.delayMinutes),
        triggerMode: saved.triggerMode,
        message: saved.message,
        translations: saved.translations,
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
        inactivityMinutes: Number(saved.inactivityMinutes),
        maxConversationMinutes: Number(saved.maxConversationMinutes),
        maxMessages: Number(saved.maxMessages),
      });
      showToast(saved.enabled ? "Automatic lead temperature is active." : "Automatic lead temperature is paused.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't save automatic lead temperature.", "error");
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

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] lg:flex-row">
      <ToolsSidebar
        activeTool={activeTool}
        onSelect={selectTool}
        followUpActive={savedEnabled}
        scoringActive={!!savedScoring.enabled}
        distributionActive={distributionActive}
      />

      <div className="min-h-0 min-w-0 flex-1">
        {activeTool === "followUp" && (
          <FollowUpTool
            form={form}
            setForm={setForm}
            savedEnabled={savedEnabled}
            hasUnsavedChanges={hasUnsavedChanges}
            translationsNeedRefresh={translationsNeedRefresh}
            translationReadyCount={translationReadyCount}
            reviewTranslations={reviewTranslations}
            setReviewTranslations={setReviewTranslations}
            translationLanguage={translationLanguage}
            setTranslationLanguage={setTranslationLanguage}
            activeLanguage={activeLanguage}
            translating={translating}
            uploadingImage={uploadingImage}
            saving={saving}
            delayDescription={delayDescription}
            imageInputRef={imageInputRef}
            onGenerateTranslations={handleGenerateTranslations}
            onImagePicked={handleImagePicked}
            onSave={handleSave}
            toasts={toasts}
            dismissToast={dismissToast}
          />
        )}

        {activeTool === "leadScoring" && (
          <LeadScoringTool
            form={scoringForm}
            setForm={setScoringForm}
            savedEnabled={!!savedScoring.enabled}
            hasUnsavedChanges={hasUnsavedScoringChanges}
            saving={scoringSaving}
            onSave={handleSaveScoring}
            toasts={toasts}
            dismissToast={dismissToast}
          />
        )}

        {activeTool === "leadDistribution" && (
          <LeadDistribution
            onDirtyChange={handleDistributionDirty}
            onSavedStatus={handleDistributionSavedStatus}
          />
        )}
      </div>
    </div>
  );
}

function FollowUpTool({
  form,
  setForm,
  savedEnabled,
  hasUnsavedChanges,
  translationsNeedRefresh,
  translationReadyCount,
  reviewTranslations,
  setReviewTranslations,
  translationLanguage,
  setTranslationLanguage,
  activeLanguage,
  translating,
  uploadingImage,
  saving,
  delayDescription,
  imageInputRef,
  onGenerateTranslations,
  onImagePicked,
  onSave,
  toasts,
  dismissToast,
}) {
  return (
    <ToolShell
      title="Automated follow-up"
      description="Send one helpful reminder when a customer has not replied to your last message."
      enabled={form.enabled}
      savedEnabled={savedEnabled}
      hasUnsavedChanges={hasUnsavedChanges}
      onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
      saveLabel="Save changes"
      saving={saving || translating}
      saveDisabled={saving || translating || uploadingImage || !hasUnsavedChanges}
      onSave={onSave}
      toasts={toasts}
      dismissToast={dismissToast}
    >
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        <div className="space-y-5">
          <Card>
            <SectionHeading number="1" title="Choose when it sends" description="Set the wait time and which outgoing messages should start the timer." />
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div>
                <label htmlFor="follow-up-delay" className="text-xs font-semibold">Wait before following up</label>
                <div className="mt-2 flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
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
                  <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">minutes</span>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Current wait: {delayDescription}.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {DELAY_PRESETS.map((preset) => (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, delayMinutes: preset.minutes }))}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${Number(form.delayMinutes) === preset.minutes ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <fieldset>
                <legend className="text-xs font-semibold">Start the timer after</legend>
                <div className="mt-2 space-y-2">
                  <Choice
                    checked={form.triggerMode === "all"}
                    label="Any outgoing message"
                    description="Messages sent by the AI or clinic staff can start the timer."
                    onChange={() => setForm((current) => ({ ...current, triggerMode: "all" }))}
                  />
                  <Choice
                    checked={form.triggerMode === "staff"}
                    label="Staff messages only"
                    description="AI replies will not start a follow-up timer."
                    onChange={() => setForm((current) => ({ ...current, triggerMode: "staff" }))}
                  />
                </div>
              </fieldset>
            </div>
          </Card>

          <Card>
            <SectionHeading number="2" title="Write the message" description="Write the main message. Language versions are generated automatically when you save." />
            <div className="mt-6 flex items-center justify-between gap-3">
              <label htmlFor="follow-up-message" className="text-xs font-semibold">Follow-up message</label>
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

            <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold">Customer languages</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
                      English · BM · 中文
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                    {translationsNeedRefresh
                      ? "Language versions will refresh automatically when you save."
                      : `${translationReadyCount} language versions are ready and matched to the customer automatically.`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewTranslations((current) => !current)}
                  className="shrink-0 text-xs font-semibold text-[var(--color-primary)] hover:underline"
                >
                  {reviewTranslations ? "Hide translations" : "Review translations"}
                </button>
              </div>

              {reviewTranslations && (
                <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11px] text-[var(--color-text-muted)]">You can review or fine-tune the generated versions before saving.</p>
                    <button
                      type="button"
                      onClick={onGenerateTranslations}
                      disabled={translating || !form.message.trim()}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--color-primary)]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50"
                    >
                      {translating && <Spinner className="h-3.5 w-3.5" />}
                      {translating ? "Generating…" : translationsNeedRefresh ? "Generate now" : "Regenerate"}
                    </button>
                  </div>

                  <div className="mt-4 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label="Follow-up language">
                    {FOLLOW_UP_LANGUAGES.map((language) => (
                      <button
                        key={language.key}
                        type="button"
                        role="tab"
                        aria-selected={translationLanguage === language.key}
                        onClick={() => setTranslationLanguage(language.key)}
                        className={`shrink-0 border-b-2 px-3 py-2 text-[11px] font-semibold ${translationLanguage === language.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-text-muted)]"}`}
                      >
                        {language.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <label htmlFor={`follow-up-${translationLanguage}`} className="text-[11px] font-semibold">{activeLanguage?.label} message</label>
                    <span className="text-[10px] text-[var(--color-text-muted)]">{form.translations[translationLanguage]?.length || 0}/1000</span>
                  </div>
                  <textarea
                    id={`follow-up-${translationLanguage}`}
                    rows="4"
                    maxLength="1000"
                    value={form.translations[translationLanguage] || ""}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        translations: { ...current.translations, [translationLanguage]: event.target.value },
                      }))
                    }
                    className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                </div>
              )}
            </div>
          </Card>

          <Card>
            <SectionHeading number="3" title="Add a graphic" description="Optional. The selected customer-language version is used as the image caption." />
            <input ref={imageInputRef} type="file" accept="image/jpeg,image/png" onChange={onImagePicked} className="hidden" />
            {form.imageUrl ? (
              <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <img src={form.imageUrl} alt="Follow-up graphic preview" className="max-h-72 w-full object-contain" />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-white px-4 py-3">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Graphic attached</span>
                  <div className="flex gap-3">
                    <button type="button" onClick={() => imageInputRef.current?.click()} disabled={uploadingImage} className="text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50">Replace</button>
                    <button type="button" onClick={() => setForm((current) => ({ ...current, imageUrl: "" }))} disabled={uploadingImage} className="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-danger)] disabled:opacity-50">Remove</button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={uploadingImage}
                className="mt-5 flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-8 text-center hover:border-[var(--color-primary)]/40 disabled:opacity-50"
              >
                {uploadingImage ? <Spinner className="h-5 w-5" /> : <ImageIcon className="h-5 w-5 text-[var(--color-primary)]" />}
                <span className="mt-2 text-xs font-semibold">{uploadingImage ? "Uploading graphic…" : "Choose a graphic"}</span>
                <span className="mt-1 text-[11px] text-[var(--color-text-muted)]">JPG or PNG, up to 5MB</span>
              </button>
            )}
          </Card>
        </div>

        <aside className="space-y-5 2xl:sticky 2xl:top-6 2xl:self-start">
          <Card>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Preview</p>
            <h2 className="mt-1 font-display text-sm font-bold">Customer message</h2>
            <div className="inbox-thread-bg mt-4 min-h-48 rounded-2xl border border-[var(--color-border)] p-4">
              <div className="ml-auto max-w-[94%] overflow-hidden rounded-2xl rounded-br-md bg-[var(--color-primary)] text-white shadow-sm">
                {form.imageUrl && <img src={form.imageUrl} alt="" className="max-h-56 w-full object-cover" />}
                <div className="px-3.5 py-2.5">
                  <p className="mb-1 text-[10px] font-semibold text-white/70">Automated follow-up</p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5">
                    {reviewTranslations
                      ? form.translations[translationLanguage] || form.message || "Your follow-up message will appear here."
                      : form.message || "Your follow-up message will appear here."}
                  </p>
                </div>
              </div>
            </div>
          </Card>
          <Card>
            <h2 className="font-display text-sm font-bold">Before it sends</h2>
            <ul className="mt-4 space-y-3">
              <Rule text="A customer reply cancels the timer immediately." />
              <Rule text="Each timer sends only one automated follow-up." />
              <Rule text="Saving does not add timers to older conversations." />
            </ul>
          </Card>
        </aside>
      </div>
    </ToolShell>
  );
}

function LeadScoringTool({ form, setForm, savedEnabled, hasUnsavedChanges, saving, onSave, toasts, dismissToast }) {
  return (
    <ToolShell
      title="Automatic Lead Temperature"
      description="Let AI update Hot / Warm / Cold when customer intent is clear. Staff-controlled temperatures always win."
      enabled={form.enabled}
      savedEnabled={savedEnabled}
      hasUnsavedChanges={hasUnsavedChanges}
      onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
      saveLabel="Save changes"
      saving={saving}
      saveDisabled={saving || !hasUnsavedChanges}
      onSave={onSave}
      toasts={toasts}
      dismissToast={dismissToast}
    >
      <div className="space-y-5">
        <Card>
          <SectionHeading title="How it works" description="The AI only changes lead temperature when there is a clear sales signal." />
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <OutcomeCard icon="🔥" title="Booking intent → Hot" text="Clear intent to book, schedule, pay or proceed can move a lead to Hot." />
            <OutcomeCard icon="❄️" title="Clear rejection → Cold" text="A clear no, rejection or loss of interest can move a lead to Cold." />
            <OutcomeCard icon="👤" title="Staff changes always win" text="A temperature set manually by staff is never overwritten automatically." />
          </div>
          <p className="mt-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
            AI conversation summaries can still run independently when automatic temperature is paused.
          </p>
        </Card>

        <details className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">
          <summary className="cursor-pointer select-none font-display text-sm font-bold">Advanced timing settings</summary>
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
            Most clinics can keep the defaults. Change these only if you want the AI to review conversations sooner or later.
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <ScoringField id="scoring-inactivity" label="Conversation quiet for" hint="5 to 30 minutes" value={form.inactivityMinutes} min="5" max="30" suffix="minutes" onChange={(value) => setForm((current) => ({ ...current, inactivityMinutes: value }))} />
            <ScoringField id="scoring-duration" label="Maximum active time" hint="30 to 120 minutes" value={form.maxConversationMinutes} min="30" max="120" suffix="minutes" onChange={(value) => setForm((current) => ({ ...current, maxConversationMinutes: value }))} />
            <ScoringField id="scoring-messages" label="Maximum chat length" hint="20 to 80 messages" value={form.maxMessages} min="20" max="80" suffix="messages" onChange={(value) => setForm((current) => ({ ...current, maxMessages: value }))} />
          </div>
        </details>
      </div>
    </ToolShell>
  );
}

function ToolShell({ title, description, enabled, savedEnabled, hasUnsavedChanges, onToggle, saveLabel, saving, saveDisabled, onSave, children, toasts, dismissToast }) {
  const automationStatus = hasUnsavedChanges
    ? enabled
      ? "Will be active after saving"
      : "Will be paused after saving"
    : savedEnabled
      ? "Currently active"
      : "Currently paused";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl pb-10">
          <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">Tools</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">{title}</h1>
                <StatusBadge active={savedEnabled} unsaved={hasUnsavedChanges} />
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">{description}</p>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(24,39,33,0.04)] sm:min-w-56">
              <div>
                <p className="text-xs font-semibold">Automation</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{automationStatus}</p>
              </div>
              <Switch checked={enabled} onChange={onToggle} ariaLabel={`Enable ${title}`} />
            </div>
          </header>

          <div className="mt-7">{children}</div>
        </div>
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(24,39,33,0.04)] backdrop-blur sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-[var(--color-accent)]" : "bg-[var(--color-primary)]"}`} />
            <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">{hasUnsavedChanges ? "You have unsaved changes" : "All changes saved"}</p>
          </div>
          <button type="button" onClick={onSave} disabled={saveDisabled} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Spinner />}
            {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </footer>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ToolsSidebar({ activeTool, onSelect, followUpActive, scoringActive, distributionActive }) {
  return (
    <aside className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:h-full lg:w-72 lg:border-b-0 lg:border-r lg:p-5">
      <div className="flex items-start justify-between gap-3 lg:block">
        <div>
          <p className="font-display text-xl font-bold">Tools</p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Automations that help your team follow up and convert more customers.</p>
        </div>
        <span className="mt-0.5 shrink-0 rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-primary)] lg:hidden">More coming</span>
      </div>

      <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:mt-5 lg:block lg:space-y-2 lg:overflow-visible lg:pb-0" aria-label="Available tools">
        <ToolNavButton active={activeTool === "followUp"} onClick={() => onSelect("followUp")} icon={<ClockIcon className="h-5 w-5" />} title="Automated follow-up" description="Follow up when a customer goes quiet" enabled={followUpActive} />
        <ToolNavButton active={activeTool === "leadScoring"} onClick={() => onSelect("leadScoring")} icon={<ScoreIcon className="h-5 w-5" />} title="Automatic Lead Temperature" description="Keep Hot / Warm / Cold updated" enabled={scoringActive} />
        <ToolNavButton active={activeTool === "leadDistribution"} onClick={() => onSelect("leadDistribution")} icon={<DistributionIcon className="h-5 w-5" />} title="Automatic Lead Distribution" description="Share new leads across Sales staff" enabled={distributionActive} />

        <p className="hidden px-1 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] lg:block">Coming soon</p>
        <ComingSoonTool icon={<CalendarIcon className="h-5 w-5" />} title="Appointment reminders" description="Reduce missed bookings automatically" />
        <ComingSoonTool icon={<MegaphoneIcon className="h-5 w-5" />} title="Promotional campaigns" description="Send offers to selected customers" />
        <ComingSoonTool icon={<StarIcon className="h-5 w-5" />} title="Review requests" description="Ask happy customers for a review" />
      </nav>
    </aside>
  );
}

function ToolNavButton({ active, onClick, icon, title, description, enabled }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full min-w-[13.5rem] items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors lg:min-w-0 ${active ? "border-[var(--color-primary)]/15 bg-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-white hover:bg-[var(--color-bg)]"}`} aria-current={active ? "page" : undefined}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--color-primary)] shadow-sm">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--color-text)]">{title}</span>
        <span className="mt-1 block text-[11px] leading-4 text-[var(--color-text-muted)]">{description}</span>
      </span>
      <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`} title={enabled ? "Active" : "Paused"} />
    </button>
  );
}

function ComingSoonTool({ icon, title, description }) {
  return (
    <div className="flex w-full min-w-[13.5rem] items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-white p-3.5 lg:min-w-0" aria-disabled="true">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg)] text-[var(--color-text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-[var(--color-text)]">{title}</span>
          <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Soon</span>
        </span>
        <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </div>
  );
}

function Card({ children }) {
  return <section className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-[0_8px_30px_rgba(24,39,33,0.035)] sm:p-6">{children}</section>;
}

function SectionHeading({ number, title, description }) {
  return (
    <div className="flex items-start gap-3">
      {number && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-light)] text-[11px] font-bold text-[var(--color-primary)]">{number}</span>}
      <div>
        <h2 className="font-display text-base font-bold">{title}</h2>
        {description && <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{description}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ active, unsaved }) {
  const className = unsaved
    ? "bg-[var(--color-accent-light)] text-[var(--color-text)]"
    : active
      ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]";
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${className}`}>{unsaved ? "Unsaved" : active ? "Active" : "Paused"}</span>;
}

function Switch({ checked, onChange, ariaLabel, disabled = false }) {
  return (
    <button type="button" role="switch" aria-label={ariaLabel} aria-checked={checked} disabled={disabled} onClick={onChange} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
      <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function Choice({ checked, label, description, onChange }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${checked ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/55" : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"}`}>
      <input type="radio" name="follow-up-trigger" checked={checked} onChange={onChange} className="sr-only" />
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>{checked && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}</span>
      <span>
        <span className="block text-xs font-semibold">{label}</span>
        <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

function OutcomeCard({ icon, title, text }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <span className="text-lg" aria-hidden="true">{icon}</span>
      <p className="mt-2 text-xs font-semibold">{title}</p>
      <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{text}</p>
    </div>
  );
}

function ScoringField({ id, label, hint, value, min, max, suffix, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold">{label}</label>
      <div className="mt-2 flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
        <input id={id} type="number" min={min} max={max} step="1" value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none" />
        <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">{suffix}</span>
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );
}

function Rule({ text }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)]">✓</span>
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

function IconBase({ children, ...props }) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{children}</svg>;
}
function ClockIcon(props) { return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function ScoreIcon(props) { return <IconBase {...props}><path d="M4 19V9M10 19V5M16 19v-7M22 19V8" strokeLinecap="round" /><path d="m3 7 6-4 6 7 6-4" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function DistributionIcon(props) { return <IconBase {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7.7 7.1 10.8 16M16.3 7.1 13.2 16M8 6h8" strokeLinecap="round" /></IconBase>; }
function ImageIcon(props) { return <IconBase {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 15-5-5L5 20" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function CalendarIcon(props) { return <IconBase {...props}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></IconBase>; }
function MegaphoneIcon(props) { return <IconBase {...props}><path d="m3 11 14-6v14L3 13z" strokeLinejoin="round" /><path d="M7 14v5" /></IconBase>; }
function StarIcon(props) { return <IconBase {...props}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" strokeLinejoin="round" /></IconBase>; }
