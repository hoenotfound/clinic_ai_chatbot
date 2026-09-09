import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { useAuth } from "../context/AuthContext";
import { getBusinessTerminology } from "../utils/businessTerminology";
import {
  CLIENT_SETUP_CONFIG_STEPS,
  getClientSetupCompletion,
  isPlaceholderBusinessName,
  readClientSetupProgress,
  validClientSetupScreen,
  writeClientSetupProgress,
} from "../utils/clientSetupWizard";

const INPUT_CLASS =
  "min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20";
const TEXTAREA_CLASS = `${INPUT_CLASS} resize-y`;
const FLOW = [
  "welcome",
  "business",
  "locations",
  "operating",
  "offerings",
  "knowledge",
  "aiBehavior",
  "handoff",
  "promotions",
  "review",
  "goLive",
];
const PROFILE_OPTIONS = [
  { value: "aesthetic_clinic", label: "Aesthetic Clinic" },
  { value: "home_renovation", label: "Home Renovation" },
  { value: "generic", label: "General Business" },
];
const MAX_PROMO_IMAGE_BYTES = 5 * 1024 * 1024;
const PROMO_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function text(value) {
  return String(value || "");
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function industryName(type) {
  if (type === "aesthetic_clinic") return "Aesthetic Clinic";
  if (type === "home_renovation") return "Home Renovation";
  return "General Business";
}

function nextScreen(screen) {
  const index = FLOW.indexOf(screen);
  return FLOW[Math.min(FLOW.length - 1, index + 1)] || "review";
}

function previousScreen(screen) {
  const index = FLOW.indexOf(screen);
  return FLOW[Math.max(0, index - 1)] || "welcome";
}

function cleanList(items, mapper) {
  return (items || []).map(mapper).filter(Boolean);
}

function cleanBranches(items) {
  return cleanList(items, (item) => {
    const name = text(item?.name).trim();
    const address = text(item?.address).trim();
    const phone = text(item?.phone).trim();
    const whatsapp = text(item?.whatsapp).trim();
    if (!name && !address && !phone && !whatsapp) return null;
    return { name, address, phone, whatsapp: whatsapp || null };
  });
}

function cleanServices(items) {
  return cleanList(items, (item) => {
    const name = text(item?.name).trim();
    const description = text(item?.description).trim();
    const priceRange = text(item?.priceRange).trim();
    const duration = text(item?.duration).trim();
    if (!name && !description && !priceRange && !duration) return null;
    return { name, description, priceRange, duration };
  });
}

function cleanAliases(items) {
  return cleanList(items, (item) => {
    const alias = text(item?.alias).trim();
    const officialService = text(item?.officialService).trim();
    if (!alias && !officialService) return null;
    return { alias, officialService };
  });
}

function cleanFaqs(items) {
  return cleanList(items, (item) => {
    const q = text(item?.q).trim();
    const a = text(item?.a).trim();
    if (!q && !a) return null;
    return { q, a };
  });
}

function cleanPromotions(items) {
  return cleanList(items, (item) => {
    const name = text(item?.name).trim();
    const imageUrl = text(item?.imageUrl).trim();
    const caption = text(item?.caption).trim();
    const validFrom = text(item?.validFrom).trim();
    const validUntil = text(item?.validUntil).trim();
    if (!name && !imageUrl && !caption && !validFrom && !validUntil) return null;
    return {
      name,
      imageUrl,
      caption,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
    };
  });
}

function cleanStrings(items) {
  return (items || []).map((item) => text(item).trim()).filter(Boolean);
}

function isValidWhatsapp(value) {
  const input = text(value).trim();
  if (!input) return true;
  if (/^https?:\/\/(?:api\.)?whatsapp\.com\//i.test(input)) return true;
  if (/^https?:\/\/wa\.me\/\d{8,15}(?:\?.*)?$/i.test(input)) return true;
  const compact = input.replace(/[\s()\-]/g, "");
  return /^\+?\d{8,15}$/.test(compact);
}

function isIsoDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function sectionSnapshot(screen, source = {}) {
  switch (screen) {
    case "business":
      return {
        businessName: source.businessName || source.clinicName || "",
        businessDescription: source.businessDescription || "",
        aiAssistantName: source.aiAssistantName || "",
        introMessage: source.introMessage || "",
      };
    case "locations":
      return { branches: source.branches || [], serviceAreas: source.serviceAreas || [] };
    case "operating":
      return { hours: source.hours || {}, contact: source.contact || {} };
    case "offerings":
      return { services: source.services || [], serviceAliases: source.serviceAliases || [] };
    case "knowledge":
      return { faqs: source.faqs || [] };
    case "aiBehavior":
      return {
        tone: source.tone || "",
        messagingStyle: source.messagingStyle || "",
        closingPlaybook: source.closingPlaybook || "",
        sop: source.sop || "",
      };
    case "handoff":
      return { escalation: source.escalation || {}, guardrails: source.guardrails || [] };
    case "promotions":
      return { promotions: source.promotions || [] };
    default:
      return null;
  }
}

function hasUnsavedChanges(screen, draft, config) {
  if (!CLIENT_SETUP_CONFIG_STEPS.includes(screen) || !draft || !config) return false;
  return JSON.stringify(sectionSnapshot(screen, draft)) !== JSON.stringify(sectionSnapshot(screen, config));
}

export default function ClientSetupWizard() {
  const { username } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState(null);
  const [screen, setScreen] = useState("welcome");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [technical, setTechnical] = useState(null);
  const [technicalLoading, setTechnicalLoading] = useState(false);
  const [technicalAttempted, setTechnicalAttempted] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [profileChoice, setProfileChoice] = useState("aesthetic_clinic");
  const [profileSaving, setProfileSaving] = useState(false);
  const [protectedGuardrails, setProtectedGuardrails] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getConfig()
      .then((loaded) => {
        if (cancelled) return;
        const progress = readClientSetupProgress(username, loaded.businessType);
        const resumeAt = validClientSetupScreen(progress?.lastScreen);
        setConfig(loaded);
        setDraft(cloneConfig(loaded));
        setProfileChoice(loaded.businessType || "aesthetic_clinic");
        setProtectedGuardrails(cleanStrings(loaded.clientSetup?.protectedGuardrails || []));
        setScreen(progress?.started && !progress?.completed ? resumeAt : "welcome");
        writeClientSetupProgress(username, loaded.businessType, {
          started: true,
          dismissed: false,
          completed: progress?.completed === true,
          lastScreen: progress?.started && !progress?.completed ? resumeAt : "welcome",
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Couldn't load the client setup.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [username]);

  useEffect(() => {
    if (screen !== "goLive" || technicalAttempted) return;
    setTechnicalAttempted(true);
    setTechnicalLoading(true);
    api.getSetupStatus()
      .then((data) => setTechnical(data))
      .catch((err) => setError(err.message || "Couldn't load technical readiness."))
      .finally(() => setTechnicalLoading(false));
  }, [screen, technicalAttempted]);

  const completion = useMemo(() => getClientSetupCompletion(config || {}), [config]);
  const ui = getBusinessTerminology(config || {});
  const currentConfigStep = CLIENT_SETUP_CONFIG_STEPS.indexOf(screen);
  const progressPercent = completion.requiredTotal > 0
    ? Math.round((completion.requiredCompletedCount / completion.requiredTotal) * 100)
    : 0;

  function setDraftValue(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function rememberScreen(next, extra = {}, configOverride = null) {
    const source = configOverride || config;
    if (!source) return;
    writeClientSetupProgress(username, source.businessType, {
      lastScreen: next,
      ...extra,
    });
  }

  function goTo(next) {
    const safe = validClientSetupScreen(next);
    if (safe === screen) return;
    if (hasUnsavedChanges(screen, draft, config)) {
      const discard = window.confirm("You have unsaved changes in this section. Discard them and continue?");
      if (!discard) return;
      setDraft(cloneConfig(config));
    }
    setError("");
    setScreen(safe);
    rememberScreen(safe, { dismissed: false });
  }

  async function savePayload(payload) {
    setSaving(true);
    setError("");
    try {
      const updated = await api.updateConfig(payload);
      setConfig(updated);
      setDraft(cloneConfig(updated));
      setAnnouncement("Section saved.");
      return true;
    } catch (err) {
      setError(err.message || "Couldn't save this section.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function confirmBusinessProfile() {
    if (profileSaving || config?.industrySetup?.locked === true) return;
    setProfileSaving(true);
    setError("");
    try {
      await api.selectBusinessProfile(profileChoice);
      const loaded = await api.getConfig();
      setConfig(loaded);
      setDraft(cloneConfig(loaded));
      setProfileChoice(loaded.businessType);
      setProtectedGuardrails(cleanStrings(loaded.clientSetup?.protectedGuardrails || []));
      writeClientSetupProgress(username, loaded.businessType, {
        started: true,
        dismissed: false,
        completed: false,
        lastScreen: "business",
      });
      setScreen("business");
      setAnnouncement(`Business profile confirmed as ${industryName(loaded.businessType)}.`);
    } catch (err) {
      setError(err.message || "Couldn't confirm the business profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  function validateBusiness() {
    if (config?.industrySetup?.locked !== true) {
      return "Confirm the business profile before saving client business information.";
    }
    const businessName = text(draft.businessName || draft.clinicName).trim();
    if (!businessName || isPlaceholderBusinessName(businessName)) return "Enter the client's real business name.";
    if (!text(draft.businessDescription).trim()) return "Describe what this business does.";
    if (!text(draft.aiAssistantName).trim()) return "Enter the AI assistant name.";
    if (!text(draft.introMessage).trim()) return "Enter the intro message.";
    return "";
  }

  function validateLocations() {
    const branches = cleanBranches(draft.branches);
    if (branches.some((item) => !item.name)) return `Every ${ui.locationSingular} needs a name.`;
    if (config.businessType === "aesthetic_clinic") {
      if (branches.length === 0) return "Add at least one clinic branch before completing setup.";
      if (branches.some((item) => !item.address)) return "Every clinic branch needs an address.";
    }
    return "";
  }

  function validateOperating() {
    if (!text(draft?.hours?.general).trim() || /not configured yet/i.test(text(draft?.hours?.general))) {
      return "Enter the business's real operating hours.";
    }
    if (!isValidWhatsapp(draft?.contact?.whatsapp)) {
      return "Enter a valid WhatsApp number or WhatsApp link.";
    }
    return "";
  }

  function validateOfferings() {
    const services = cleanServices(draft.services);
    const aliases = cleanAliases(draft.serviceAliases);
    if (services.some((item) => !item.name)) return `Every ${ui.serviceSingular} needs a name.`;
    if (services.length === 0) return `Add at least one ${ui.serviceSingular}.`;
    if (aliases.some((item) => !item.alias || !item.officialService)) {
      return "Every service term needs both the customer wording and the service it maps to.";
    }
    const serviceNames = new Set(services.map((item) => item.name.toLowerCase()));
    if (aliases.some((item) => !serviceNames.has(item.officialService.toLowerCase()))) {
      return "Every service term must map to a service currently listed above.";
    }
    return "";
  }

  function validateKnowledge() {
    const faqs = cleanFaqs(draft.faqs);
    if (faqs.some((item) => !item.q || !item.a)) return "Every FAQ needs both a question and an answer.";
    return "";
  }

  function validatePromotions() {
    const promotions = cleanPromotions(draft.promotions);
    if (promotions.some((item) => !item.name)) return "Every promotion needs a name.";
    for (const promotion of promotions) {
      if (!isIsoDate(promotion.validFrom) || !isIsoDate(promotion.validUntil)) {
        return "Promotion dates must use a valid YYYY-MM-DD date.";
      }
      if (promotion.validFrom && promotion.validUntil && promotion.validUntil < promotion.validFrom) {
        return `The end date for ${promotion.name} cannot be before its start date.`;
      }
    }
    return "";
  }

  async function saveCurrent({ continueAfter = false } = {}) {
    let validation = "";
    let payload = null;

    if (screen === "business") {
      validation = validateBusiness();
      payload = {
        businessName: text(draft.businessName || draft.clinicName).trim(),
        businessDescription: text(draft.businessDescription).trim(),
        aiAssistantName: text(draft.aiAssistantName).trim(),
        introMessage: text(draft.introMessage).trim(),
      };
    } else if (screen === "locations") {
      validation = validateLocations();
      payload = {
        branches: cleanBranches(draft.branches),
        ...(config.businessType === "home_renovation" ? { serviceAreas: cleanStrings(draft.serviceAreas) } : {}),
      };
    } else if (screen === "operating") {
      validation = validateOperating();
      payload = {
        hours: {
          general: text(draft?.hours?.general).trim(),
          closed: text(draft?.hours?.closed).trim(),
        },
        contact: {
          whatsapp: text(draft?.contact?.whatsapp).trim(),
          instagram: text(draft?.contact?.instagram).trim(),
          facebook: text(draft?.contact?.facebook).trim(),
          tiktok: text(draft?.contact?.tiktok).trim(),
        },
      };
    } else if (screen === "offerings") {
      validation = validateOfferings();
      payload = {
        services: cleanServices(draft.services),
        serviceAliases: cleanAliases(draft.serviceAliases),
      };
    } else if (screen === "knowledge") {
      validation = validateKnowledge();
      payload = { faqs: cleanFaqs(draft.faqs) };
    } else if (screen === "aiBehavior") {
      if (!text(draft.tone).trim()) validation = "Set the AI tone.";
      else if (!text(draft.messagingStyle).trim()) validation = "Keep the texting style instructions.";
      else if (!text(draft.closingPlaybook).trim()) validation = "Keep the sales/conversation playbook.";
      else if (!text(draft.sop).trim()) validation = "Keep the operating instructions.";
      payload = {
        tone: text(draft.tone).trim(),
        messagingStyle: text(draft.messagingStyle),
        closingPlaybook: text(draft.closingPlaybook),
        sop: text(draft.sop),
      };
    } else if (screen === "handoff") {
      const triggers = cleanStrings(draft?.escalation?.outOfScopeTriggers);
      const guardrails = cleanStrings(draft.guardrails);
      if (!text(draft?.escalation?.handoffMessage).trim()) validation = "Set the handoff message.";
      else if (triggers.length === 0) validation = "Keep at least one handoff trigger.";
      else if (guardrails.length === 0) validation = "Keep at least one AI guardrail.";
      else if (protectedGuardrails.some((rule) => !guardrails.includes(rule))) validation = "Built-in safety rules cannot be removed in Client Setup.";
      payload = {
        escalation: {
          ...draft.escalation,
          outOfScopeTriggers: triggers,
          handoffMessage: text(draft?.escalation?.handoffMessage).trim(),
          handoffNote: text(draft?.escalation?.handoffNote).trim(),
        },
        guardrails,
      };
    } else if (screen === "promotions") {
      validation = validatePromotions();
      payload = { promotions: cleanPromotions(draft.promotions) };
    }

    if (validation) {
      setError(validation);
      return false;
    }

    if (payload && !(await savePayload(payload))) return false;
    if (continueAfter) goTo(nextScreen(screen));
    return true;
  }

  async function saveAndLeave() {
    if (CLIENT_SETUP_CONFIG_STEPS.includes(screen) && hasUnsavedChanges(screen, draft, config)) {
      const saved = await saveCurrent();
      if (!saved) return;
    }
    rememberScreen(screen, { dismissed: true, completed: false });
    navigate("/settings/setup");
  }

  async function runTechnicalChecks() {
    if (technicalLoading) return;
    setTechnicalAttempted(true);
    setTechnicalLoading(true);
    setError("");
    setAnnouncement("Running technical readiness checks.");
    try {
      const data = await api.runSetupChecks();
      setTechnical(data);
      setAnnouncement("Technical readiness checks complete.");
    } catch (err) {
      setError(err.message || "Couldn't run technical readiness checks.");
    } finally {
      setTechnicalLoading(false);
    }
  }

  function finishBusinessSetup() {
    if (!completion.requiredComplete) {
      setError("Complete the required business setup sections before finishing.");
      return;
    }
    rememberScreen("goLive", { completed: true, dismissed: true });
    navigate("/settings/setup");
  }

  if (loading && !config) return <LoadingState />;
  if (!config || !draft) return <LoadError error={error} />;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-primary)]">Client setup</p>
            <p className="truncate text-sm font-semibold sm:text-base">{config.businessName || config.clinicName}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs font-semibold">Required {completion.requiredCompletedCount} of {completion.requiredTotal} ready</p>
            <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-border)] sm:w-40">
              <div className="h-full rounded-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-7">
        {error && <ErrorBanner message={error} />}

        <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <WizardRail screen={screen} completion={completion} onSelect={goTo} />
          <section className="min-w-0 rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6 lg:p-7">
            {screen === "welcome" && <WelcomeStep config={config} completion={completion} ui={ui} />}
            {screen === "business" && (
              <BusinessStep
                draft={draft}
                config={config}
                setDraftValue={setDraftValue}
                profileChoice={profileChoice}
                setProfileChoice={setProfileChoice}
                profileSaving={profileSaving}
                onConfirmProfile={confirmBusinessProfile}
              />
            )}
            {screen === "locations" && <LocationsStep draft={draft} setDraft={setDraft} config={config} ui={ui} />}
            {screen === "operating" && <OperatingStep draft={draft} setDraft={setDraft} />}
            {screen === "offerings" && <OfferingsStep draft={draft} setDraft={setDraft} config={config} ui={ui} />}
            {screen === "knowledge" && <KnowledgeStep draft={draft} setDraft={setDraft} />}
            {screen === "aiBehavior" && <AiBehaviorStep draft={draft} config={config} setDraftValue={setDraftValue} ui={ui} />}
            {screen === "handoff" && <HandoffStep draft={draft} setDraft={setDraft} ui={ui} protectedGuardrails={protectedGuardrails} />}
            {screen === "promotions" && <PromotionsStep draft={draft} setDraft={setDraft} onError={setError} />}
            {screen === "review" && <ReviewStep completion={completion} onSelect={goTo} />}
            {screen === "goLive" && (
              <GoLiveStep
                completion={completion}
                technical={technical}
                technicalLoading={technicalLoading}
                technicalAttempted={technicalAttempted}
                onRunChecks={runTechnicalChecks}
                onOpenSetup={() => navigate("/settings/setup")}
              />
            )}

            <WizardActions
              screen={screen}
              saving={saving || profileSaving}
              requiredComplete={completion.requiredComplete}
              onBack={() => goTo(previousScreen(screen))}
              onContinue={() => {
                if (screen === "welcome" || screen === "review") goTo(nextScreen(screen));
                else if (screen === "goLive") finishBusinessSetup();
                else saveCurrent({ continueAfter: true });
              }}
              onSaveLater={saveAndLeave}
            />

            {currentConfigStep >= 0 && (
              <p className="mt-4 text-center text-[11px] leading-5 text-[var(--color-text-muted)]">
                Step {currentConfigStep + 1} of {CLIENT_SETUP_CONFIG_STEPS.length}. Saved changes update the live Settings configuration immediately.
              </p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function LoadingState() {
  return <div className="flex h-full items-center justify-center bg-[var(--color-bg)]"><Spinner className="h-7 w-7 text-[var(--color-primary)]" /></div>;
}

function LoadError({ error }) {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm">
        <h1 className="font-display text-xl font-bold">Couldn't open client setup</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-danger)]">{error || "The business configuration could not be loaded."}</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white">Try again</button>
      </div>
    </div>
  );
}

function ErrorBanner({ message }) {
  return <div role="alert" className="mb-4 rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm leading-6 text-[var(--color-danger)]">{message}</div>;
}

function WizardRail({ screen, completion, onSelect }) {
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-24 space-y-1">
        <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-text-muted)]">Business setup</p>
        {completion.sections.map((section) => (
          <button key={section.id} type="button" onClick={() => onSelect(section.id)} className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-xs font-semibold transition-colors ${screen === section.id ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-white"}`}>
            <span>{section.label}</span>
            <SectionStateMark section={section} />
          </button>
        ))}
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <RailButton active={screen === "review"} onClick={() => onSelect("review")}>Review</RailButton>
          <RailButton active={screen === "goLive"} onClick={() => onSelect("goLive")}>Test / Go live</RailButton>
        </div>
      </div>
    </aside>
  );
}

function SectionStateMark({ section }) {
  if (section.state === "ready" || section.state === "configured") {
    return <span aria-label="Ready">✓</span>;
  }
  if (section.state === "needs_attention") {
    return <span aria-label="Needs attention">•</span>;
  }
  return <span className="text-[9px] font-medium" aria-label="Optional">optional</span>;
}

function RailButton({ active, onClick, children }) {
  return <button type="button" onClick={onClick} className={`min-h-10 w-full rounded-xl px-3 text-left text-xs font-semibold ${active ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-white"}`}>{children}</button>;
}

function StepHeading({ eyebrow, title, description, optional = false }) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-primary)]">{eyebrow}</p>
        {optional && <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">Optional</span>}
      </div>
      <h1 className="mt-2 font-display text-2xl font-bold sm:text-3xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{description}</p>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="mb-4 block last:mb-0">
      <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-5 text-[var(--color-text-muted)]">{hint}</span>}
    </label>
  );
}

function InfoCard({ label, value, detail }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-sm font-bold">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{detail}</p>
    </div>
  );
}

function IndustryNote({ children }) {
  return <div className="mb-5 rounded-2xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] p-4 text-xs leading-5 text-[var(--color-text-muted)]">{children}</div>;
}

function WelcomeStep({ config, completion, ui }) {
  return (
    <div>
      <StepHeading eyebrow="Welcome" title="Set up this client's business" description="This guide saves into the same live configuration used by Settings and the AI. Required progress is calculated by the server from what is actually saved." />
      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Business profile" value={industryName(config.businessType)} detail={config.industrySetup?.locked ? "Confirmed and locked" : "Choose and confirm it in the next step"} />
        <InfoCard label="Required progress" value={`${completion.requiredCompletedCount} of ${completion.requiredTotal}`} detail={`${completion.optionalConfiguredCount} optional section${completion.optionalConfiguredCount === 1 ? "" : "s"} configured`} />
      </div>
      <div className="mt-5 rounded-2xl bg-[var(--color-bg)] p-4 text-sm leading-6 text-[var(--color-text-muted)]">
        <p className="font-semibold text-[var(--color-text)]">What this will cover</p>
        <p className="mt-1">{ui.locationsLabel}, {ui.servicesLabel.toLowerCase()}, FAQs, AI behaviour, human handoff, and optional promotions. Technical channel evidence remains separate from business configuration.</p>
      </div>
    </div>
  );
}

function BusinessStep({ draft, config, setDraftValue, profileChoice, setProfileChoice, profileSaving, onConfirmProfile }) {
  const locked = config.industrySetup?.locked === true;
  return (
    <div>
      <StepHeading eyebrow="1 · Business" title="Business identity" description="Confirm the industry profile, then set the identity and context the AI uses in customer conversations." />
      <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <p className="text-xs font-semibold text-[var(--color-text-muted)]">Industry profile</p>
        {locked ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="font-bold">{industryName(config.businessType)}</p>
            <span className="rounded-full bg-[var(--color-primary-light)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">Confirmed</span>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <select className={INPUT_CLASS} value={profileChoice} onChange={(event) => setProfileChoice(event.target.value)}>
              {PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <p className="text-[11px] leading-5 text-[var(--color-text-muted)]">Confirm this before entering client-specific data. The profile becomes locked once selected.</p>
            <button type="button" onClick={onConfirmProfile} disabled={profileSaving} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-semibold text-white disabled:opacity-50">
              {profileSaving && <Spinner className="h-3.5 w-3.5" />}{profileSaving ? "Confirming…" : "Confirm business profile"}
            </button>
          </div>
        )}
      </div>
      <Field label="Business name"><input className={INPUT_CLASS} value={draft.businessName || draft.clinicName || ""} onChange={(event) => setDraftValue("businessName", event.target.value)} /></Field>
      <Field label="What does this business do?" hint="A short factual description used by the AI and lead scoring. Example: Custom kitchen cabinets, wardrobes and carpentry for residential homes around Klang Valley."><textarea rows={3} className={TEXTAREA_CLASS} value={draft.businessDescription || ""} onChange={(event) => setDraftValue("businessDescription", event.target.value)} /></Field>
      <Field label="AI assistant name" hint="A friendly name for the assistant, not the business name."><input className={INPUT_CLASS} value={draft.aiAssistantName || ""} onChange={(event) => setDraftValue("aiAssistantName", event.target.value)} /></Field>
      <Field label="First-message intro" hint="Used as the configured intro for a brand-new conversation."><textarea rows={3} className={TEXTAREA_CLASS} value={draft.introMessage || ""} onChange={(event) => setDraftValue("introMessage", event.target.value)} /></Field>
    </div>
  );
}

function LocationsStep({ draft, setDraft, config, ui }) {
  const clinic = config.businessType === "aesthetic_clinic";
  const renovation = config.businessType === "home_renovation";
  return (
    <div>
      <StepHeading eyebrow="2 · Locations" title={renovation ? "Showrooms, branches & service areas" : ui.locationsLabel} optional={!clinic} description={clinic ? "Add the clinic branches used for routing and booking context." : renovation ? "Keep actual business locations separate from the areas where the team accepts renovation projects." : "Add business locations when they are useful to the customer conversation."} />
      {renovation && (
        <IndustryNote>Showrooms and branches can be used by Pipeline/team routing. Project service areas are AI knowledge only and will never become staff branches.</IndustryNote>
      )}
      <h2 className="mb-3 text-sm font-bold">{renovation ? "Actual showrooms / branches" : ui.locationsLabel}</h2>
      <ObjectList
        items={draft.branches || []}
        setItems={(branches) => setDraft((current) => ({ ...current, branches }))}
        emptyItem={{ name: "", address: "", phone: "", whatsapp: "" }}
        addLabel={`Add ${ui.locationSingular}`}
        fields={[
          { key: "name", label: "Name" },
          { key: "address", label: "Address", textarea: true },
          { key: "phone", label: "Phone" },
          { key: "whatsapp", label: "WhatsApp link (optional)" },
        ]}
      />
      {renovation && (
        <div className="mt-7 border-t border-[var(--color-border)] pt-6">
          <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-bold">Project service areas</h2><span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">Optional</span></div>
          <p className="mb-3 text-xs leading-5 text-[var(--color-text-muted)]">Add areas the renovation team normally covers, such as Klang Valley, PJ / Subang, or Johor Bahru. These do not affect Pipeline branch assignment.</p>
          <StringList items={draft.serviceAreas || []} setItems={(serviceAreas) => setDraft((current) => ({ ...current, serviceAreas }))} addLabel="Add service area" />
        </div>
      )}
    </div>
  );
}

function OperatingStep({ draft, setDraft }) {
  function setHours(key, value) {
    setDraft((current) => ({ ...current, hours: { ...current.hours, [key]: value } }));
  }
  function setContact(key, value) {
    setDraft((current) => ({ ...current, contact: { ...current.contact, [key]: value } }));
  }
  return (
    <div>
      <StepHeading eyebrow="3 · Operating details" title="Hours & contact" description="Give the AI real operating hours and customer contact channels." />
      <Field label="Operating hours"><input className={INPUT_CLASS} value={draft.hours?.general || ""} onChange={(event) => setHours("general", event.target.value)} placeholder="e.g. Mon–Sat, 10am–7pm" /></Field>
      <Field label="Closed days / note"><input className={INPUT_CLASS} value={draft.hours?.closed || ""} onChange={(event) => setHours("closed", event.target.value)} /></Field>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Main WhatsApp number" hint="Use a phone number or a wa.me / WhatsApp link."><input className={INPUT_CLASS} value={draft.contact?.whatsapp || ""} onChange={(event) => setContact("whatsapp", event.target.value)} /></Field>
        <Field label="Instagram" hint="Username or profile URL."><input className={INPUT_CLASS} value={draft.contact?.instagram || ""} onChange={(event) => setContact("instagram", event.target.value)} /></Field>
        <Field label="Facebook" hint="Page name or URL."><input className={INPUT_CLASS} value={draft.contact?.facebook || ""} onChange={(event) => setContact("facebook", event.target.value)} /></Field>
        <Field label="TikTok" hint="Username or profile URL."><input className={INPUT_CLASS} value={draft.contact?.tiktok || ""} onChange={(event) => setContact("tiktok", event.target.value)} /></Field>
      </div>
    </div>
  );
}

function OfferingsStep({ draft, setDraft, config, ui }) {
  const serviceNames = cleanServices(draft.services).map((service) => service.name).filter(Boolean);
  return (
    <div>
      <StepHeading eyebrow="4 · What the business sells" title={ui.servicesLabel} description={`Add the ${ui.servicePlural} the AI is allowed to discuss. Customer wording can be mapped to the official names below.`} />
      {config.businessType === "home_renovation" && (
        <IndustryNote>Describe enough scope for the AI to distinguish cabinetry, carpentry, whole-unit work, and other services. Pricing can stay conditional when measurements, materials, design, or site conditions affect the final quotation.</IndustryNote>
      )}
      <h2 className="mb-3 text-sm font-bold">{ui.servicesLabel}</h2>
      <ObjectList
        items={draft.services || []}
        setItems={(services) => setDraft((current) => ({ ...current, services }))}
        emptyItem={{ name: "", description: "", priceRange: "", duration: "" }}
        addLabel={`Add ${ui.serviceSingular}`}
        fields={[
          { key: "name", label: "Name" },
          { key: "description", label: "Description", textarea: true },
          { key: "priceRange", label: "Price / price range" },
          { key: "duration", label: config.businessType === "home_renovation" ? "Typical timeline / note" : "Duration" },
        ]}
      />
      <div className="my-6 border-t border-[var(--color-border)]" />
      <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-bold">Service terms</h2><span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">Optional</span></div>
      <p className="mb-3 text-xs leading-5 text-[var(--color-text-muted)]">Map shorthand, nicknames, or phrases customers use to one of the configured services.</p>
      <AliasList items={draft.serviceAliases || []} services={serviceNames} setItems={(serviceAliases) => setDraft((current) => ({ ...current, serviceAliases }))} />
    </div>
  );
}

function KnowledgeStep({ draft, setDraft }) {
  return (
    <div>
      <StepHeading eyebrow="5 · Knowledge" title="FAQs" optional description="Add common questions that should have a consistent answer. You can leave this empty and return later." />
      <ObjectList items={draft.faqs || []} setItems={(faqs) => setDraft((current) => ({ ...current, faqs }))} emptyItem={{ q: "", a: "" }} addLabel="Add FAQ" fields={[{ key: "q", label: "Question" }, { key: "a", label: "Answer", textarea: true }]} />
    </div>
  );
}

function AiBehaviorStep({ draft, config, setDraftValue, ui }) {
  return (
    <div>
      <StepHeading eyebrow="6 · AI behaviour" title="How the AI should talk and sell" description="Industry defaults are already loaded. Most client setups only need a tone check; open advanced instructions only when the business process genuinely differs." />
      {config.businessType === "home_renovation" && (
        <IndustryNote>The renovation profile already covers project location, scope, measurements, budget, timeline, photos or floor plans, and the need for measurements/site discussion before a final quotation.</IndustryNote>
      )}
      <Field label="Tone"><textarea rows={3} className={TEXTAREA_CLASS} value={draft.tone || ""} onChange={(event) => setDraftValue("tone", event.target.value)} /></Field>
      <details className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <summary className="cursor-pointer text-sm font-bold">Advanced AI instructions</summary>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">These rules directly affect live replies. Keep the industry defaults unless the client's process requires a change.</p>
        <div className="mt-5">
          <Field label="Texting style"><textarea rows={7} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.messagingStyle || ""} onChange={(event) => setDraftValue("messagingStyle", event.target.value)} /></Field>
          <Field label="Sales / conversation playbook" hint={`How the AI guides interested ${ui.customerPlural} toward the next sensible step.`}><textarea rows={9} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.closingPlaybook || ""} onChange={(event) => setDraftValue("closingPlaybook", event.target.value)} /></Field>
          <Field label="Operating instructions"><textarea rows={8} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.sop || ""} onChange={(event) => setDraftValue("sop", event.target.value)} /></Field>
        </div>
      </details>
    </div>
  );
}

function HandoffStep({ draft, setDraft, ui, protectedGuardrails }) {
  function setEscalation(key, value) {
    setDraft((current) => ({ ...current, escalation: { ...current.escalation, [key]: value } }));
  }
  const protectedSet = new Set(protectedGuardrails);
  const customGuardrails = (draft.guardrails || []).filter((rule) => !protectedSet.has(rule));
  function setCustomGuardrails(custom) {
    setDraft((current) => ({ ...current, guardrails: [...protectedGuardrails, ...custom] }));
  }
  return (
    <div>
      <StepHeading eyebrow="7 · Human handoff" title="When staff should take over" description="Keep the situations that need a person clear, plus the message customers see when the AI hands off." />
      <Field label={`Hand off when the ${ui.customerSingular} asks about...`}><StringList items={draft.escalation?.outOfScopeTriggers || []} setItems={(items) => setEscalation("outOfScopeTriggers", items)} addLabel="Add trigger" /></Field>
      <Field label="Customer handoff message"><textarea rows={3} className={TEXTAREA_CLASS} value={draft.escalation?.handoffMessage || ""} onChange={(event) => setEscalation("handoffMessage", event.target.value)} /></Field>
      <Field label="Internal handoff note"><input className={INPUT_CLASS} value={draft.escalation?.handoffNote || ""} onChange={(event) => setEscalation("handoffNote", event.target.value)} /></Field>
      <details className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <summary className="cursor-pointer text-sm font-bold">Built-in safety rules · {protectedGuardrails.length}</summary>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">These are protected in Client Setup so a first-run edit cannot accidentally remove the industry's existing safety rules.</p>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-[var(--color-text-muted)]">{protectedGuardrails.map((rule) => <li key={rule}>🔒 {rule}</li>)}</ul>
      </details>
      <Field label="Additional client-specific guardrails" hint="Optional rules on top of the built-in safety set."><StringList items={customGuardrails} setItems={setCustomGuardrails} addLabel="Add client rule" /></Field>
    </div>
  );
}

function PromotionsStep({ draft, setDraft, onError }) {
  const promotions = (draft.promotions || []).map((item) => ({ ...item, validFrom: item.validFrom || "", validUntil: item.validUntil || "" }));
  return (
    <div>
      <StepHeading eyebrow="8 · Promotions" title="Promotions" optional description="Add active promotional content only when the client wants it. Leaving this empty does not block business setup." />
      <ObjectList
        items={promotions}
        setItems={(items) => setDraft((current) => ({ ...current, promotions: items }))}
        emptyItem={{ name: "", imageUrl: "", caption: "", validFrom: "", validUntil: "" }}
        addLabel="Add promotion"
        onError={onError}
        fields={[
          { key: "name", label: "Promotion name" },
          { key: "imageUrl", label: "Promotion image", type: "image" },
          { key: "caption", label: "Caption", textarea: true },
          { key: "validFrom", label: "Valid from", type: "date" },
          { key: "validUntil", label: "Valid until", type: "date" },
        ]}
      />
    </div>
  );
}

function ReviewStep({ completion, onSelect }) {
  return (
    <div>
      <StepHeading eyebrow="Review" title="Check the business setup" description="Required readiness comes from the server-side evaluation of the currently saved live configuration." />
      <div className="space-y-2.5">
        {completion.sections.map((section) => (
          <button key={section.id} type="button" onClick={() => onSelect(section.id)} className="flex w-full items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left transition hover:bg-white">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${section.state === "ready" || section.state === "configured" ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : section.state === "needs_attention" ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : "bg-white text-[var(--color-text-muted)]"}`}>{section.state === "ready" || section.state === "configured" ? "✓" : section.state === "needs_attention" ? "!" : "–"}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold">{section.label}</span><span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">{section.required ? "Required" : section.configured ? "Optional · added" : "Optional"}</span></span>
              <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{section.missing?.length ? section.missing.join(" · ") : section.note}</span>
            </span>
            <span className="text-sm text-[var(--color-text-muted)]">›</span>
          </button>
        ))}
      </div>
      {!completion.requiredComplete && (
        <div className="mt-4 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-4 text-sm leading-6">
          <p className="font-semibold">{completion.incompleteRequired.length} required section{completion.incompleteRequired.length === 1 ? "" : "s"} still need attention.</p>
          <p className="mt-1 text-[var(--color-text-muted)]">Optional sections can remain empty without blocking business setup.</p>
        </div>
      )}
    </div>
  );
}

function GoLiveStep({ completion, technical, technicalLoading, technicalAttempted, onRunChecks, onOpenSetup }) {
  const summary = technical?.summary || {};
  const overall = technical?.systemHealth?.overall || null;
  const messaging = Array.isArray(technical?.systemHealth?.messaging) ? technical.systemHealth.messaging : [];
  const configuredMessaging = messaging.filter((item) => item.configured);
  const verifiedMessaging = configuredMessaging.filter((item) => item.roundTripCorrelated && item.lastVerifiedAutomatedReplyAt);
  const allConfiguredVerified = configuredMessaging.length > 0 && verifiedMessaging.length === configuredMessaging.length;
  const healthValue = technicalLoading ? "Checking…" : overall?.label || (technicalAttempted ? "Unavailable" : "Not checked yet");
  const proofValue = technicalLoading
    ? "Checking…"
    : configuredMessaging.length === 0
      ? "No channel configured"
      : allConfiguredVerified
        ? "Live round trip observed"
        : "Live proof still pending";

  return (
    <div>
      <StepHeading eyebrow="Test / Go live" title="Business setup + messaging evidence" description="System health and live messaging proof are shown separately so a configuration-only check cannot look like final go-live proof." />
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoCard label="Business setup" value={completion.requiredComplete ? "Complete" : "Needs attention"} detail={completion.requiredComplete ? "All required business information is saved" : `${completion.incompleteRequired.length} required section(s) incomplete`} />
        <InfoCard label="System health" value={healthValue} detail={technical ? `${summary.requiredReady || 0}/${summary.requiredTotal || 0} required Setup Status checks ready` : "Uses existing Setup Status checks"} />
        <InfoCard label="Live messaging proof" value={proofValue} detail={configuredMessaging.length ? `${verifiedMessaging.length}/${configuredMessaging.length} configured channel(s) have correlated inbound + AI-reply evidence` : "Configure a messaging channel before live proof can exist"} />
      </div>

      {configuredMessaging.length > 0 && (
        <div className="mt-5 space-y-2">
          {configuredMessaging.map((item) => {
            const verified = Boolean(item.roundTripCorrelated && item.lastVerifiedAutomatedReplyAt);
            return (
              <div key={item.channel} className="flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-bold capitalize">{item.channel}</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">System: {item.label || item.status || "Unknown"}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${verified ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)]"}`}>{verified ? "Verified AI round trip" : "Live round trip pending"}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <p className="text-sm font-bold">Technical checks</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Run the existing connection/runtime checks here. This action does not send a test message to a real customer. Real round-trip proof only appears after actual inbound traffic and a verified automated reply.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={onRunChecks} disabled={technicalLoading} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50">{technicalLoading && <Spinner className="h-4 w-4" />}{technicalLoading ? "Running checks…" : "Run technical checks"}</button>
          <button type="button" onClick={onOpenSetup} className="h-11 rounded-xl border border-[var(--color-border)] bg-white px-4 text-sm font-semibold">Open full Setup Status</button>
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">Finishing here marks only the business-configuration wizard complete. A final go-live gate must also know which messaging channels were purchased for this client; configured-channel proof shown here does not replace that provisioning requirement.</p>
    </div>
  );
}

function WizardActions({ screen, saving, requiredComplete, onBack, onContinue, onSaveLater }) {
  const isWelcome = screen === "welcome";
  const isGoLive = screen === "goLive";
  const label = isWelcome ? "Start setup" : isGoLive ? "Finish business setup" : screen === "review" ? "Continue to test / go live" : "Save & continue";
  return (
    <div className="mt-7 border-t border-[var(--color-border)] pt-5">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {!isWelcome && <button type="button" onClick={onBack} disabled={saving} className="h-11 rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-50">Back</button>}
          <button type="button" onClick={onSaveLater} disabled={saving} className="h-11 rounded-xl px-4 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-50">Save & continue later</button>
        </div>
        <button type="button" onClick={onContinue} disabled={saving || (isGoLive && !requiredComplete)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50">{saving && <Spinner className="h-4 w-4" />}{saving ? "Saving…" : label}</button>
      </div>
    </div>
  );
}

function ObjectList({ items, setItems, emptyItem, addLabel, fields, onError }) {
  function change(index, key, value) {
    const next = items.slice();
    next[index] = { ...next[index], [key]: value };
    setItems(next);
  }
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Entry {index + 1}</p><button type="button" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))} className="h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]">Remove</button></div>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className={field.textarea || field.type === "image" ? "sm:col-span-2" : ""}>
                <span className="mb-1 block text-[11px] font-semibold text-[var(--color-text-muted)]">{field.label}</span>
                {field.type === "image" ? (
                  <PromoImageField value={item?.[field.key] || ""} onChange={(value) => change(index, field.key, value)} onError={onError} />
                ) : field.textarea ? (
                  <textarea rows={3} className={TEXTAREA_CLASS} value={item?.[field.key] || ""} onChange={(event) => change(index, field.key, event.target.value)} />
                ) : (
                  <input type={field.type || "text"} className={INPUT_CLASS} value={item?.[field.key] || ""} onChange={(event) => change(index, field.key, event.target.value)} />
                )}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button type="button" onClick={() => setItems([...items, { ...emptyItem }])} className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">+ {addLabel}</button>
    </div>
  );
}

function AliasList({ items, services, setItems }) {
  function change(index, key, value) {
    const next = items.slice();
    next[index] = { ...next[index], [key]: value };
    setItems(next);
  }
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Term {index + 1}</p><button type="button" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))} className="h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-danger)]">Remove</button></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What customers type"><input className={INPUT_CLASS} value={item.alias || ""} onChange={(event) => change(index, "alias", event.target.value)} /></Field>
            <Field label="Maps to service"><select className={INPUT_CLASS} value={item.officialService || ""} onChange={(event) => change(index, "officialService", event.target.value)}><option value="">Choose a service</option>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></Field>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => setItems([...items, { alias: "", officialService: "" }])} disabled={services.length === 0} className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-50">+ Add customer term</button>
    </div>
  );
}

function StringList({ items, setItems, addLabel }) {
  function change(index, value) {
    const next = items.slice();
    next[index] = value;
    setItems(next);
  }
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2"><textarea rows={2} className={`${TEXTAREA_CLASS} min-w-0 flex-1`} value={item || ""} onChange={(event) => change(index, event.target.value)} /><button type="button" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove entry ${index + 1}`} className="h-11 w-11 shrink-0 rounded-xl text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]">✕</button></div>
      ))}
      <button type="button" onClick={() => setItems([...items, ""])} className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">+ {addLabel}</button>
    </div>
  );
}

function PromoImageField({ value, onChange, onError }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  async function pickFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!PROMO_IMAGE_TYPES.has(file.type)) {
      onError?.("Please choose a JPG or PNG image.");
      return;
    }
    if (file.size > MAX_PROMO_IMAGE_BYTES) {
      onError?.("That image is larger than 5MB. Please choose a smaller file.");
      return;
    }
    setUploading(true);
    try {
      const { url } = await api.uploadPromoImage(file);
      onChange(url);
    } catch (err) {
      onError?.(err.message || "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {value && <img src={value} alt="Promotion graphic" className="mb-2 max-h-48 w-full rounded-xl border border-[var(--color-border)] object-cover" />}
      <div className="mb-2 flex flex-wrap gap-2">
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" onChange={pickFile} className="hidden" />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-3 text-xs font-semibold disabled:opacity-50">{uploading && <Spinner className="h-3.5 w-3.5" />}{uploading ? "Uploading…" : value ? "Replace image" : "Upload image"}</button>
        {value && <button type="button" onClick={() => onChange("")} disabled={uploading} className="h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)]">Remove</button>}
      </div>
      <input className={`${INPUT_CLASS} text-xs`} value={value} placeholder="or paste an already-hosted image URL" onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
