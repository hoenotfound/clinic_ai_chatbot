import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Spinner from "../components/Spinner";
import { useAuth } from "../context/AuthContext";
import { getBusinessTerminology } from "../utils/businessTerminology";
import {
  CLIENT_SETUP_CONFIG_STEPS,
  getClientSetupCompletion,
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

function cleanNamedList(items, mapper) {
  return (items || []).map(mapper).filter(Boolean);
}

function cleanBranches(items) {
  return cleanNamedList(items, (item) => {
    const name = text(item?.name).trim();
    const address = text(item?.address).trim();
    const phone = text(item?.phone).trim();
    const whatsapp = text(item?.whatsapp).trim();
    if (!name && !address && !phone && !whatsapp) return null;
    return { name, address, phone, whatsapp: whatsapp || null };
  });
}

function cleanServices(items) {
  return cleanNamedList(items, (item) => {
    const name = text(item?.name).trim();
    const description = text(item?.description).trim();
    const priceRange = text(item?.priceRange).trim();
    const duration = text(item?.duration).trim();
    if (!name && !description && !priceRange && !duration) return null;
    return { name, description, priceRange, duration };
  });
}

function cleanAliases(items) {
  return cleanNamedList(items, (item) => {
    const alias = text(item?.alias).trim();
    const officialService = text(item?.officialService).trim();
    if (!alias && !officialService) return null;
    return { alias, officialService };
  });
}

function cleanFaqs(items) {
  return cleanNamedList(items, (item) => {
    const q = text(item?.q).trim();
    const a = text(item?.a).trim();
    if (!q && !a) return null;
    return { q, a };
  });
}

function cleanPromotions(items) {
  return cleanNamedList(items, (item) => {
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
  const [announcement, setAnnouncement] = useState("");

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
    if (screen !== "goLive" || technical || technicalLoading) return;
    let cancelled = false;
    setTechnicalLoading(true);
    api.getSetupStatus()
      .then((data) => {
        if (!cancelled) setTechnical(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Couldn't load technical readiness.");
      })
      .finally(() => {
        if (!cancelled) setTechnicalLoading(false);
      });
    return () => { cancelled = true; };
  }, [screen, technical, technicalLoading]);

  const completion = useMemo(() => getClientSetupCompletion(config || {}), [config]);
  const ui = getBusinessTerminology(config || {});
  const currentConfigStep = CLIENT_SETUP_CONFIG_STEPS.indexOf(screen);

  function setDraftValue(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function rememberScreen(next, extra = {}) {
    if (!config) return;
    writeClientSetupProgress(username, config.businessType, {
      lastScreen: next,
      ...extra,
    });
  }

  function goTo(next) {
    const safe = validClientSetupScreen(next);
    setError("");
    setScreen(safe);
    rememberScreen(safe, { dismissed: false });
  }

  async function savePayload(payload, successText) {
    setSaving(true);
    setError("");
    try {
      const updated = await api.updateConfig(payload);
      setConfig(updated);
      setDraft(cloneConfig(updated));
      setAnnouncement(successText || "Saved.");
      return updated;
    } catch (err) {
      setError(err.message || "Couldn't save this section.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  function validateBusiness() {
    if (config?.industrySetup?.locked !== true) {
      return "Confirm the business profile in Setup Status before changing client settings.";
    }
    if (!text(draft.businessName || draft.clinicName).trim()) return "Enter the business name.";
    if (!text(draft.aiAssistantName).trim()) return "Enter the AI assistant name.";
    if (!text(draft.introMessage).trim()) return "Enter the intro message.";
    return "";
  }

  function validateLocations() {
    const branches = cleanBranches(draft.branches);
    if (branches.some((item) => !item.name)) return `Every ${ui.locationSingular} needs a name.`;
    if (config.businessType === "aesthetic_clinic" && branches.length === 0) {
      return "Add at least one clinic branch before completing setup.";
    }
    return "";
  }

  function validateOfferings() {
    const services = cleanServices(draft.services);
    const aliases = cleanAliases(draft.serviceAliases);
    if (services.some((item) => !item.name)) return `Every ${ui.serviceSingular} needs a name.`;
    if (services.length === 0) return `Add at least one ${ui.serviceSingular}.`;
    if (aliases.some((item) => !item.alias)) return "Every service term needs the wording customers type.";
    return "";
  }

  function validateFaqs() {
    if (cleanFaqs(draft.faqs).some((item) => !item.q)) return "Every FAQ entry needs a question.";
    return "";
  }

  function validatePromotions() {
    if (cleanPromotions(draft.promotions).some((item) => !item.name)) return "Every promotion needs a name.";
    return "";
  }

  async function saveCurrent({ continueAfter = false } = {}) {
    let validation = "";
    let payload = null;

    switch (screen) {
      case "business":
        validation = validateBusiness();
        payload = {
          businessName: text(draft.businessName || draft.clinicName).trim(),
          aiAssistantName: text(draft.aiAssistantName).trim(),
          introMessage: text(draft.introMessage).trim(),
        };
        break;
      case "locations":
        validation = validateLocations();
        payload = { branches: cleanBranches(draft.branches) };
        break;
      case "operating":
        if (!text(draft?.hours?.general).trim() || /not configured yet/i.test(text(draft?.hours?.general))) {
          validation = "Enter the business's real operating hours.";
        }
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
        break;
      case "offerings":
        validation = validateOfferings();
        payload = {
          services: cleanServices(draft.services),
          serviceAliases: cleanAliases(draft.serviceAliases),
        };
        break;
      case "knowledge":
        validation = validateFaqs();
        payload = { faqs: cleanFaqs(draft.faqs) };
        break;
      case "aiBehavior":
        if (!text(draft.tone).trim()) validation = "Set the AI tone.";
        else if (!text(draft.messagingStyle).trim()) validation = "Set the texting style.";
        else if (!text(draft.closingPlaybook).trim()) validation = "Set the sales/conversation playbook.";
        else if (!text(draft.sop).trim()) validation = "Set the operating instructions.";
        payload = {
          tone: text(draft.tone),
          messagingStyle: text(draft.messagingStyle),
          closingPlaybook: text(draft.closingPlaybook),
          sop: text(draft.sop),
        };
        break;
      case "handoff": {
        const triggers = cleanStrings(draft?.escalation?.outOfScopeTriggers);
        const guardrails = cleanStrings(draft.guardrails);
        if (!text(draft?.escalation?.handoffMessage).trim()) validation = "Set the handoff message.";
        else if (triggers.length === 0) validation = "Keep at least one handoff trigger.";
        else if (guardrails.length === 0) validation = "Keep at least one AI guardrail.";
        payload = {
          escalation: {
            ...draft.escalation,
            outOfScopeTriggers: triggers,
            handoffMessage: text(draft?.escalation?.handoffMessage).trim(),
            handoffNote: text(draft?.escalation?.handoffNote).trim(),
          },
          guardrails,
        };
        break;
      }
      case "promotions":
        validation = validatePromotions();
        payload = { promotions: cleanPromotions(draft.promotions) };
        break;
      default:
        break;
    }

    if (validation) {
      setError(validation);
      return false;
    }

    if (payload) {
      const updated = await savePayload(payload, "Section saved.");
      if (!updated) return false;
    }

    if (continueAfter) goTo(nextScreen(screen));
    return true;
  }

  async function saveAndLeave() {
    if (CLIENT_SETUP_CONFIG_STEPS.includes(screen)) {
      const saved = await saveCurrent();
      if (!saved) return;
    }
    rememberScreen(screen, { dismissed: true, completed: false });
    navigate("/settings/setup");
  }

  async function runTechnicalChecks() {
    if (technicalLoading) return;
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

  if (loading && !config) {
    return <LoadingState />;
  }

  if (!config || !draft) {
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
            <p className="text-xs font-semibold text-[var(--color-text)]">Setup {completion.completedCount} of {completion.total} complete</p>
            <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-border)] sm:w-40">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-[width]"
                style={{ width: `${Math.round((completion.completedCount / completion.total) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-7">
        {error && (
          <div role="alert" className="mb-4 rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-4 py-3 text-sm leading-6 text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {config?.industrySetup?.locked !== true && screen !== "welcome" && (
          <div className="mb-4 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-4 text-sm leading-6">
            <p className="font-semibold">Business profile still needs confirmation.</p>
            <p className="mt-1 text-[var(--color-text-muted)]">Choose the correct industry in Setup Status before saving client business information.</p>
            <button type="button" onClick={() => navigate("/settings/setup")} className="mt-3 h-10 rounded-xl border border-[var(--color-border)] bg-white px-4 text-xs font-semibold">Open Setup Status</button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <WizardRail screen={screen} completion={completion} onSelect={goTo} />
          <section className="min-w-0 rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6 lg:p-7">
            {screen === "welcome" && <WelcomeStep config={config} completion={completion} ui={ui} />}
            {screen === "business" && <BusinessStep draft={draft} config={config} setDraftValue={setDraftValue} />}
            {screen === "locations" && <LocationsStep draft={draft} setDraft={setDraft} config={config} ui={ui} />}
            {screen === "operating" && <OperatingStep draft={draft} setDraft={setDraft} />}
            {screen === "offerings" && <OfferingsStep draft={draft} setDraft={setDraft} ui={ui} />}
            {screen === "knowledge" && <KnowledgeStep draft={draft} setDraft={setDraft} />}
            {screen === "aiBehavior" && <AiBehaviorStep draft={draft} setDraftValue={setDraftValue} ui={ui} />}
            {screen === "handoff" && <HandoffStep draft={draft} setDraft={setDraft} ui={ui} />}
            {screen === "promotions" && <PromotionsStep draft={draft} setDraft={setDraft} />}
            {screen === "review" && <ReviewStep completion={completion} onSelect={goTo} />}
            {screen === "goLive" && (
              <GoLiveStep
                completion={completion}
                technical={technical}
                technicalLoading={technicalLoading}
                onRunChecks={runTechnicalChecks}
                onOpenSetup={() => navigate("/settings/setup")}
              />
            )}

            <WizardActions
              screen={screen}
              saving={saving}
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
                Step {currentConfigStep + 1} of {CLIENT_SETUP_CONFIG_STEPS.length}. Saved changes appear in Settings immediately.
              </p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)]">
      <Spinner className="h-7 w-7 text-[var(--color-primary)]" />
    </div>
  );
}

function WizardRail({ screen, completion, onSelect }) {
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-24 space-y-1">
        <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-text-muted)]">Business setup</p>
        {completion.sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-xs font-semibold transition-colors ${screen === section.id ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-white"}`}
          >
            <span>{section.label}</span>
            <span aria-label={section.complete ? "Complete" : "Incomplete"}>{section.complete ? "✓" : section.required ? "•" : ""}</span>
          </button>
        ))}
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <button type="button" onClick={() => onSelect("review")} className={`min-h-10 w-full rounded-xl px-3 text-left text-xs font-semibold ${screen === "review" ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-white"}`}>Review</button>
          <button type="button" onClick={() => onSelect("goLive")} className={`min-h-10 w-full rounded-xl px-3 text-left text-xs font-semibold ${screen === "goLive" ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-white"}`}>Test / Go live</button>
        </div>
      </div>
    </aside>
  );
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

function WelcomeStep({ config, completion, ui }) {
  return (
    <div>
      <StepHeading
        eyebrow="Welcome"
        title="Set up this client's business"
        description="This guide saves into the same configuration used by Settings and the live AI. You can leave and resume later without creating a second copy of the business data."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Business profile" value={industryName(config.businessType)} detail={config.industrySetup?.locked ? "Confirmed and locked" : "Needs confirmation in Setup Status"} />
        <InfoCard label="Progress" value={`${completion.completedCount} of ${completion.total}`} detail="Based on the configuration actually saved" />
      </div>
      <div className="mt-5 rounded-2xl bg-[var(--color-bg)] p-4 text-sm leading-6 text-[var(--color-text-muted)]">
        <p className="font-semibold text-[var(--color-text)]">What this will cover</p>
        <p className="mt-1">{ui.locationsLabel}, {ui.servicesLabel.toLowerCase()}, FAQs, AI behaviour, human handoff, and optional promotions. Technical channel checks stay in Setup Status.</p>
      </div>
    </div>
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

function BusinessStep({ draft, config, setDraftValue }) {
  return (
    <div>
      <StepHeading eyebrow="1 · Business" title="Business identity" description="Confirm the profile and set the identity customers will see in AI conversations." />
      <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <p className="text-xs font-semibold text-[var(--color-text-muted)]">Industry profile</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p className="font-bold">{industryName(config.businessType)}</p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${config.industrySetup?.locked ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)]"}`}>{config.industrySetup?.locked ? "Confirmed" : "Needs confirmation"}</span>
        </div>
      </div>
      <Field label="Business name">
        <input className={INPUT_CLASS} value={draft.businessName || draft.clinicName || ""} onChange={(event) => setDraftValue("businessName", event.target.value)} />
      </Field>
      <Field label="AI assistant name" hint="A friendly name for the assistant, not the business name.">
        <input className={INPUT_CLASS} value={draft.aiAssistantName || ""} onChange={(event) => setDraftValue("aiAssistantName", event.target.value)} />
      </Field>
      <Field label="First-message intro" hint="Used as the configured intro for a brand-new conversation.">
        <textarea rows={3} className={TEXTAREA_CLASS} value={draft.introMessage || ""} onChange={(event) => setDraftValue("introMessage", event.target.value)} />
      </Field>
    </div>
  );
}

function LocationsStep({ draft, setDraft, config, ui }) {
  const required = config.businessType === "aesthetic_clinic";
  return (
    <div>
      <StepHeading
        eyebrow="2 · Locations"
        title={ui.locationsLabel}
        optional={!required}
        description={required ? "Add the clinic branches the AI can use for routing and booking context." : "Add showrooms, branches, service areas, or sales locations when they are useful to the customer conversation."}
      />
      <ObjectList
        items={draft.branches || []}
        setItems={(branches) => setDraft((current) => ({ ...current, branches }))}
        emptyItem={{ name: "", address: "", phone: "", whatsapp: "" }}
        addLabel={`Add ${ui.locationSingular}`}
        fields={[
          { key: "name", label: "Name" },
          { key: "address", label: required ? "Address" : "Address / coverage note", textarea: true },
          { key: "phone", label: "Phone" },
          { key: "whatsapp", label: "WhatsApp link (optional)" },
        ]}
      />
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
      <StepHeading eyebrow="3 · Operating details" title="Hours & contact" description="Give the AI real operating hours and useful customer contact channels." />
      <Field label="Operating hours">
        <input className={INPUT_CLASS} value={draft.hours?.general || ""} onChange={(event) => setHours("general", event.target.value)} placeholder="e.g. Mon–Sat, 10am–7pm" />
      </Field>
      <Field label="Closed days / note">
        <input className={INPUT_CLASS} value={draft.hours?.closed || ""} onChange={(event) => setHours("closed", event.target.value)} />
      </Field>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Main WhatsApp number"><input className={INPUT_CLASS} value={draft.contact?.whatsapp || ""} onChange={(event) => setContact("whatsapp", event.target.value)} /></Field>
        <Field label="Instagram"><input className={INPUT_CLASS} value={draft.contact?.instagram || ""} onChange={(event) => setContact("instagram", event.target.value)} /></Field>
        <Field label="Facebook"><input className={INPUT_CLASS} value={draft.contact?.facebook || ""} onChange={(event) => setContact("facebook", event.target.value)} /></Field>
        <Field label="TikTok"><input className={INPUT_CLASS} value={draft.contact?.tiktok || ""} onChange={(event) => setContact("tiktok", event.target.value)} /></Field>
      </div>
    </div>
  );
}

function OfferingsStep({ draft, setDraft, ui }) {
  return (
    <div>
      <StepHeading eyebrow="4 · What the business sells" title={ui.servicesLabel} description={`Add the ${ui.servicePlural} the AI is allowed to discuss. Customer wording can be mapped to the official names below.`} />
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
          { key: "duration", label: "Duration / timeline" },
        ]}
      />
      <div className="my-6 border-t border-[var(--color-border)]" />
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-bold">Service terms</h2>
        <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">Optional</span>
      </div>
      <p className="mb-3 text-xs leading-5 text-[var(--color-text-muted)]">Map shorthand, nicknames, or phrases customers use to the official service name.</p>
      <ObjectList
        items={draft.serviceAliases || []}
        setItems={(serviceAliases) => setDraft((current) => ({ ...current, serviceAliases }))}
        emptyItem={{ alias: "", officialService: "" }}
        addLabel="Add customer term"
        fields={[
          { key: "alias", label: "What customers type" },
          { key: "officialService", label: "Maps to service" },
        ]}
      />
    </div>
  );
}

function KnowledgeStep({ draft, setDraft }) {
  return (
    <div>
      <StepHeading eyebrow="5 · Knowledge" title="FAQs" optional description="Add common questions that should have a consistent answer. You can leave this empty and return later." />
      <ObjectList
        items={draft.faqs || []}
        setItems={(faqs) => setDraft((current) => ({ ...current, faqs }))}
        emptyItem={{ q: "", a: "" }}
        addLabel="Add FAQ"
        fields={[
          { key: "q", label: "Question" },
          { key: "a", label: "Answer", textarea: true },
        ]}
      />
    </div>
  );
}

function AiBehaviorStep({ draft, setDraftValue, ui }) {
  return (
    <div>
      <StepHeading eyebrow="6 · AI behaviour" title="How the AI should talk and sell" description="These are the same live instructions used by Settings. Industry defaults are already filled in, so edit only where the client's process differs." />
      <Field label="Tone"><textarea rows={3} className={TEXTAREA_CLASS} value={draft.tone || ""} onChange={(event) => setDraftValue("tone", event.target.value)} /></Field>
      <Field label="Texting style"><textarea rows={7} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.messagingStyle || ""} onChange={(event) => setDraftValue("messagingStyle", event.target.value)} /></Field>
      <Field label="Sales / conversation playbook" hint={`How the AI should guide interested ${ui.customerPlural} toward the next sensible step.`}><textarea rows={9} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.closingPlaybook || ""} onChange={(event) => setDraftValue("closingPlaybook", event.target.value)} /></Field>
      <Field label="Operating instructions"><textarea rows={8} className={`${TEXTAREA_CLASS} font-mono text-[13px]`} value={draft.sop || ""} onChange={(event) => setDraftValue("sop", event.target.value)} /></Field>
    </div>
  );
}

function HandoffStep({ draft, setDraft, ui }) {
  function setEscalation(key, value) {
    setDraft((current) => ({ ...current, escalation: { ...current.escalation, [key]: value } }));
  }
  return (
    <div>
      <StepHeading eyebrow="7 · Human handoff" title="When staff should take over" description="Keep the situations that need a person clear, plus the message customers see when the AI hands off." />
      <Field label={`Hand off when the ${ui.customerSingular} asks about...`}>
        <StringList items={draft.escalation?.outOfScopeTriggers || []} setItems={(items) => setEscalation("outOfScopeTriggers", items)} addLabel="Add trigger" />
      </Field>
      <Field label="Customer handoff message"><textarea rows={3} className={TEXTAREA_CLASS} value={draft.escalation?.handoffMessage || ""} onChange={(event) => setEscalation("handoffMessage", event.target.value)} /></Field>
      <Field label="Internal handoff note"><input className={INPUT_CLASS} value={draft.escalation?.handoffNote || ""} onChange={(event) => setEscalation("handoffNote", event.target.value)} /></Field>
      <Field label="AI guardrails"><StringList items={draft.guardrails || []} setItems={(guardrails) => setDraft((current) => ({ ...current, guardrails }))} addLabel="Add guardrail" /></Field>
    </div>
  );
}

function PromotionsStep({ draft, setDraft }) {
  return (
    <div>
      <StepHeading eyebrow="8 · Promotions" title="Promotions" optional description="Add active promotional content only when the client wants it. Leaving this empty does not block business setup." />
      <ObjectList
        items={(draft.promotions || []).map((item) => ({ ...item, validFrom: item.validFrom || "", validUntil: item.validUntil || "" }))}
        setItems={(promotions) => setDraft((current) => ({ ...current, promotions }))}
        emptyItem={{ name: "", imageUrl: "", caption: "", validFrom: "", validUntil: "" }}
        addLabel="Add promotion"
        fields={[
          { key: "name", label: "Promotion name" },
          { key: "imageUrl", label: "Image URL" },
          { key: "caption", label: "Caption", textarea: true },
          { key: "validFrom", label: "Valid from (YYYY-MM-DD)" },
          { key: "validUntil", label: "Valid until (YYYY-MM-DD)" },
        ]}
      />
      <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">For direct image upload and replacement controls, use Settings → Promotions. Both screens edit the same saved promotion list.</p>
    </div>
  );
}

function ReviewStep({ completion, onSelect }) {
  return (
    <div>
      <StepHeading eyebrow="Review" title="Check the business setup" description="Completion is calculated from the currently saved configuration, not from whether someone clicked through a step." />
      <div className="space-y-2.5">
        {completion.sections.map((section) => (
          <button key={section.id} type="button" onClick={() => onSelect(section.id)} className="flex w-full items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left transition hover:bg-white">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${section.complete ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-accent-light)] text-[var(--color-text)]"}`}>{section.complete ? "✓" : "!"}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold">{section.label}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">{section.required ? "Required" : "Optional"}</span>
              </span>
              <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{section.missing.length ? section.missing.join(" · ") : section.note}</span>
            </span>
            <span className="text-sm text-[var(--color-text-muted)]">›</span>
          </button>
        ))}
      </div>
      {!completion.requiredComplete && (
        <div className="mt-4 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-4 text-sm leading-6">
          <p className="font-semibold">{completion.incompleteRequired.length} required section{completion.incompleteRequired.length === 1 ? "" : "s"} still need attention.</p>
          <p className="mt-1 text-[var(--color-text-muted)]">You can still open technical checks, but the business setup cannot be marked complete yet.</p>
        </div>
      )}
    </div>
  );
}

function GoLiveStep({ completion, technical, technicalLoading, onRunChecks, onOpenSetup }) {
  const summary = technical?.summary || {};
  const overall = technical?.systemHealth?.overall || null;
  return (
    <div>
      <StepHeading eyebrow="Test / Go live" title="Business setup + technical readiness" description="This step reuses the existing Setup Status checks. It does not send a test message to a real customer and does not create another readiness system." />
      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Business setup" value={completion.requiredComplete ? "Complete" : "Needs attention"} detail={completion.requiredComplete ? "All required business information is saved" : `${completion.incompleteRequired.length} required section(s) incomplete`} />
        <InfoCard label="Technical health" value={technicalLoading ? "Checking…" : overall?.label || "Not checked here yet"} detail={technical ? `${summary.requiredReady || 0}/${summary.requiredTotal || 0} required Setup Status checks ready` : "Uses the existing admin-only Setup Status"} />
      </div>
      <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <p className="text-sm font-bold">Technical checks</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Run the same connection and runtime checks used by Setup Status. Real messaging readiness still depends on the strict evidence added in PR #106.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={onRunChecks} disabled={technicalLoading} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50">
            {technicalLoading && <Spinner className="h-4 w-4" />}
            {technicalLoading ? "Running checks…" : "Run technical checks"}
          </button>
          <button type="button" onClick={onOpenSetup} className="h-11 rounded-xl border border-[var(--color-border)] bg-white px-4 text-sm font-semibold">Open full Setup Status</button>
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">Finishing here marks only the business-configuration wizard complete. Setup Status remains the source of truth for technical readiness until the unified go-live dashboard is built.</p>
    </div>
  );
}

function WizardActions({ screen, saving, requiredComplete, onBack, onContinue, onSaveLater }) {
  const isWelcome = screen === "welcome";
  const isGoLive = screen === "goLive";
  return (
    <div className="mt-7 border-t border-[var(--color-border)] pt-5">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {!isWelcome && (
            <button type="button" onClick={onBack} disabled={saving} className="h-11 rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-50">Back</button>
          )}
          <button type="button" onClick={onSaveLater} disabled={saving} className="h-11 rounded-xl px-4 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-50">Save & continue later</button>
        </div>
        <button type="button" onClick={onContinue} disabled={saving || (isGoLive && !requiredComplete)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50">
          {saving && <Spinner className="h-4 w-4" />}
          {saving ? "Saving…" : isWelcome ? "Start setup" : isGoLive ? "Finish business setup" : screen === "review" ? "Continue to test / go live" : "Save & continue"}
        </button>
      </div>
    </div>
  );
}

function ObjectList({ items, setItems, emptyItem, addLabel, fields }) {
  function change(index, key, value) {
    const next = items.slice();
    next[index] = { ...next[index], [key]: value };
    setItems(next);
  }
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Entry {index + 1}</p>
            <button type="button" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))} className="h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]">Remove</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className={field.textarea ? "sm:col-span-2" : ""}>
                <span className="mb-1 block text-[11px] font-semibold text-[var(--color-text-muted)]">{field.label}</span>
                {field.textarea ? (
                  <textarea rows={3} className={TEXTAREA_CLASS} value={item?.[field.key] || ""} onChange={(event) => change(index, field.key, event.target.value)} />
                ) : (
                  <input className={INPUT_CLASS} value={item?.[field.key] || ""} onChange={(event) => change(index, field.key, event.target.value)} />
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

function StringList({ items, setItems, addLabel }) {
  function change(index, value) {
    const next = items.slice();
    next[index] = value;
    setItems(next);
  }
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <textarea rows={2} className={`${TEXTAREA_CLASS} min-w-0 flex-1`} value={item || ""} onChange={(event) => change(index, event.target.value)} />
          <button type="button" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove entry ${index + 1}`} className="h-11 w-11 shrink-0 rounded-xl text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => setItems([...items, ""])} className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">+ {addLabel}</button>
    </div>
  );
}
