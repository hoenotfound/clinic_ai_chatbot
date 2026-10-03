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
  const goLiveItem = user?.role === "admin"
    ? { id: "go-live", label: "Go Live", to: "/settings/go-live" }
    : null;
  const setupItem = user?.role === "admin"
    ? { id: "setup", label: "Setup Status", to: "/settings/setup" }
    : null;
  const advancedConfigItem = user?.role === "admin"
    ? { id: "advanced-config", label: "Advanced Config", to: "/settings/advanced-config" }
    : null;
  const destinationItems = [teamItem, clientSetupItem, goLiveItem, setupItem, advancedConfigItem].filter(Boolean);

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
  const systemItems = [clientSetupItem, goLiveItem, setupItem, advancedConfigItem].filter(Boolean);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg)] xl:flex-row">
      <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] xl:flex">
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
        <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 xl:hidden">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <h1 className="font-display text-xl font-bold">Settings</h1>
            <label className="min-w-0">
              <span className="sr-only">Section</span>
              <select
                aria-label="Settings section"
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
          </div>
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
                {f.type === "packages" ? (
                  <PromotionPackagesEditor
                    items={Array.isArray(item[f.key]) ? item[f.key] : []}
                    onChange={(value) => updateItem(idx, f.key, value)}
                    onError={onError}
                  />
                ) : f.type === "checkbox" ? (
                  <label className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={item[f.key] === true}
                      onChange={(e) => updateItem(idx, f.key, e.target.checked)}
                    />
                    <span>{f.checkboxLabel || "Enabled"}</span>
                  </label>
                ) : f.type === "image" ? (
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
          className="mb-3 max-h-52 w-full rounded-xl border border-[var(--color-border)] object-cover"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
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
      <details className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-muted)]">
          Advanced · use image URL
        </summary>
        <input
          className={`${inputClass} mt-2 text-xs`}
          value={value}
          placeholder="https://..."
          onChange={(e) => onChange(e.target.value)}
        />
      </details>
    </div>
  );
}

function PromotionAliasChips({ items, onChange }) {
  const [draft, setDraft] = useState("");

  function addDraft() {
    const value = draft.trim();
    if (!value) return;
    const exists = items.some((item) => String(item).trim().toLowerCase() === value.toLowerCase());
    if (!exists) onChange([...items, value]);
    setDraft("");
  }

  function onKeyDown(event) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addDraft();
    }
  }

  return (
    <div>
      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {items.map((item, index) => (
            <span key={`${item}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-xs">
              <span className="truncate">{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove ${item}`}
                className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className={`${inputClass} min-w-0 flex-1`}
          value={draft}
          placeholder="e.g. 子宫套餐, 7合1"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
         
        />
        <button
          type="button"
          onClick={addDraft}
          className="h-11 shrink-0 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold"
        >
          Add
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Add the words customers may naturally use for this package.</p>
    </div>
  );
}

function PromotionPackagesEditor({ items, onChange, onError }) {
  const [openIndex, setOpenIndex] = useState(null);

  function updatePackage(index, key, value) {
    const next = items.slice();
    next[index] = { ...next[index], [key]: value };
    onChange(next);
  }

  function removePackage(index) {
    onChange(items.filter((_, itemIndex) => itemIndex !== index));
    setOpenIndex((current) => {
      if (current === index) return null;
      if (current != null && current > index) return current - 1;
      return current;
    });
  }

  function addPackage() {
    const next = [
      ...items,
      { name: "", title: "", aliases: [], imageUrl: "", caption: "" },
    ];
    onChange(next);
    setOpenIndex(next.length - 1);
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[var(--color-bg)] px-3.5 py-3 text-xs leading-5 text-[var(--color-text-muted)]">
        A general price/package enquiry sends all options. If a customer names one package, only that package is sent.
      </div>

      {items.map((item, index) => {
        const expanded = openIndex === index;
        const packageName = item.name?.trim() || `Package ${index + 1}`;
        const subtitle = item.title?.trim() || (item.imageUrl ? "Image added" : "Details not completed");
        return (
          <div key={index} className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex items-center gap-3 p-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[10px] text-[var(--color-text-muted)]">
                {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : "No image"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{packageName}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-[var(--color-text-muted)]">{subtitle}</p>
                {item.aliases?.length > 0 && (
                  <p className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]">
                    Also called: {item.aliases.join(", ")}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpenIndex(expanded ? null : index)}
                className="h-10 shrink-0 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold"
              >
                {expanded ? "Close" : "Edit"}
              </button>
            </div>

            {expanded && (
              <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-4">
                <div className="grid gap-4">
                  <div>
                    <label className={labelClass}>Package name</label>
                    <input
                      className={inputClass}
                      value={item.name || ""}
                      placeholder="Package A"
                      onChange={(e) => updatePackage(index, "name", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Package title / description</label>
                    <input
                      className={inputClass}
                      value={item.title || ""}
                      placeholder="全身深层调理 + 骨盆全身体态调整（7合1）"
                      onChange={(e) => updatePackage(index, "title", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Customer may also call this</label>
                    <PromotionAliasChips
                      items={Array.isArray(item.aliases) ? item.aliases : []}
                      onChange={(value) => updatePackage(index, "aliases", value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Promotion image</label>
                    <ImageFieldEditor
                      value={item.imageUrl || ""}
                      onChange={(value) => updatePackage(index, "imageUrl", value)}
                      onError={onError}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Caption sent with this image</label>
                    <textarea
                      rows={3}
                      className={textareaClass}
                      value={item.caption || ""}
                      onChange={(e) => updatePackage(index, "caption", e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <button
                      type="button"
                      onClick={() => removePackage(index)}
                      className="h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]"
                    >
                      Remove package
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenIndex(null)}
                      className="h-10 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-semibold text-white"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addPackage}
        className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
      >
        + Add package
      </button>
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
  const clinic = ["aesthetic_clinic", "tcm_clinic"].includes(config.businessType);
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
  const [items, setItems] = useState(() => config.serviceAliases || []);
  const [saving, setSaving] = useState(false);
  const [bulkService, setBulkService] = useState(() => serviceNames.length === 1 ? serviceNames[0] : "");
  const [bulkText, setBulkText] = useState("");
  const [bulkMessage, setBulkMessage] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const bulkInputRef = useRef(null);

  function normalizeAlias(value) {
    return String(value || "").trim().toLowerCase();
  }

  function parseBulkTerms(value) {
    const seen = new Set();
    return String(value || "")
      .split(/[\n,，;；\t]+/u)
      .map((term) => term.trim())
      .filter((term) => {
        if (!term) return false;
        const key = normalizeAlias(term);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function addBulkTerms() {
    setBulkMessage(null);
    if (!bulkService) {
      setBulkMessage({ type: "error", text: "Choose the service these terms should map to." });
      return;
    }

    const terms = parseBulkTerms(bulkText);
    if (terms.length === 0) {
      setBulkMessage({ type: "error", text: "Paste or type at least one customer term first." });
      return;
    }

    const existingByAlias = new Map();
    for (const item of items) {
      const key = normalizeAlias(item.alias);
      if (key && !existingByAlias.has(key)) {
        existingByAlias.set(key, item.officialService);
      }
    }

    const conflicts = terms.filter((term) => {
      const existingService = existingByAlias.get(normalizeAlias(term));
      return existingService && existingService.toLowerCase() !== bulkService.toLowerCase();
    });
    if (conflicts.length > 0) {
      const first = conflicts[0];
      const existingService = existingByAlias.get(normalizeAlias(first));
      setBulkMessage({
        type: "error",
        text: `“${first}” is already mapped to “${existingService}”. Remove it there first if you want to remap it.`,
      });
      return;
    }

    const additions = terms
      .filter((term) => !existingByAlias.has(normalizeAlias(term)))
      .map((alias) => ({ alias, officialService: bulkService }));
    const skipped = terms.length - additions.length;

    if (additions.length > 0) {
      setItems((current) => [...current, ...additions]);
      setBulkText("");
    }

    if (additions.length > 0 && skipped > 0) {
      setBulkMessage({
        type: "success",
        text: `Added ${additions.length} term${additions.length === 1 ? "" : "s"} to ${bulkService}. Skipped ${skipped} already-added duplicate${skipped === 1 ? "" : "s"}.`,
      });
    } else if (additions.length > 0) {
      setBulkMessage({
        type: "success",
        text: `Added ${additions.length} term${additions.length === 1 ? "" : "s"} to ${bulkService}.`,
      });
    } else {
      setBulkMessage({
        type: "success",
        text: "Those terms are already added to this service.",
      });
    }
  }

  function removeTerm(alias, officialService) {
    setItems((current) =>
      current.filter(
        (item) =>
          !(item.alias === alias && item.officialService === officialService)
      )
    );
  }

  function addMoreForService(service) {
    setBulkService(service);
    setBulkMessage(null);
    bulkInputRef.current?.focus();
    bulkInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleSave() {
    const prepared = items
      .filter((a) => String(a.alias || "").trim() || String(a.officialService || "").trim())
      .map((a) => ({
        alias: String(a.alias || "").trim(),
        officialService: String(a.officialService || "").trim(),
      }));

    const seenMappings = new Set();
    const cleaned = prepared.filter((item) => {
      const key = `${normalizeAlias(item.alias)}::${item.officialService.toLowerCase()}`;
      if (seenMappings.has(key)) return false;
      seenMappings.add(key);
      return true;
    });

    if (cleaned.some((a) => !a.alias || !a.officialService)) {
      onError("Every service term needs both the customer wording and the service it maps to.");
      return;
    }

    const canonical = new Set(serviceNames.map((name) => name.toLowerCase()));
    if (cleaned.some((a) => !canonical.has(a.officialService.toLowerCase()))) {
      onError("Every service term must map to a service currently configured.");
      return;
    }

    const owners = new Map();
    for (const item of cleaned) {
      const key = normalizeAlias(item.alias);
      const previous = owners.get(key);
      if (previous && previous.toLowerCase() !== item.officialService.toLowerCase()) {
        onError(`“${item.alias}” is mapped to more than one service. Keep only one mapping before saving.`);
        return;
      }
      owners.set(key, item.officialService);
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

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const groupedServices = serviceNames
    .map((service) => {
      const serviceMatchesSearch = service.toLowerCase().includes(normalizedSearch);
      const serviceItems = items.filter((item) => item.officialService === service);
      const visibleItems = normalizedSearch
        ? serviceItems.filter(
            (item) =>
              serviceMatchesSearch ||
              String(item.alias || "").toLowerCase().includes(normalizedSearch)
          )
        : serviceItems;
      return {
        service,
        allItems: serviceItems,
        visibleItems,
        visible: !normalizedSearch || serviceMatchesSearch || visibleItems.length > 0,
      };
    })
    .filter((group) => group.visible);

  const orphanedItems = items.filter(
    (item) => !serviceNames.includes(item.officialService)
  );
  const totalTerms = items.length;
  const mappedServices = new Set(items.map((item) => item.officialService).filter(Boolean)).size;

  return (
    <div>
      <SectionHeading
        title="Service Terms"
        description="Teach the AI the different names and shorthand customers use for each configured service."
      />

      {serviceNames.length === 0 ? (
        <p className="rounded-xl bg-[var(--color-accent-light)] p-3 text-xs">
          Add at least one service before creating customer terms.
        </p>
      ) : (
        <>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 sm:p-5">
            <div className="mb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold sm:text-base">Quick add terms</h3>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    Choose one service, then paste many customer terms at once.
                  </p>
                </div>
                <span className="rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
                  Comma or new line
                </span>
              </div>
            </div>

            <div className="grid gap-3">
              <div>
                <label className={labelClass}>Maps to service</label>
                <select
                  aria-label="Maps to service"
                  className={inputClass}
                  value={bulkService}
                  onChange={(event) => {
                    setBulkService(event.target.value);
                    setBulkMessage(null);
                  }}
                >
                  <option value="">Choose a configured service</option>
                  {serviceNames.map((service) => (
                    <option key={service} value={service}>{service}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelClass}>Customer terms</label>
                <textarea
                  ref={bulkInputRef}
                  rows={4}
                  className={textareaClass}
                  value={bulkText}
                  placeholder={"Example:\n骨盆\n骨盘\n骨盆调整\npelvic adjustment"}
                  onChange={(event) => {
                    setBulkText(event.target.value);
                    setBulkMessage(null);
                  }}
                />
                <p className="mt-1.5 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  Paste from Excel/Sheets or type terms separated by commas, semicolons, or new lines. Use names and shorthand customers actually type—not symptoms such as 小腹凸 or 腰酸.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={addBulkTerms}
                  className="h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[var(--color-primary-hover)]"
                >
                  Add terms
                </button>
                {bulkText.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setBulkText("");
                      setBulkMessage(null);
                    }}
                    className="h-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-semibold text-[var(--color-text-muted)]"
                  >
                    Clear
                  </button>
                )}
              </div>

              {bulkMessage && (
                <div
                  className={`rounded-xl px-3.5 py-3 text-xs leading-5 ${
                    bulkMessage.type === "error"
                      ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]"
                      : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                  }`}
                >
                  {bulkMessage.text}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-sm font-bold sm:text-base">Existing terms</h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {totalTerms} term{totalTerms === 1 ? "" : "s"} across {mappedServices} service{mappedServices === 1 ? "" : "s"}.
              </p>
            </div>
            <div className="w-full sm:max-w-xs">
              <label className={labelClass}>Search</label>
              <input
                type="search"
                className={inputClass}
                value={searchTerm}
                placeholder="Search service or term"
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {groupedServices.map(({ service, allItems, visibleItems }) => (
              <div
                key={service}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5 sm:p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-bold">{service}</p>
                      <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
                        {allItems.length} term{allItems.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => addMoreForService(service)}
                    className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold"
                  >
                    + Add terms
                  </button>
                </div>

                {visibleItems.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {visibleItems.map((item, index) => (
                      <span
                        key={`${item.alias}-${index}`}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs"
                      >
                        <span className="max-w-[15rem] truncate sm:max-w-[22rem]">{item.alias}</span>
                        <button
                          type="button"
                          onClick={() => removeTerm(item.alias, item.officialService)}
                          aria-label={`Remove ${item.alias}`}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger)]"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                    {normalizedSearch ? "No matching terms in this service." : "No customer terms added yet."}
                  </p>
                )}
              </div>
            ))}

            {groupedServices.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-5 text-center text-xs text-[var(--color-text-muted)]">
                No service terms match “{searchTerm}”.
              </div>
            )}

            {orphanedItems.length > 0 && !normalizedSearch && (
              <div className="rounded-2xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-light)] p-4">
                <p className="text-sm font-bold text-[var(--color-danger)]">Needs attention</p>
                <p className="mt-1 text-xs leading-5 text-[var(--color-danger)]">
                  These terms point to services that no longer exist. Remove them or recreate the missing service before saving.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {orphanedItems.map((item, index) => (
                    <span
                      key={`${item.alias}-orphan-${index}`}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface)] px-2.5 py-1.5 text-xs"
                    >
                      <span>{item.alias} → {item.officialService}</span>
                      <button
                        type="button"
                        onClick={() => removeTerm(item.alias, item.officialService)}
                        aria-label={`Remove ${item.alias}`}
                        className="text-[var(--color-danger)]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5">
            <SaveButton saving={saving} onClick={handleSave} />
          </div>
        </>
      )}
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

function PromotionsTab({ config, onSaved, onError }) {
  const serviceNames = (config.services || []).map((service) => service.name).filter(Boolean);
  const [items, setItems] = useState(() =>
    (config.promotions || []).map((p) => ({
      ...p,
      _offerType: Array.isArray(p.packages) && p.packages.length > 0 ? "packages" : "single",
      linkedService: p.linkedService || "",
      sendOnPriceQuery: p.sendOnPriceQuery === true,
      packages: Array.isArray(p.packages)
        ? p.packages.map((item) => ({
            ...item,
            name: item.name || "",
            title: item.title || "",
            aliases: Array.isArray(item.aliases) ? [...item.aliases] : [],
            imageUrl: item.imageUrl || "",
            caption: item.caption || "",
          }))
        : [],
      imageUrl: p.imageUrl || "",
      caption: p.caption || "",
      validFrom: p.validFrom || "",
      validUntil: p.validUntil || "",
    }))
  );
  const [openIndex, setOpenIndex] = useState(null);
  const [saving, setSaving] = useState(false);

  function updateItem(index, patch) {
    const next = items.slice();
    next[index] = { ...next[index], ...patch };
    setItems(next);
  }

  function addPromotion() {
    const service = serviceNames.length === 1 ? serviceNames[0] : "";
    const next = [
      ...items,
      {
        name: service ? `${service} Promotion` : "",
        linkedService: service,
        sendOnPriceQuery: true,
        _offerType: "single",
        packages: [],
        imageUrl: "",
        caption: "",
        validFrom: "",
        validUntil: "",
      },
    ];
    setItems(next);
    setOpenIndex(next.length - 1);
  }

  function removePromotion(index) {
    setItems(items.filter((_, itemIndex) => itemIndex !== index));
    setOpenIndex((current) => {
      if (current === index) return null;
      if (current != null && current > index) return current - 1;
      return current;
    });
  }

  function selectService(index, service) {
    const current = items[index];
    const autoName = !current.name?.trim() || current.name === `${current.linkedService} Promotion`;
    updateItem(index, {
      linkedService: service,
      ...(autoName ? { name: service ? `${service} Promotion` : "" } : {}),
    });
  }

  function hasPackageContent(promotion) {
    return Array.isArray(promotion?.packages) && promotion.packages.some((item) =>
      String(item?.name || "").trim() ||
      String(item?.title || "").trim() ||
      String(item?.imageUrl || "").trim() ||
      String(item?.caption || "").trim() ||
      (Array.isArray(item?.aliases) && item.aliases.some((alias) => String(alias || "").trim()))
    );
  }

  function hasSingleOfferContent(promotion) {
    return Boolean(
      String(promotion?.imageUrl || "").trim() ||
      String(promotion?.caption || "").trim()
    );
  }

  function changeOfferType(index, nextType) {
    const current = items[index];
    if (!current || current._offerType === nextType) return;

    let warning = "";
    if (nextType === "single" && hasPackageContent(current)) {
      const packageCount = current.packages.filter((item) =>
        String(item?.name || "").trim() ||
        String(item?.title || "").trim() ||
        String(item?.imageUrl || "").trim() ||
        String(item?.caption || "").trim() ||
        (Array.isArray(item?.aliases) && item.aliases.some((alias) => String(alias || "").trim()))
      ).length;
      warning = `Changing to Single offer will remove ${packageCount} package option${packageCount === 1 ? "" : "s"} when you save. Continue?`;
    } else if (nextType === "packages" && hasSingleOfferContent(current)) {
      warning = "Changing to Multiple packages will remove the current single-offer image and caption when you save. Continue?";
    }

    if (warning && !window.confirm(warning)) return;
    updateItem(index, { _offerType: nextType });
  }

  async function handleSave() {
    const emptyPackagePromotion = items.find(
      (promotion) =>
        promotion._offerType === "packages" &&
        !hasPackageContent(promotion)
    );
    if (emptyPackagePromotion) {
      onError("Add at least one package, or switch this promotion to Single offer.");
      return;
    }

    const cleaned = items
      .filter((p) =>
        p.name.trim() ||
        p.linkedService.trim() ||
        p.imageUrl.trim() ||
        p.caption.trim() ||
        (Array.isArray(p.packages) && p.packages.length > 0) ||
        p.validFrom ||
        p.validUntil
      )
      .map((p) => {
        const packageMode = p._offerType === "packages";
        return {
          name: p.name.trim(),
          linkedService: p.linkedService.trim(),
          sendOnPriceQuery: p.sendOnPriceQuery === true,
          packages: packageMode
            ? (Array.isArray(p.packages) ? p.packages : [])
                .filter((item) =>
                  String(item?.name || "").trim() ||
                  String(item?.title || "").trim() ||
                  String(item?.imageUrl || "").trim() ||
                  String(item?.caption || "").trim() ||
                  (Array.isArray(item?.aliases) && item.aliases.some((alias) => String(alias || "").trim()))
                )
                .map((item) => ({
                  name: String(item.name || "").trim(),
                  title: String(item.title || "").trim(),
                  aliases: cleanStrings(item.aliases || []),
                  imageUrl: String(item.imageUrl || "").trim(),
                  caption: String(item.caption || "").trim(),
                }))
            : [],
          imageUrl: packageMode ? "" : p.imageUrl.trim(),
          caption: packageMode ? "" : p.caption.trim(),
          validFrom: p.validFrom.trim() || null,
          validUntil: p.validUntil.trim() || null,
        };
      });

    if (cleaned.some((p) => !p.name)) {
      onError("Every promotion needs a name.");
      return;
    }

    const canonicalServices = new Set(serviceNames.map((name) => name.toLowerCase()));
    for (const promotion of cleaned) {
      if (promotion.sendOnPriceQuery) {
        if (!promotion.linkedService || !canonicalServices.has(promotion.linkedService.toLowerCase())) {
          onError("Automatic promotions must link to a configured service.");
          return;
        }
        if (promotion.packages.length > 0) {
          if (promotion.packages.some((item) => !item.name || !item.imageUrl || !item.caption)) {
            onError("Every package needs a name, image, and caption.");
            return;
          }
        } else if (!promotion.imageUrl || !promotion.caption) {
          onError("Add an image and caption for this offer.");
          return;
        }
      }
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
      setItems(cleaned.map((p) => ({
        ...p,
        _offerType: p.packages.length > 0 ? "packages" : "single",
        validFrom: p.validFrom || "",
        validUntil: p.validUntil || "",
      })));
      setOpenIndex(null);
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
        description="Create the offers your AI can share when customers ask about prices or packages."
      />
      {serviceNames.length === 0 && (
        <p className="mb-4 rounded-xl bg-[var(--color-accent-light)] p-3 text-xs">
          Add at least one service before creating a promotion.
        </p>
      )}

      <div className="space-y-3">
        {items.map((item, index) => {
          const expanded = openIndex === index;
          const packageMode = item._offerType === "packages";
          const displayName = item.linkedService || item.name || "New promotion";
          const offerSummary = packageMode
            ? `${item.packages.length} package${item.packages.length === 1 ? "" : "s"}`
            : "Single offer";
          const dateSummary = item.validFrom || item.validUntil
            ? `${item.validFrom || "Now"} – ${item.validUntil || "No end date"}`
            : "No date limit";

          return (
            <div key={index} className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-bold sm:text-base">{displayName}</p>
                    <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
                      {offerSummary}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.sendOnPriceQuery ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
                      {item.sendOnPriceQuery ? "Auto-send on" : "Auto-send off"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{dateSummary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenIndex(expanded ? null : index)}
                  className="h-10 shrink-0 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold"
                >
                  {expanded ? "Close" : "Edit"}
                </button>
              </div>

              {expanded && (
                <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                  <div className="grid gap-5">
                    <div>
                      <label className={labelClass}>Service</label>
                      <select
                        className={inputClass}
                        value={item.linkedService}
                        onChange={(event) => selectService(index, event.target.value)}
                      >
                        <option value="">Choose the service</option>
                        {serviceNames.map((service) => <option key={service} value={service}>{service}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className={labelClass}>Offer type</label>
                      <div className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--color-surface)] p-1">
                        {[
                          ["single", "Single offer"],
                          ["packages", "Multiple packages"],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={item._offerType === value}
                            onClick={() => changeOfferType(index, value)}
                            className={`min-h-10 rounded-lg px-3 text-xs font-semibold transition ${item._offerType === value ? "bg-white text-[var(--color-primary)] shadow-sm" : "text-[var(--color-text-muted)]"}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className={labelClass}>Valid from <span className="font-normal">(optional)</span></label>
                        <input type="date" className={inputClass} value={item.validFrom} onChange={(e) => updateItem(index, { validFrom: e.target.value })} />
                      </div>
                      <div>
                        <label className={labelClass}>Valid until <span className="font-normal">(optional)</span></label>
                        <input type="date" className={inputClass} value={item.validUntil} onChange={(e) => updateItem(index, { validUntil: e.target.value })} />
                      </div>
                    </div>

                    <label className="flex min-h-12 items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={item.sendOnPriceQuery === true}
                        onChange={(e) => updateItem(index, { sendOnPriceQuery: e.target.checked })}
                      />
                      <span>
                        <span className="block font-semibold">Send automatically on price/package enquiries</span>
                        <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">
                          The AI only sends media when it can match this service and offer safely.
                        </span>
                      </span>
                    </label>

                    {packageMode ? (
                      <div>
                        <div className="mb-2 flex items-end justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold">Packages</p>
                            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Each package can use a different image and caption.</p>
                          </div>
                        </div>
                        <PromotionPackagesEditor
                          items={item.packages}
                          onChange={(packages) => updateItem(index, { packages })}
                          onError={onError}
                        />
                      </div>
                    ) : (
                      <div className="grid gap-4">
                        <div>
                          <label className={labelClass}>Promotion image</label>
                          <ImageFieldEditor
                            value={item.imageUrl}
                            onChange={(imageUrl) => updateItem(index, { imageUrl })}
                            onError={onError}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>Caption sent with the image</label>
                          <textarea
                            rows={3}
                            className={textareaClass}
                            value={item.caption}
                            onChange={(e) => updateItem(index, { caption: e.target.value })}
                          />
                        </div>
                      </div>
                    )}

                    <details className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
                      <summary className="cursor-pointer text-xs font-semibold text-[var(--color-text-muted)]">Advanced details</summary>
                      <div className="mt-3">
                        <label className={labelClass}>Internal campaign name</label>
                        <input
                          className={inputClass}
                          value={item.name}
                          placeholder={item.linkedService ? `${item.linkedService} Promotion` : "October promotion"}
                          onChange={(e) => updateItem(index, { name: e.target.value })}
                        />
                        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Used internally to identify this promotion. Customers do not see it.</p>
                      </div>
                    </details>

                    <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                      <button
                        type="button"
                        onClick={() => removePromotion(index)}
                        className="h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]"
                      >
                        Remove promotion
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenIndex(null)}
                        className="h-10 rounded-xl border border-[var(--color-border)] bg-white px-4 text-xs font-semibold"
                      >
                        Finish editing
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={addPromotion}
          disabled={serviceNames.length === 0}
          className="h-11 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          + Add promotion
        </button>
      </div>

      <div className="mt-5">
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
