import { useMemo, useState } from "react";
import { api } from "../api";

const AUTOMATIC_IMAGE_TEMPLATES = new Set(["ns_fu_pricing_graphic", "ns_fu_meridian_gift"]);
const AUTOMATIC_VARIABLE_TEMPLATES = new Set([
  "ns_fu1_service_checkin", ...AUTOMATIC_IMAGE_TEMPLATES,
]);

function supportedForAutomation(template) {
  if (template.status !== "APPROVED" || template.category !== "MARKETING" ||
      template.sendable !== true || !template.body?.text) return false;
  if (!["TEXT", "IMAGE", "VIDEO"].includes(template.header?.format || "TEXT")) return false;
  const fields = template.variableFields || [];
  return !fields.length || (
    AUTOMATIC_VARIABLE_TEMPLATES.has(template.name) && fields.length === 1 &&
    fields[0].component === "body" && fields[0].index === 1
  );
}

function chooseVariant(catalog, name, language) {
  const variants = (catalog?.templates || []).filter((item) => item.name === name);
  return variants.find((item) => item.language === language) ||
    variants.find((item) => item.language === "zh_CN") || variants[0] || null;
}

export function ApprovedFollowUpTemplatePicker({
  catalog, name, language = "auto", label, onChange, defaultOnly = false, id,
}) {
  const [query, setQuery] = useState("");
  const [previewLanguage, setPreviewLanguage] = useState("zh_CN");
  const candidates = useMemo(() => {
    const grouped = new Map();
    for (const template of catalog?.templates || []) {
      if (!supportedForAutomation(template) || (defaultOnly && ["IMAGE", "VIDEO"].includes(template.header?.format))) continue;
      if (language !== "auto" && template.language !== language) continue;
      const found = grouped.get(template.name);
      if (!found) grouped.set(template.name, []);
      grouped.get(template.name).push(template);
    }
    return [...grouped.entries()].filter(([key]) => key.toLowerCase().includes(query.trim().toLowerCase()));
  }, [catalog, defaultOnly, language, query]);
  const selected = chooseVariant(catalog, name, language === "auto" ? previewLanguage : language);
  const chosenVariants = (catalog?.templates || []).filter((t) => t.name === name);
  const selectable = candidates.some(([key]) => key === name);
  const format = selected?.header?.format || "TEXT";
  const supportedFormats = [...new Set(chosenVariants.filter(supportedForAutomation).map((v) => v.header?.format || "TEXT"))];
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-xs font-semibold" htmlFor={id}>{label}</label>
      <input
        aria-label={id === "free-entry-default-template" ? "Search approved WhatsApp templates" : "Search approved treatment templates"}
        type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="Search approved marketing templates"
        className="w-full rounded-lg border border-[var(--color-border)] bg-white p-2 text-xs"
      />
      <select id={id} aria-label={label} value={name || ""}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-white p-2 text-sm">
        <option value="">Choose an approved marketing template</option>
        {name && !selectable && <option value={name}>{name} — unavailable or unsupported</option>}
        {candidates.map(([key, versions]) => (
          <option key={key} value={key}>
            {key} · {versions[0].header?.format || "TEXT"} · {versions.map((v) => v.language).join(", ")}
          </option>
        ))}
      </select>
      {name && selected && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3" aria-label="Approved template preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold">{format} · {selected.category} · {selected.status}</span>
            {chosenVariants.length > 1 && language === "auto" && (
              <select aria-label="Preview template language" value={selected.language}
                onChange={(event) => setPreviewLanguage(event.target.value)}
                className="rounded border border-[var(--color-border)] bg-white p-1 text-xs">
                {chosenVariants.map((v) => <option key={v.language} value={v.language}>{v.language}</option>)}
              </select>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{selected.body?.text || "No approved body text"}</p>
          {selected.footer?.text && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{selected.footer.text}</p>}
          {(selected.variableFields || []).length > 0 &&
            <p className="mt-2 text-[11px] text-amber-800">Preview uses the approved template placeholders. Any supported treatment variable is filled by the existing worker; no AI-generated text is sent.</p>}
          {!supportedForAutomation(selected) &&
            <p role="alert" className="mt-2 text-xs text-red-700">This version is not supported for automated marketing follow-ups.</p>}
          <div className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2" aria-label="Template approval by language">
            <p className="text-[11px] font-semibold">Template approval by language · not sending eligibility</p>
            {["zh_CN", "en_US", "ms"].map((locale) => {
              const variant = chosenVariants.find((v) => v.language === locale);
              const ready = variant && supportedForAutomation(variant) &&
                (defaultOnly ? (variant.header?.format || "TEXT") === "TEXT" :
                  supportedFormats.length === 1 && (variant.header?.format || "TEXT") === format);
              return (
                <p key={locale} className={`text-[11px] ${ready ? "text-emerald-700" : "text-amber-800"}`}>
                  {locale}: {ready ? `Template approved · ${variant.header?.format || "TEXT"} header` :
                    variant ? "Blocked: unsupported or different header type" : "Missing: worker may use the configured fallback language"}
                </p>
              );
            })}
            {supportedFormats.length > 1 &&
              <p className="text-[11px] font-semibold text-red-700">
                Language versions have inconsistent header types. Use a single compatible format or the worker skips mismatches.
              </p>}
          </div>
        </div>
      )}
      {!catalog &&
        <p className="text-xs text-[var(--color-text-muted)]">The saved template name is retained. Load the Meta catalog to select an approved replacement.</p>}
      {defaultOnly &&
        <p className="text-[11px] text-[var(--color-text-muted)]">Default fallback accepts text headers only. To attach an approved IMAGE or VIDEO template, add a day-specific rule below and select its image or video.</p>}
    </div>
  );
}

export function FollowUpTemplateMediaPicker({ rule, index, template, catalog, language = "auto", freeEntryStatus, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState("");
  const format = template?.header?.format || "TEXT";
  const automaticImage = AUTOMATIC_IMAGE_TEMPLATES.has(template?.name);
  const needsAttachment = (format === "IMAGE" || format === "VIDEO") && !automaticImage;
  const reusable = (catalog?.reusableMedia || []).filter((item) =>
    item.format === format &&
    (item.compatibleTemplates == null || item.compatibleTemplates.includes(template?.name)) &&
    (!item.serviceName || item.serviceName === rule.serviceName) &&
    rule.serviceName && rule.serviceName !== "*"
  );
  const previewUrl = pendingPreviewUrl && rule.mediaKey ? pendingPreviewUrl : rule.mediaKey
    ? api.followUpTemplateMediaPreviewUrl(rule.mediaKey)
    : rule.mediaUrl && /^https:\/\//i.test(rule.mediaUrl) ? rule.mediaUrl : "";
  const attached = Boolean(rule.mediaKey || rule.mediaUrl);
  const variants = (catalog?.templates || []).filter((item) => item.name === rule.templateName);
  const selectedLanguages = language === "auto" ? ["zh_CN", "en_US", "ms"] : [language];
  const languageProblems = selectedLanguages.filter((code) => {
    const v = variants.find((item) => item.language === code);
    return v && (!supportedForAutomation(v) || (v.header?.format || "TEXT") !== format);
  });
  const mediaBlocked = needsAttachment && (
    !attached || !rule.serviceName || rule.serviceName === "*" ||
    (format === "VIDEO" && rule.videoCodecVerified !== true)
  );
  const serverEnabled = freeEntryStatus?.enabledOnServer === true;
  const serverBlocked = freeEntryStatus?.strictSevenDayBlocked === true ||
    (freeEntryStatus?.freeOnlyEnabled === true &&
      Number(freeEntryStatus?.billingSafety?.since_switch || 0) > 0);
  const configReady = Boolean(template && supportedForAutomation(template) &&
    !mediaBlocked && !languageProblems.length && !serverBlocked);

  const readinessNote = (
    <div className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs"
      aria-label={`Template rule configuration readiness ${index + 1}`}>
      <p className="font-semibold">Template/media fields: {configReady ? "Complete" : "Incomplete"}</p>
      {mediaBlocked && <p className="text-amber-800">
        {format === "VIDEO" && attached && !rule.videoCodecVerified
          ? "Blocked: video codec not verified. Verify the clinic video or upload a supported MP4."
          : "Blocked: select the matching treatment and required attachment."}
      </p>}
      {languageProblems.length > 0 && <p className="text-amber-800">
        Incompatible language headers: {languageProblems.join(", ")}. The worker skips mismatched versions.
      </p>}
      {!freeEntryStatus && <p className="text-amber-800">Server/billing eligibility not checked; do not assume this rule can send.</p>}
      {freeEntryStatus && (!serverEnabled || serverBlocked) &&
        <p className="text-amber-800">The server or billing safety checks currently block some extended sends.</p>}
      <p className="text-[11px] text-[var(--color-text-muted)]">
        This is configuration readiness only, not permission to send. Every lead still needs eligible free-entry
        timing, documented marketing consent, active approved template, and the server's strict zero-cost gate.
        Availability and free billing are never guaranteed by this preview.
      </p>
    </div>
  );

  async function chooseExisting(value) {
    if (!value) return;
    const item = reusable.find((entry) => entry.id === value);
    if (!item) return;
    setBusy(true);
    setError("");
    setPendingPreviewUrl("");
    try {
      if (item.mediaKey && format === "VIDEO") {
        const verified = await api.verifyFollowUpTemplateVideo(item.id);
        if (!verified?.key || verified.videoCodecVerified !== true)
          throw new Error("The existing video could not be verified as H.264/AAC.");
        setPendingPreviewUrl(verified.previewUrl || "");
        onChange({ mediaKey: verified.key, mediaUrl: "",
          mediaSourceId: verified.mediaSourceId || item.id, videoCodecVerified: true });
      } else if (item.mediaKey) {
        onChange({ mediaKey: item.mediaKey, mediaUrl: "", mediaSourceId: "", videoCodecVerified: false });
      } else if (item.imageId && format === "IMAGE") {
        const saved = await api.importFollowUpTemplateImage(item.id);
        if (!saved?.key) throw new Error("The selected image could not be attached.");
        setPendingPreviewUrl(saved.previewUrl || "");
        onChange({ mediaKey: saved.key, mediaUrl: "", mediaSourceId: saved.mediaSourceId || item.id, videoCodecVerified: false });
      } else {
        throw new Error("This item is not an attachable clinic image or video.");
      }
    } catch (e) { setError(e.message || "Could not attach clinic media."); }
    finally { setBusy(false); }
  }

  async function uploadFile(file) {
    if (!file) return;
    if (format === "IMAGE" && (!["image/png", "image/jpeg"].includes(file.type) || file.size > 5 * 1024 * 1024)) {
      setError("Choose a JPEG or PNG image no larger than 5MB."); return;
    }
    if (format === "VIDEO" && (!/\.mp4$/i.test(file.name) || file.size > 16 * 1024 * 1024)) {
      setError("Choose an H.264/AAC MP4 no larger than 16MB."); return;
    }
    setBusy(true);
    setError("");
    try {
      // Video goes through the existing server ffprobe validation, without transcoding.
      const result = format === "IMAGE"
        ? await api.uploadFollowUpTemplateImage(file)
        : await api.uploadFollowUpVideo(file);
      if (!result?.key) throw new Error("Media upload did not return a reusable key.");
      setPendingPreviewUrl(result.previewUrl || "");
      onChange({ mediaKey: result.key, mediaUrl: "", mediaSourceId: "", videoCodecVerified: format === "VIDEO" });
    } catch (e) { setError(e.message || "Could not upload media."); }
    finally { setBusy(false); }
  }

  if (!template) return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-text-muted)]">Select an approved template to choose its attachment.</p>
      {readinessNote}
    </div>
  );
  if (automaticImage || !needsAttachment) return (
    <div className="space-y-2 text-xs text-[var(--color-text-muted)]">
      {readinessNote}
      <p>{automaticImage
        ? "The worker selects the matching active promotion image. Do not attach a manual image."
        : "This TEXT template does not need a media attachment."}</p>
      {attached && (
        <button type="button" onClick={() => {
          setPendingPreviewUrl("");
          onChange({ mediaKey: "", mediaUrl: "", mediaSourceId: "", videoCodecVerified: false });
        }} className="rounded-lg border border-red-300 px-3 py-2 text-red-700">
          Remove incompatible attachment
        </button>
      )}
    </div>
  );
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3 sm:col-span-2">
      {readinessNote}
      <p className="text-xs font-bold">{format === "VIDEO" ? "Video attachment" : "Image attachment"} · required for this approved template</p>
      {(!rule.serviceName || rule.serviceName === "*") &&
        <p role="alert" className="text-xs text-amber-800">
          Choose an individual treatment above before attaching media; general all-treatment rules cannot send treatment-specific images or videos.
        </p>}
      <label className="block text-xs font-semibold">
        Choose from existing clinic {format === "VIDEO" ? "videos" : "pricing images"}
        <select aria-label={`Extended template media library ${index + 1}`} value=""
          disabled={busy || !rule.serviceName || rule.serviceName === "*"} onChange={(event) => chooseExisting(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-white p-2">
          <option value="">Choose saved {format === "VIDEO" ? "video" : "image"}</option>
          {reusable.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {format === "IMAGE" && reusable.some((item) => item.imageId) && (
        <p className="text-[11px] text-amber-800">
          A pricing image attached here becomes a static R2 asset. Recheck it when a promotion expires.
          For date-sensitive offers, use the supported automatic promotion-image template instead.
        </p>
      )}
      <label className="block text-xs font-semibold">
        Or upload a new {format === "VIDEO" ? "H.264/AAC MP4" : "JPG/PNG"}
        <input type="file" aria-label={`Extended template ${format.toLowerCase()} attachment ${index + 1}`}
          accept={format === "VIDEO" ? ".mp4,video/mp4" : "image/jpeg,image/png"}
          disabled={busy || !rule.serviceName || rule.serviceName === "*"}
          className="mt-1 block w-full min-w-0 text-xs"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            await uploadFile(file);
          }} />
      </label>
      {busy && <p role="status" className="text-xs">Checking and storing attachment…</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {attached && (
        <div className="space-y-2 rounded-lg bg-[var(--color-bg)] p-3">
          <p className="break-all text-xs font-semibold">Attached: {rule.mediaKey?.split("/").pop() || rule.mediaUrl}</p>
          {previewUrl && format === "IMAGE" && <img src={previewUrl} alt="Selected WhatsApp template image" className="max-h-44 w-full object-contain" />}
          {previewUrl && format === "VIDEO" && <video key={previewUrl} src={previewUrl} controls preload="none" playsInline className="max-h-44 w-full bg-black object-contain" />}
          <button type="button" disabled={busy} onClick={() => { setPendingPreviewUrl(""); onChange({ mediaKey: "", mediaUrl: "", mediaSourceId: "", videoCodecVerified: false }); }}
            className="rounded border border-[var(--color-border)] bg-white px-3 py-1.5 text-xs text-red-700">
            Remove attachment
          </button>
        </div>
      )}
      {format === "VIDEO" && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={rule.videoCodecVerified === true}
            onChange={(event) => onChange({ videoCodecVerified: event.target.checked })} />
          I verified this video is H.264 with AAC audio, not HEVC. Uploaded and reused clinic MP4s are checked server-side.
        </label>
      )}
      <details className="text-xs text-[var(--color-text-muted)]">
        <summary className="cursor-pointer">Advanced: trusted HTTPS media URL</summary>
        <input type="url" aria-label={`Extended template media URL ${index + 1}`}
          value={rule.mediaUrl || ""} disabled={!rule.serviceName || rule.serviceName === "*"}
          placeholder="https://approved-media-host.example/asset"
          onChange={(event) => {
            setPendingPreviewUrl("");
            onChange({ mediaUrl: event.target.value, mediaKey: "", mediaSourceId: "", videoCodecVerified: false });
          }}
          className="mt-2 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-white p-2 text-xs"/>
        <p className="mt-1">Only pre-approved HTTPS hosts configured on the server are permitted. Unknown hosts are blocked at send time.</p>
      </details>
      {!attached && <p className="text-xs text-amber-800">Attach an approved {format.toLowerCase()} before enabling this rule. The existing worker skips unsupported or missing media.</p>}
    </div>
  );
}

export { supportedForAutomation };
