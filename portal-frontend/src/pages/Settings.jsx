import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Spinner from "../components/Spinner";
import { getBusinessTerminology, getSettingsTabs } from "../utils/businessTerminology";

const TAB_IDS = [
  "general",
  "branches",
  "hours",
  "services",
  "aliases",
  "faqs",
  "promotions",
  "aiBehavior",
  "escalation",
];

const inputClass =
  "min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20";
const textareaClass = `${inputClass} resize-y`;
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]";

function capitalize(value) {
  const text = String(value || "").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function cleanStrings(items) {
  return (items || []).map((item) => String(item || "").trim()).filter(Boolean);
}

function isValidWhatsapp(value) {
  const input = String(value || "").trim();
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

export default function Settings() {
  const { user, permissions } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const initialTab = TAB_IDS.includes(requestedTab) ? requestedTab : "general";
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState(initialTab);
  const { toasts, showToast, dismissToast } = useToasts();

  const teamItem = permissions.manage_users
    ? { id: "team", label: "Team & Access", to: "/settings/team" }
    : null;
  const clientSetupItem = user?.role === "admin"
    ? { id: "client-setup", label: "Client Setup", to: "/settings/client-setup" }
    : null;
  const setupItem = user?.role === "admin"
    ? { id: "setup", label: "Setup Status", to: "/settings/setup" }
    : null;
  const destinationItems = [teamItem, clientSetupItem, setupItem].filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .getConfig()
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "Failed to load settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    const nextTab = TAB_IDS.includes(tab) ? tab : "general";
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [searchParams]);

  function handleSaved(updatedConfig) {
    setConfig(updatedConfig);
    showToast("Settings saved.", "info");
  }

  function handleError(message) {
    showToast(message, "error");
  }

  function retryLoad() {
    setConfig(null);
    setLoadError(null);
    setReloadToken((value) => value + 1);
  }

  function selectConfigTab(id) {
    setActiveTab(id);
    if (id === "general") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: id }, { replace: true });
    }
  }

  function handleSectionChange(value) {
    if (TAB_IDS.includes(value)) {
      selectConfigTab(value);
      return;
    }
    const item = destinationItems.find((entry) => entry.id === value);
    if (item) navigate(item.to);
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4 sm:px-6">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm sm:p-8">
          <h1 className="font-display text-lg font-bold">Couldn't load settings</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-danger)]">{loadError}</p>
          <button
            type="button"
            onClick={retryLoad}
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
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)]">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  const ui = getBusinessTerminology(config);
  const tabs = getSettingsTabs(config);
  const systemItems = [clientSetupItem, setupItem].filter(Boolean);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg)] md:flex-row">
      <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:flex">
        <div className="border-b border-[var(--color-border)] px-5 py-5">
          <h1 className="font-display text-lg font-bold">Settings</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Bot & {ui.businessNoun} configuration
          </p>
        </div>
        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
          <div className="space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-current={activeTab === tab.id ? "page" : undefined}
                onClick={() => selectConfigTab(tab.id)}
                className={`min-h-10 w-full rounded-xl px-3 text-left text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-[var(--color-primary-light)] font-semibold text-[var(--color-primary)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {teamItem && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                Administration
              </p>
              <button
                type="button"
                onClick={() => navigate(teamItem.to)}
                className="min-h-10 w-full rounded-xl px-3 text-left text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
              >
                {teamItem.label}
              </button>
            </div>
          )}

          {systemItems.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                System
              </p>
              {systemItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.to)}
                  className="min-h-10 w-full rounded-xl px-3 text-left text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 md:hidden">
          <h1 className="font-display text-xl font-bold">Settings</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">Manage the information and rules your AI uses.</p>
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Section</span>
            <select
              value={activeTab}
              onChange={(event) => handleSectionChange(event.target.value)}
              className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm font-semibold text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20"
            >
              <optgroup label={ui.businessAndAiLabel}>
                {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
              </optgroup>
              {teamItem && (
                <optgroup label="Administration">
                  <option value={teamItem.id}>{teamItem.label}</option>
                </optgroup>
              )}
              {systemItems.length > 0 && (
                <optgroup label="System">
                  {systemItems.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8">
          <div className="w-full max-w-3xl pb-8">
            <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:rounded-3xl sm:p-6 lg:p-7">
              {activeTab === "general" && <GeneralTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "branches" && <BranchesTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "hours" && <HoursContactTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "services" && <ServicesTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "aliases" && <AliasesTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "faqs" && <FaqsTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "promotions" && <PromotionsTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "aiBehavior" && <AiBehaviorTab config={config} onSaved={handleSaved} onError={handleError} />}
              {activeTab === "escalation" && <EscalationTab config={config} onSaved={handleSaved} onError={handleError} />}
            </section>
          </div>
        </main>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function SectionHeading({ title, description }) {
  return (
    <div className="mb-5 sm:mb-6">
      <h2 className="font-display text-lg font-bold sm:text-xl">{title}</h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)] sm:text-sm">{description}</p>}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="mb-5 last:mb-0">
      <label className={labelClass}>{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function SaveButton({ saving, onClick, label = "Save changes" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50 sm:w-auto"
    >
      {saving && <Spinner />}
      {saving ? "Saving…" : label}
    </button>
  );
}

function RepeatableListEditor({ items, fields, onChange, emptyItem, addLabel, onError }) {
  function updateItem(idx, key, value) {
    const next = items.slice();
    next[idx] = { ...next[idx], [key]: value };
    onChange(next);
  }
  function removeItem(idx) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function addItem() {
    onChange([...items, { ...emptyItem }]);
  }

  return (
    <div className="space-y-3">
      {items.map((item, idx) => (
        <div key={idx} className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5 sm:p-4">
          <div className="mb-3 flex min-h-8 items-center pr-11">
            <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Entry {idx + 1}</p>
          </div>
          <button
            type="button"
            onClick={() => removeItem(idx)}
            aria-label={`Remove entry ${idx + 1}`}
            title="Remove"
            className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-xl text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger)]"
          >
            ✕
          </button>
          <div className="grid gap-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-[11px] font-semibold text-[var(--color-text-muted)]">{f.label}</label>
                {f.type === "image" ? (
                  <ImageFieldEditor
                    value={item[f.key] ?? ""}
                    onChange={(value) => updateItem(idx, f.key, value)}
                    onError={onError}
                  />
                ) : f.type === "textarea" ? (
                  <textarea
                    rows={f.rows || 2}
                    className={textareaClass}
                    value={item[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => updateItem(idx, f.key, e.target.value)}
                  />
                ) : f.type === "select" ? (
                  <select
                    className={inputClass}
                    value={item[f.key] ?? ""}
                    onChange={(e) => updateItem(idx, f.key, e.target.value)}
                  >
                    <option value="">{f.placeholder || "Choose an option"}</option>
                    {(f.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.type || "text"}
                    className={inputClass}
                    value={item[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => updateItem(idx, f.key, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
      >
        + {addLabel}
      </button>
    </div>
  );
}

const MAX_PROMO_IMAGE_BYTES = 5 * 1024 * 1024;
const PROMO_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function ImageFieldEditor({ value, onChange, onError }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!PROMO_IMAGE_TYPES.has(file.type)) {
      onError("Please choose a JPG or PNG image.");
      return;
    }
    if (file.size > MAX_PROMO_IMAGE_BYTES) {
      onError("That image is larger than 5MB. Please choose a smaller file.");
      return;
    }
    setUploading(true);
    try {
      const { url } = await api.uploadPromoImage(file);
      onChange(url);
    } catch (err) {
      onError(err.message || "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {value && (
        <img
          src={value}
          alt="Promotion graphic"
          className="mb-2 max-h-48 w-full rounded-xl border border-[var(--color-border)] object-cover sm:max-h-56"
        />
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" onChange={handleFilePicked} className="hidden" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold transition-colors hover:bg-[var(--color-surface)] disabled:opacity-50"
        >
          {uploading && <Spinner className="h-3 w-3" />}
          {uploading ? "Uploading…" : value ? "Replace image" : "Upload image"}
        </button>
        {value && !uploading && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="h-10 rounded-lg px-3 text-xs font-semibold text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger)]"
          >
            Remove
          </button>
        )}
      </div>
      <input
        className={`${inputClass} text-xs`}
        value={value}
        placeholder="or paste an already-hosted image URL"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function StringListEditor({ items, onChange, addLabel, placeholder }) {
  function updateItem(idx, value) {
    const next = items.slice();
    next[idx] = value;
    onChange(next);
  }
  function removeItem(idx) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function addItem() {
    onChange([...items, ""]);
  }

  return (
    <div className="space-y-2">
      {items.map((val, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            className={`${inputClass} min-w-0 flex-1`}
            value={val}
            placeholder={placeholder}
            onChange={(e) => updateItem(idx, e.target.value)}
          />
          <button
            type="button"
            onClick={() => removeItem(idx)}
            aria-label={`Remove entry ${idx + 1}`}
            title="Remove"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger)]"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
      >
        + {addLabel}
      </button>
    </div>
  );
}

function GeneralTab({ config, onSaved, onError }) {
  const ui = getBusinessTerminology(config);
  const [form, setForm] = useState({
    clinicName: config.clinicName,
    businessDescription: config.businessDescription || "",
    aiAssistantName: config.aiAssistantName,
    introMessage: config.introMessage,
    tone: config.tone,
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.clinicName.trim() || !form.businessDescription.trim() || !form.aiAssistantName.trim() || !form.introMessage.trim()) {
      onError(`${ui.businessNameLabel}, business description, assistant name, and intro message can't be empty.`);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig(form);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save these settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="General"
        description={`Basic identity and context the AI uses to talk about the ${ui.businessNoun}.`}
      />
      <Field label={ui.businessNameLabel}>
        <input
          className={inputClass}
          value={form.clinicName}
          onChange={(e) => setForm({ ...form, clinicName: e.target.value })}
        />
      </Field>
      <Field label="Business description" hint="A short factual description of what the business does and serves.">
        <textarea
          rows={3}
          className={textareaClass}
          value={form.businessDescription}
          onChange={(e) => setForm({ ...form, businessDescription: e.target.value })}
        />
      </Field>
      <Field label="AI assistant name" hint="Gives the bot a friendly identity instead of just “AI”.">
        <input
          className={inputClass}
          value={form.aiAssistantName}
          onChange={(e) => setForm({ ...form, aiAssistantName: e.target.value })}
        />
      </Field>
      <Field
        label="Intro message"
        hint={`Sent automatically as the very first line to a brand-new ${ui.customerSingular} conversation — not written by the AI itself.`}
      >
        <textarea
          rows={2}
          className={textareaClass}
          value={form.introMessage}
          onChange={(e) => setForm({ ...form, introMessage: e.target.value })}
        />
      </Field>
      <Field label="Tone" hint="Short personality description, read by the AI as a style instruction.">
        <textarea
          rows={2}
          className={textareaClass}
          value={form.tone}
          onChange={(e) => setForm({ ...form, tone: e.target.value })}
        />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}

const BRANCH_FIELDS = [
  { key: "name", label: "Name" },
  { key: "address", label: "Address", type: "textarea", rows: 2 },
  { key: "phone", label: "Phone" },
  { key: "whatsapp", label: "WhatsApp link (optional)", placeholder: "https://wa.me/..." },
];

function BranchesTab({ config, onSaved, onError }) {
  const ui = getBusinessTerminology(config);
  const renovation = config.businessType === "home_renovation";
  const clinic = config.businessType === "aesthetic_clinic";
  const [items, setItems] = useState(() => (config.branches || []).map((b) => ({ ...b, whatsapp: b.whatsapp || "" })));
  const [serviceAreas, setServiceAreas] = useState(() => [...(config.serviceAreas || [])]);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((b) => b.name.trim() || b.address.trim() || b.phone.trim() || b.whatsapp.trim())
      .map((b) => ({
        name: b.name.trim(),
        address: b.address.trim(),
        phone: b.phone.trim(),
        whatsapp: b.whatsapp.trim() || null,
      }));
    if (cleaned.some((b) => !b.name)) {
      onError(`Every ${ui.locationSingular} needs a name.`);
      return;
    }
    if (clinic && cleaned.some((b) => !b.address)) {
      onError("Every clinic branch needs an address.");
      return;
    }
    const cleanedAreas = cleanStrings(serviceAreas);
    setSaving(true);
    try {
      const updated = await api.updateConfig({
        branches: cleaned,
        ...(renovation ? { serviceAreas: cleanedAreas } : {}),
      });
      setItems(cleaned.map((b) => ({ ...b, whatsapp: b.whatsapp || "" })));
      if (renovation) setServiceAreas(cleanedAreas);
      onSaved(updated);
    } catch (err) {
      onError(err.message || `Couldn't save ${ui.locationPlural}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title={renovation ? "Locations & Service Areas" : ui.locationsLabel}
        description={renovation
          ? "Actual showrooms/branches stay separate from project service coverage, so Pipeline and staff assignment only use real business locations."
          : `Business locations the AI can share when a ${ui.customerSingular} asks where to go or which location to choose.`}
      />
      {renovation && <h3 className="mb-3 text-sm font-bold">Actual showrooms / branches</h3>}
      <RepeatableListEditor
        items={items}
        fields={BRANCH_FIELDS}
        onChange={setItems}
        emptyItem={{ name: "", address: "", phone: "", whatsapp: "" }}
        addLabel={`Add ${ui.locationSingular}`}
      />
      {renovation && (
        <div className="mt-7 border-t border-[var(--color-border)] pt-6">
          <h3 className="text-sm font-bold">Project service areas</h3>
          <p className="mb-3 mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Areas where the business normally accepts renovation projects. These never become team/Pipeline branches.</p>
          <StringListEditor
            items={serviceAreas}
            onChange={setServiceAreas}
            addLabel="Add service area"
            placeholder="e.g. Klang Valley, PJ / Subang"
          />
        </div>
      )}
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

function HoursContactTab({ config, onSaved, onError }) {
  const [form, setForm] = useState({
    hours: { ...config.hours },
    contact: { ...config.contact },
  });
  const [saving, setSaving] = useState(false);

  function setHours(key, value) {
    setForm((prev) => ({ ...prev, hours: { ...prev.hours, [key]: value } }));
  }
  function setContact(key, value) {
    setForm((prev) => ({ ...prev, contact: { ...prev.contact, [key]: value } }));
  }

  async function handleSave() {
    if (!form.hours.general.trim()) {
      onError("Opening hours can't be empty.");
      return;
    }
    if (!isValidWhatsapp(form.contact.whatsapp)) {
      onError("Enter a valid WhatsApp number or WhatsApp link.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig(form);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save hours & contact info.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading title="Hours & Contact" description="Opening hours and social/contact links the AI can share." />
      <Field label="Opening hours">
        <input className={inputClass} value={form.hours.general} onChange={(e) => setHours("general", e.target.value)} />
      </Field>
      <Field label="Closed days / note">
        <input className={inputClass} value={form.hours.closed} onChange={(e) => setHours("closed", e.target.value)} />
      </Field>
      <Field label="Main WhatsApp number" hint="Phone number or wa.me / WhatsApp link.">
        <input className={inputClass} value={form.contact.whatsapp} onChange={(e) => setContact("whatsapp", e.target.value)} />
      </Field>
      <Field label="Instagram" hint="Username or profile URL.">
        <input className={inputClass} value={form.contact.instagram} onChange={(e) => setContact("instagram", e.target.value)} />
      </Field>
      <Field label="Facebook" hint="Page name or URL.">
        <input className={inputClass} value={form.contact.facebook} onChange={(e) => setContact("facebook", e.target.value)} />
      </Field>
      <Field label="TikTok" hint="Username or profile URL.">
        <input className={inputClass} value={form.contact.tiktok} onChange={(e) => setContact("tiktok", e.target.value)} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}

function ServicesTab({ config, onSaved, onError }) {
  const ui = getBusinessTerminology(config);
  const serviceFields = [
    { key: "name", label: `${capitalize(ui.serviceSingular)} name` },
    { key: "description", label: "Description", type: "textarea", rows: 3 },
    { key: "priceRange", label: "Price" },
    { key: "duration", label: config.businessType === "home_renovation" ? "Typical timeline / note" : "Duration" },
  ];
  const [items, setItems] = useState(() => config.services || []);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((s) => s.name.trim() || s.description.trim() || s.priceRange.trim() || s.duration.trim())
      .map((s) => ({
        name: s.name.trim(),
        description: s.description.trim(),
        priceRange: s.priceRange.trim(),
        duration: s.duration.trim(),
      }));
    if (cleaned.some((s) => !s.name)) {
      onError(`Every ${ui.serviceSingular} needs a name.`);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ services: cleaned });
      setItems(cleaned);
      onSaved(updated);
    } catch (err) {
      onError(err.message || `Couldn't save ${ui.servicePlural}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title={ui.servicesLabel}
        description={`Keep this list accurate — the AI will only quote what's listed here, so it won't invent prices or ${ui.servicePlural}.`}
      />
      <RepeatableListEditor
        items={items}
        fields={serviceFields}
        onChange={setItems}
        emptyItem={{ name: "", description: "", priceRange: "", duration: "" }}
        addLabel={`Add ${ui.serviceSingular}`}
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

function AliasesTab({ config, onSaved, onError }) {
  const serviceNames = (config.services || []).map((service) => service.name).filter(Boolean);
  const aliasFields = [
    { key: "alias", label: "What customers type", placeholder: "e.g. common shorthand or nickname" },
    { key: "officialService", label: "Maps to service", type: "select", options: serviceNames, placeholder: "Choose a configured service" },
  ];
  const [items, setItems] = useState(() => config.serviceAliases || []);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((a) => a.alias.trim() || a.officialService.trim())
      .map((a) => ({ alias: a.alias.trim(), officialService: a.officialService.trim() }));
    if (cleaned.some((a) => !a.alias || !a.officialService)) {
      onError("Every service term needs both the customer wording and the service it maps to.");
      return;
    }
    const canonical = new Set(serviceNames.map((name) => name.toLowerCase()));
    if (cleaned.some((a) => !canonical.has(a.officialService.toLowerCase()))) {
      onError("Every service term must map to a service currently configured.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ serviceAliases: cleaned });
      setItems(cleaned);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save service terms.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Service Terms"
        description="Casual terms customers type, mapped to an actual configured service."
      />
      {serviceNames.length === 0 && <p className="mb-4 rounded-xl bg-[var(--color-accent-light)] p-3 text-xs">Add at least one service before creating customer terms.</p>}
      <RepeatableListEditor
        items={items}
        fields={aliasFields}
        onChange={setItems}
        emptyItem={{ alias: "", officialService: "" }}
        addLabel="Add term"
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

const FAQ_FIELDS = [
  { key: "q", label: "Question" },
  { key: "a", label: "Answer", type: "textarea", rows: 3 },
];

function FaqsTab({ config, onSaved, onError }) {
  const [items, setItems] = useState(() => config.faqs || []);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((f) => f.q.trim() || f.a.trim())
      .map((f) => ({ q: f.q.trim(), a: f.a.trim() }));
    if (cleaned.some((f) => !f.q || !f.a)) {
      onError("Every FAQ needs both a question and an answer.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ faqs: cleaned });
      setItems(cleaned);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save FAQs.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading title="FAQs" description="Common questions customers ask — the AI leans on these before improvising." />
      <RepeatableListEditor
        items={items}
        fields={FAQ_FIELDS}
        onChange={setItems}
        emptyItem={{ q: "", a: "" }}
        addLabel="Add FAQ"
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

const PROMOTION_FIELDS = [
  { key: "name", label: "Promo name" },
  { key: "imageUrl", label: "Promo image", type: "image" },
  { key: "caption", label: "Caption", type: "textarea", rows: 2 },
  { key: "validFrom", label: "Valid from (optional)", type: "date" },
  { key: "validUntil", label: "Valid until (optional)", type: "date" },
];

function PromotionsTab({ config, onSaved, onError }) {
  const [items, setItems] = useState(() =>
    (config.promotions || []).map((p) => ({ ...p, validFrom: p.validFrom || "", validUntil: p.validUntil || "" }))
  );
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((p) => p.name.trim() || p.imageUrl.trim() || p.caption.trim() || p.validFrom || p.validUntil)
      .map((p) => ({
        name: p.name.trim(),
        imageUrl: p.imageUrl.trim(),
        caption: p.caption.trim(),
        validFrom: p.validFrom.trim() || null,
        validUntil: p.validUntil.trim() || null,
      }));
    if (cleaned.some((p) => !p.name)) {
      onError("Every promotion needs a name.");
      return;
    }
    for (const promotion of cleaned) {
      if (!isIsoDate(promotion.validFrom) || !isIsoDate(promotion.validUntil)) {
        onError("Promotion dates must be valid dates.");
        return;
      }
      if (promotion.validFrom && promotion.validUntil && promotion.validUntil < promotion.validFrom) {
        onError(`The end date for ${promotion.name} cannot be before its start date.`);
        return;
      }
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ promotions: cleaned });
      setItems(cleaned.map((p) => ({ ...p, validFrom: p.validFrom || "", validUntil: p.validUntil || "" })));
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save promotions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Promotions"
        description="Sent as an image alongside the first reply to a brand-new customer, while a promo is within its valid dates."
      />
      <RepeatableListEditor
        items={items}
        fields={PROMOTION_FIELDS}
        onChange={setItems}
        emptyItem={{ name: "", imageUrl: "", caption: "", validFrom: "", validUntil: "" }}
        addLabel="Add promotion"
        onError={onError}
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

function AiBehaviorTab({ config, onSaved, onError }) {
  const ui = getBusinessTerminology(config);
  const [form, setForm] = useState({
    messagingStyle: config.messagingStyle || "",
    closingPlaybook: config.closingPlaybook || "",
    sop: config.sop || "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.updateConfig(form);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save AI behavior settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="AI Behavior"
        description="Read literally by the AI as instructions, not just background — edit carefully, since these directly shape every reply."
      />
      <Field label="Texting style" hint="Concrete rules for how the AI writes messages (length, tone, punctuation, etc.).">
        <textarea
          rows={10}
          className={`${textareaClass} min-h-52 font-mono text-[13px] sm:min-h-72`}
          value={form.messagingStyle}
          onChange={(e) => setForm({ ...form, messagingStyle: e.target.value })}
        />
      </Field>
      <Field label="Conversion playbook" hint={`How the AI should guide interested ${ui.customerPlural} toward the next sensible sales step.`}>
        <textarea
          rows={10}
          className={`${textareaClass} min-h-52 font-mono text-[13px] sm:min-h-72`}
          value={form.closingPlaybook}
          onChange={(e) => setForm({ ...form, closingPlaybook: e.target.value })}
        />
      </Field>
      <Field label="Standard operating procedures" hint="Internal business rules, policies, exceptions, and situations that need staff confirmation.">
        <textarea
          rows={10}
          className={`${textareaClass} min-h-52 font-mono text-[13px] sm:min-h-72`}
          value={form.sop}
          onChange={(e) => setForm({ ...form, sop: e.target.value })}
        />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}

function EscalationTab({ config, onSaved, onError }) {
  const ui = getBusinessTerminology(config);
  const protectedGuardrails = cleanStrings(config.clientSetup?.protectedGuardrails || []);
  const protectedSet = new Set(protectedGuardrails);
  const initialCustom = (config.guardrails || []).filter((rule) => !protectedSet.has(rule));
  const [form, setForm] = useState({
    escalation: { ...config.escalation, outOfScopeTriggers: [...(config.escalation.outOfScopeTriggers || [])] },
    customGuardrails: initialCustom,
  });
  const [saving, setSaving] = useState(false);

  function setEscalation(key, value) {
    setForm((prev) => ({ ...prev, escalation: { ...prev.escalation, [key]: value } }));
  }

  async function handleSave() {
    const cleanedTriggers = cleanStrings(form.escalation.outOfScopeTriggers);
    const cleanedCustom = cleanStrings(form.customGuardrails);
    if (!form.escalation.handoffMessage.trim()) {
      onError("The handoff message can't be empty.");
      return;
    }
    if (cleanedTriggers.length === 0) {
      onError("Keep at least one handoff trigger.");
      return;
    }
    const guardrails = [...new Set([...protectedGuardrails, ...cleanedCustom])];
    if (guardrails.length === 0) {
      onError("Keep at least one AI guardrail.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({
        escalation: { ...form.escalation, outOfScopeTriggers: cleanedTriggers },
        guardrails,
      });
      setForm({
        escalation: { ...form.escalation, outOfScopeTriggers: cleanedTriggers },
        customGuardrails: cleanedCustom,
      });
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save handoff & rules.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Handoff & Rules"
        description="When the AI should stop and bring in a human, plus industry safety rules and any extra client-specific boundaries."
      />
      <Field label={`Hand off to a human when the ${ui.customerSingular} asks about...`}>
        <StringListEditor
          items={form.escalation.outOfScopeTriggers}
          onChange={(v) => setEscalation("outOfScopeTriggers", v)}
          addLabel="Add trigger"
          placeholder="e.g. Complaints or refund requests"
        />
      </Field>
      <Field label="Handoff message" hint={`What the AI says to the ${ui.customerSingular} when it hands off.`}>
        <textarea
          rows={2}
          className={textareaClass}
          value={form.escalation.handoffMessage}
          onChange={(e) => setEscalation("handoffMessage", e.target.value)}
        />
      </Field>
      <Field label="Internal note" hint={`Reminder to staff about how this channel is monitored — not shown to ${ui.customerPlural}.`}>
        <input
          className={inputClass}
          value={form.escalation.handoffNote}
          onChange={(e) => setEscalation("handoffNote", e.target.value)}
        />
      </Field>
      {protectedGuardrails.length > 0 && (
        <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <p className="text-sm font-bold">Built-in industry safety rules</p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">These come from the selected industry profile and cannot be removed here.</p>
          <ul className="mt-3 space-y-2 text-xs leading-5 text-[var(--color-text-muted)]">
            {protectedGuardrails.map((rule) => <li key={rule}>🔒 {rule}</li>)}
          </ul>
        </div>
      )}
      <Field label="Additional client-specific guardrails" hint="Optional rules added on top of the built-in industry safeguards.">
        <StringListEditor
          items={form.customGuardrails}
          onChange={(v) => setForm((prev) => ({ ...prev, customGuardrails: v }))}
          addLabel="Add client rule"
          placeholder="e.g. Never quote delivery outside West Malaysia"
        />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}
