import { useEffect, useState } from "react";
import { api } from "../api";
import { useToasts, ToastContainer } from "../components/Toast";
import Spinner from "../components/Spinner";

const TABS = [
  { id: "general", label: "General" },
  { id: "branches", label: "Branches" },
  { id: "hours", label: "Hours & Contact" },
  { id: "services", label: "Services" },
  { id: "aliases", label: "Service Terms" },
  { id: "faqs", label: "FAQs" },
  { id: "promotions", label: "Promotions" },
  { id: "aiBehavior", label: "AI Behavior" },
  { id: "escalation", label: "Handoff & Rules" },
];

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-[var(--color-surface)]";
const textareaClass = `${inputClass} resize-y`;
const labelClass = "block text-xs font-medium text-[var(--color-text-muted)] mb-1.5";

export default function Settings() {
  const [config, setConfig] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [activeTab, setActiveTab] = useState("general");
  const { toasts, showToast, dismissToast } = useToasts();

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  // Called by a tab after it successfully saves — updates the shared config
  // so every other tab reflects the latest server state the next time it's
  // opened, not just the one that just saved.
  function handleSaved(updatedConfig) {
    setConfig(updatedConfig);
    showToast("Settings saved.", "info");
  }

  function handleError(message) {
    showToast(message, "error");
  }

  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <p className="text-sm text-[var(--color-danger)]">Couldn't load settings — {loadError}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 border-r border-[var(--color-border)] h-full overflow-y-auto bg-[var(--color-surface)] py-4">
        <div className="px-5 pb-3">
          <h1 className="font-display text-lg font-bold">Settings</h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Bot & clinic configuration</p>
        </div>
        <nav className="px-2 space-y-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === t.id
                  ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-2xl pb-8">
          {activeTab === "general" && <GeneralTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "branches" && <BranchesTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "hours" && <HoursContactTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "services" && <ServicesTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "aliases" && <AliasesTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "faqs" && <FaqsTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "promotions" && <PromotionsTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "aiBehavior" && <AiBehaviorTab config={config} onSaved={handleSaved} onError={handleError} />}
          {activeTab === "escalation" && <EscalationTab config={config} onSaved={handleSaved} onError={handleError} />}
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ── Shared bits ──

function SectionHeading({ title, description }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {description && <p className="text-sm text-[var(--color-text-muted)] mt-1">{description}</p>}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="mb-4">
      <label className={labelClass}>{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{hint}</p>}
    </div>
  );
}

function SaveButton({ saving, onClick, label = "Save changes" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
    >
      {saving && <Spinner />}
      {saving ? "Saving…" : label}
    </button>
  );
}

// Generic editor for an array of objects sharing the same fields (branches,
// services, FAQs, promotions, service aliases). Each field is either a
// single-line `input` or a `textarea` — see the `fields` prop shape used by
// each tab below.
function RepeatableListEditor({ items, fields, onChange, emptyItem, addLabel }) {
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
        <div key={idx} className="rounded-xl border border-[var(--color-border)] p-4 relative">
          <button
            type="button"
            onClick={() => removeItem(idx)}
            aria-label="Remove this entry"
            title="Remove"
            className="absolute top-3 right-3 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
          >
            ✕
          </button>
          <div className="grid gap-3 pr-6">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-[11px] font-medium text-[var(--color-text-muted)] mb-1">{f.label}</label>
                {f.type === "textarea" ? (
                  <textarea
                    rows={f.rows || 2}
                    className={textareaClass}
                    value={item[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => updateItem(idx, f.key, e.target.value)}
                  />
                ) : (
                  <input
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
        className="text-sm font-medium px-3 py-2.5 rounded-xl border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors w-full"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// Generic editor for an array of plain strings (guardrails, handoff triggers).
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
            className={inputClass}
            value={val}
            placeholder={placeholder}
            onChange={(e) => updateItem(idx, e.target.value)}
          />
          <button
            type="button"
            onClick={() => removeItem(idx)}
            aria-label="Remove this entry"
            title="Remove"
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors px-1"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="text-sm font-medium px-3 py-2.5 rounded-xl border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors w-full"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// ── Tabs ──

function GeneralTab({ config, onSaved, onError }) {
  const [form, setForm] = useState({
    clinicName: config.clinicName,
    aiAssistantName: config.aiAssistantName,
    introMessage: config.introMessage,
    tone: config.tone,
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.clinicName.trim() || !form.aiAssistantName.trim() || !form.introMessage.trim()) {
      onError("Clinic name, assistant name, and intro message can't be empty.");
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
        description="Basic identity the AI uses to introduce itself and talk about the clinic."
      />
      <Field label="Clinic name">
        <input
          className={inputClass}
          value={form.clinicName}
          onChange={(e) => setForm({ ...form, clinicName: e.target.value })}
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
        hint="Sent automatically as the very first line to a brand-new patient conversation — not written by the AI itself."
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
  const [items, setItems] = useState(() => (config.branches || []).map((b) => ({ ...b, whatsapp: b.whatsapp || "" })));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((b) => b.name.trim() || b.address.trim() || b.phone.trim())
      .map((b) => ({
        name: b.name.trim(),
        address: b.address.trim(),
        phone: b.phone.trim(),
        whatsapp: b.whatsapp.trim() || null,
      }));
    if (cleaned.some((b) => !b.name)) {
      onError("Every branch needs a name.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ branches: cleaned });
      setItems(cleaned.map((b) => ({ ...b, whatsapp: b.whatsapp || "" })));
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save branches.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Branches"
        description="Locations the AI lists when a patient asks where the clinic is, or which branch to go to."
      />
      <RepeatableListEditor
        items={items}
        fields={BRANCH_FIELDS}
        onChange={setItems}
        emptyItem={{ name: "", address: "", phone: "", whatsapp: "" }}
        addLabel="Add branch"
      />
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
      <Field label="Main WhatsApp number">
        <input className={inputClass} value={form.contact.whatsapp} onChange={(e) => setContact("whatsapp", e.target.value)} />
      </Field>
      <Field label="Instagram">
        <input className={inputClass} value={form.contact.instagram} onChange={(e) => setContact("instagram", e.target.value)} />
      </Field>
      <Field label="Facebook">
        <input className={inputClass} value={form.contact.facebook} onChange={(e) => setContact("facebook", e.target.value)} />
      </Field>
      <Field label="TikTok">
        <input className={inputClass} value={form.contact.tiktok} onChange={(e) => setContact("tiktok", e.target.value)} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}

const SERVICE_FIELDS = [
  { key: "name", label: "Service name" },
  { key: "description", label: "Description", type: "textarea", rows: 3 },
  { key: "priceRange", label: "Price" },
  { key: "duration", label: "Duration" },
];

function ServicesTab({ config, onSaved, onError }) {
  const [items, setItems] = useState(() => config.services || []);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((s) => s.name.trim() || s.description.trim())
      .map((s) => ({
        name: s.name.trim(),
        description: s.description.trim(),
        priceRange: s.priceRange.trim(),
        duration: s.duration.trim(),
      }));
    if (cleaned.some((s) => !s.name)) {
      onError("Every service needs a name.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({ services: cleaned });
      setItems(cleaned);
      onSaved(updated);
    } catch (err) {
      onError(err.message || "Couldn't save services.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Services"
        description="Keep this list accurate — the AI will only quote what's listed here, so it won't invent prices or treatments."
      />
      <RepeatableListEditor
        items={items}
        fields={SERVICE_FIELDS}
        onChange={setItems}
        emptyItem={{ name: "", description: "", priceRange: "", duration: "" }}
        addLabel="Add service"
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

const ALIAS_FIELDS = [
  { key: "alias", label: "What patients type", placeholder: "e.g. thread lift" },
  { key: "officialService", label: "Maps to service", placeholder: "e.g. APTOS Thread Lift" },
];

function AliasesTab({ config, onSaved, onError }) {
  const [items, setItems] = useState(() => config.serviceAliases || []);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((a) => a.alias.trim() || a.officialService.trim())
      .map((a) => ({ alias: a.alias.trim(), officialService: a.officialService.trim() }));
    if (cleaned.some((a) => !a.alias)) {
      onError("Every entry needs the term patients actually type.");
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
        description="Casual terms patients actually type, mapped to the official service name — so the AI doesn't hand off just because the wording doesn't match exactly."
      />
      <RepeatableListEditor
        items={items}
        fields={ALIAS_FIELDS}
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
    if (cleaned.some((f) => !f.q)) {
      onError("Every FAQ needs a question.");
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
      <SectionHeading title="FAQs" description="Common questions patients ask — the AI leans on these before improvising." />
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
  { key: "imageUrl", label: "Image URL", placeholder: "https://..." },
  { key: "caption", label: "Caption", type: "textarea", rows: 2 },
  { key: "validFrom", label: "Valid from (YYYY-MM-DD, optional)", placeholder: "Always on if blank" },
  { key: "validUntil", label: "Valid until (YYYY-MM-DD, optional)", placeholder: "No end date if blank" },
];

function PromotionsTab({ config, onSaved, onError }) {
  const [items, setItems] = useState(() =>
    (config.promotions || []).map((p) => ({ ...p, validFrom: p.validFrom || "", validUntil: p.validUntil || "" }))
  );
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const cleaned = items
      .filter((p) => p.name.trim() || p.imageUrl.trim())
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
        description="Sent as an image alongside the first reply to a brand-new patient, while a promo is within its valid dates."
      />
      <RepeatableListEditor
        items={items}
        fields={PROMOTION_FIELDS}
        onChange={setItems}
        emptyItem={{ name: "", imageUrl: "", caption: "", validFrom: "", validUntil: "" }}
        addLabel="Add promotion"
      />
      <div className="mt-4">
        <SaveButton saving={saving} onClick={handleSave} />
      </div>
    </div>
  );
}

function AiBehaviorTab({ config, onSaved, onError }) {
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
          rows={14}
          className={`${textareaClass} font-mono text-[13px]`}
          value={form.messagingStyle}
          onChange={(e) => setForm({ ...form, messagingStyle: e.target.value })}
        />
      </Field>
      <Field label="Booking / conversion playbook" hint="How the AI should guide interested patients toward booking a consultation.">
        <textarea
          rows={14}
          className={`${textareaClass} font-mono text-[13px]`}
          value={form.closingPlaybook}
          onChange={(e) => setForm({ ...form, closingPlaybook: e.target.value })}
        />
      </Field>
      <Field label="Standard operating procedures" hint="Internal policy — cancellations, complaints, medical/contraindication rules, etc.">
        <textarea
          rows={14}
          className={`${textareaClass} font-mono text-[13px]`}
          value={form.sop}
          onChange={(e) => setForm({ ...form, sop: e.target.value })}
        />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}

function EscalationTab({ config, onSaved, onError }) {
  const [form, setForm] = useState({
    escalation: { ...config.escalation, outOfScopeTriggers: [...(config.escalation.outOfScopeTriggers || [])] },
    guardrails: [...(config.guardrails || [])],
  });
  const [saving, setSaving] = useState(false);

  function setEscalation(key, value) {
    setForm((prev) => ({ ...prev, escalation: { ...prev.escalation, [key]: value } }));
  }

  async function handleSave() {
    const cleanedTriggers = form.escalation.outOfScopeTriggers.map((t) => t.trim()).filter(Boolean);
    const cleanedGuardrails = form.guardrails.map((g) => g.trim()).filter(Boolean);
    if (!form.escalation.handoffMessage.trim()) {
      onError("The handoff message can't be empty.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateConfig({
        escalation: { ...form.escalation, outOfScopeTriggers: cleanedTriggers },
        guardrails: cleanedGuardrails,
      });
      setForm({
        escalation: { ...form.escalation, outOfScopeTriggers: cleanedTriggers },
        guardrails: cleanedGuardrails,
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
        description="When the AI should stop and bring in a human, and hard boundaries it must never cross."
      />
      <Field label="Hand off to a human when the patient asks about...">
        <StringListEditor
          items={form.escalation.outOfScopeTriggers}
          onChange={(v) => setEscalation("outOfScopeTriggers", v)}
          addLabel="Add trigger"
          placeholder="e.g. Complaints or refund requests"
        />
      </Field>
      <Field label="Handoff message" hint="What the AI says to the patient when it hands off.">
        <textarea
          rows={2}
          className={textareaClass}
          value={form.escalation.handoffMessage}
          onChange={(e) => setEscalation("handoffMessage", e.target.value)}
        />
      </Field>
      <Field label="Internal note" hint="Reminder to staff about how this WhatsApp number is monitored — not shown to patients.">
        <input
          className={inputClass}
          value={form.escalation.handoffNote}
          onChange={(e) => setEscalation("handoffNote", e.target.value)}
        />
      </Field>
      <Field label="Guardrails — things the AI must never do">
        <StringListEditor
          items={form.guardrails}
          onChange={(v) => setForm((prev) => ({ ...prev, guardrails: v }))}
          addLabel="Add guardrail"
          placeholder="e.g. Never quote a price that isn't listed above"
        />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  );
}
