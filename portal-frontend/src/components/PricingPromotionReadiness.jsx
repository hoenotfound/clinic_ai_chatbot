import { useState } from "react";
import { Link } from "react-router-dom";

const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "ms", label: "BM" },
  { key: "zh", label: "中文" },
];
const CLINIC_DATE_TIMEZONE = "Asia/Kuala_Lumpur";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function malaysiaDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_DATE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [fields.year, fields.month, fields.day].join("-");
}

function compareDateBound(raw, now, today) {
  const value = String(raw || "").trim();
  if (!value) return 0;
  if (DATE_ONLY.test(value)) {
    const date = new Date(value + "T00:00:00Z");
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return value < today ? -1 : value > today ? 1 : 0;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() < now.getTime() ? -1 : date.getTime() > now.getTime() ? 1 : 0;
}

function dateStatus(promotion, now, today) {
  const from = compareDateBound(promotion.validFrom, now, today);
  const until = compareDateBound(promotion.validUntil, now, today);
  if (from === null || until === null) return "invalid";
  if (promotion.validFrom && promotion.validUntil) {
    const first = String(promotion.validFrom);
    const last = String(promotion.validUntil);
    if (DATE_ONLY.test(first) && DATE_ONLY.test(last) && first > last) return "invalid";
    if (!DATE_ONLY.test(first) && !DATE_ONLY.test(last) &&
        Date.parse(first) > Date.parse(last)) return "invalid";
  }
  if (promotion.validFrom && from > 0) return "scheduled";
  if (promotion.validUntil && until < 0) return "expired";
  return "current";
}

function packageEntries(promotion) {
  if (Array.isArray(promotion.packages) && promotion.packages.length > 0) {
    return promotion.packages.filter((item) => item && typeof item === "object");
  }
  if (String(promotion.imageUrl || "").trim() || String(promotion.caption || "").trim()) {
    return [{ name: "Main offer", imageUrl: promotion.imageUrl, caption: promotion.caption,
      mediaTranslations: promotion.mediaTranslations }];
  }
  return [];
}

function localizedMedia(item, language) {
  const override = item?.mediaTranslations?.[language] || {};
  return {
    imageUrl: String(override.imageUrl || item?.imageUrl || "").trim(),
    caption: String(override.caption || item?.caption || "").trim(),
  };
}

function imageIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, "https://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return raw.split("?")[0];
  }
}

function inspectPromotion(promotion, services, activePerService, now, today, sendBothPelvicPackages) {
  const service = String(promotion.linkedService || "").trim();
  const key = normalized(service);
  const status = dateStatus(promotion, now, today);
  const serviceExists = services.some((entry) => normalized(entry?.name) === key);
  const packages = packageEntries(promotion);
  const problems = [];
  const notes = [];

  if (!service || !serviceExists) problems.push("Linked treatment is missing from Settings → Services.");
  if (status === "invalid") problems.push("Promotion dates are invalid.");
  if (status === "current" && key && activePerService.get(key) > 1) {
    problems.push("More than one current promotion is linked to this treatment. The selector will skip it.");
  }
  if (!packages.length) problems.push("No pricing package image/caption configured.");

  const variants = packages.map((item, index) => {
    const languages = LANGUAGES.map(({ key: language, label }) => {
      const media = localizedMedia(item, language);
      return { key: language, label, complete: Boolean(media.imageUrl && media.caption) };
    });
    const base = { imageUrl: String(item.imageUrl || "").trim(), caption: String(item.caption || "").trim() };
    const preview = base.imageUrl && base.caption
      ? base : [localizedMedia(item, "zh"), localizedMedia(item, "en"), localizedMedia(item, "ms")]
        .find((media) => media.imageUrl && media.caption) || base;
    if (!String(item.name || "").trim()) problems.push("A package is missing its name.");
    if (!languages.every((entry) => entry.complete)) {
      problems.push("Package " + (String(item.name || "").trim() || index + 1) + " has missing image or caption coverage in some languages.");
    }
    return { item, index, languages, preview };
  });

  if (packages.length > 1) {
    // Mirror the server's exact package-name/title/alias ambiguity check.
    const termOwners = new Map();
    const normalizedTerm = (value) => String(value || "").toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
    for (const [packageIndex, option] of packages.entries()) {
      const terms = [option.name, option.title, ...(Array.isArray(option.aliases) ? option.aliases : [])];
      for (const term of new Set(terms.map(normalizedTerm).filter(Boolean))) {
        const owner = termOwners.get(term);
        if (owner !== undefined && owner !== packageIndex) {
          problems.push("Packages share the name or alias '" + term + "'. The package selector may be ambiguous.");
        }
        termOwners.set(term, packageIndex);
      }
    }
    const isPelvisAB = sendBothPelvicPackages && normalized(service) === normalized("骨盆调理") &&
      packages.length === 2 && packages.some((p) => normalized(p.name) === "package a") &&
      packages.some((p) => normalized(p.name) === "package b");
    if (isPelvisAB) {
      const identities = packages.map((p) => imageIdentity(p.imageUrl));
      if (identities.every(Boolean) && new Set(identities).size < identities.length) {
        problems.push("Package A and B share the same image. Both-package delivery may be skipped.");
      }
    } else {
      notes.push("Multiple packages: the customer must identify a package before its pricing graphic can be selected.");
    }
  }
  const uniqueProblems = [...new Set(problems)];
  return { promotion, service, status, problems: uniqueProblems, notes, variants,
    complete: status === "current" && uniqueProblems.length === 0 };
}

function statusLabel(status) {
  if (status === "current") return "Within date range";
  if (status === "scheduled") return "Scheduled";
  if (status === "expired") return "Expired";
  return "Invalid dates";
}

function PricingImage({ url, name }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-center text-[10px] text-[var(--color-text-muted)]">
        {url ? "Preview unavailable" : "No image"}
      </div>
    );
  }
  return <img src={url} alt={"Pricing graphic for " + name} onError={() => setFailed(true)}
    className="h-24 w-24 shrink-0 rounded-lg border border-[var(--color-border)] bg-white object-contain" loading="lazy" />;
}

/**
 * Display-only catalog inspection. This does not evaluate an individual lead,
 * run the worker, or guarantee a Meta send or a billing category.
 */
export default function PricingPromotionReadiness({
  services = [], promotions = [], pricingEnabled = false, sequenceEnabled = false,
  hasThirdStep = false, sendBothPelvicPackages = false,
  canManagePromotions = false, hasUnsavedChanges = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const now = new Date();
  const today = malaysiaDate(now);
  const activePerService = new Map();
  for (const promotion of promotions) {
    const key = normalized(promotion?.linkedService);
    if (key && dateStatus(promotion, now, today) === "current") {
      activePerService.set(key, (activePerService.get(key) || 0) + 1);
    }
  }
  const entries = promotions.map((promotion) =>
    inspectPromotion(promotion || {}, services, activePerService, now, today, sendBothPelvicPackages));
  const current = entries.filter((entry) => entry.status === "current");
  const ready = current.filter((entry) => entry.complete);
  const problems = entries.filter((entry) => entry.problems.length > 0);
  const noCurrent = entries.length > 0 && current.length === 0;
  const prerequisitesMet = sequenceEnabled && hasThirdStep;

  return (
    <section aria-label="Pricing promotion readiness" className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold">Pricing promotion readiness</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Read-only preview from Settings → Promotions. Complete media does not guarantee a reminder will send.
          </p>
        </div>
        {canManagePromotions && (
          <Link to="/settings?tab=promotions"
            onClick={(event) => {
              if (hasUnsavedChanges && !window.confirm("You have unsaved follow-up changes. Leave for Promotions without saving?")) {
                event.preventDefault();
              }
            }}
            className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)] hover:bg-[var(--color-bg)]"
          >Edit in Settings</Link>
        )}
      </div>
      <div aria-label="Pricing readiness summary" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-[var(--color-bg)] p-3">
          <p className="text-lg font-bold">{ready.length}/{current.length}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">Current promotions with full media</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] p-3">
          <p className="text-lg font-bold">{problems.length}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">Catalog entries needing attention</p>
        </div>
        <div className="col-span-2 rounded-lg bg-[var(--color-bg)] p-3 sm:col-span-1">
          <p className="text-sm font-bold">{!pricingEnabled ? "Reminder off" : !prerequisitesMet ? "Prerequisite missing" : "Configured on"}</p>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {!sequenceEnabled ? "Enable the regular sequence" : !hasThirdStep ? "Follow-up 3 is required" : "Per-contact eligibility still applies"}
          </p>
        </div>
      </div>
      {entries.length === 0 && (
        <p role="status" className="mt-3 rounded-lg border border-dashed border-[var(--color-border)] p-3 text-xs leading-5 text-[var(--color-text-muted)]">
          No pricing promotions configured. Add a linked treatment, pricing image and caption in Settings → Promotions.
        </p>
      )}
      {noCurrent && (
        <p role="status" className="mt-3 text-xs leading-5 text-amber-800">
          No promotions are currently within their configured date range.
        </p>
      )}
      {problems.length > 0 && (
        <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          {problems.length} promotion {problems.length === 1 ? "entry needs" : "entries need"} review.
          Open the catalog below to see missing media, invalid links or overlapping offers.
        </p>
      )}
      {entries.length > 0 && (
        <>
          <button type="button" aria-expanded={expanded} aria-controls="pricing-promotion-catalog"
            onClick={() => setExpanded((value) => !value)}
            className="mt-3 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-primary)]">
            <span>{expanded ? "Hide" : "Review"} promotion catalog ({entries.length})</span>
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          {expanded && (
            <div id="pricing-promotion-catalog" role="region" aria-label="Promotion catalog previews" className="mt-3 space-y-3">
              {entries.map((entry, index) => (
                <article key={index} aria-label={"Promotion " + (entry.promotion.name || index + 1)}
                  className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-bold">{entry.promotion.name || "Unnamed promotion"}</h3>
                      <p className="mt-0.5 break-words text-[11px] text-[var(--color-text-muted)]">
                        Treatment: {entry.service || "Not linked"} · {entry.variants.length} package{entry.variants.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <span className="rounded-full border border-[var(--color-border)] bg-white px-2 py-1 text-[11px] font-semibold">
                      {statusLabel(entry.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    Dates: {entry.promotion.validFrom || "No start"} → {entry.promotion.validUntil || "No end"}
                  </p>
                  {entry.problems.length > 0 && (
                    <div className="mt-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs leading-5 text-amber-900">
                      {entry.problems.map((issue) => <p key={issue}>{issue}</p>)}
                    </div>
                  )}
                  {entry.complete && (
                    <p className="mt-2 text-xs font-semibold text-[var(--color-primary)]">Catalog media complete · not a delivery guarantee</p>
                  )}
                  {entry.notes.map((note) => (
                    <p key={note} className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">{note}</p>
                  ))}
                  {entry.variants.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {entry.variants.map(({ item, index: packageIndex, languages, preview }) => (
                        <div key={packageIndex} aria-label={"Package " + (item.name || packageIndex + 1)}
                          className="flex min-w-0 gap-3 rounded-lg border border-[var(--color-border)] bg-white p-3">
                          <PricingImage url={preview.imageUrl} name={String(item.name || "package")} />
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-xs font-bold">{item.name || "Unnamed package"}</p>
                            {item.title && <p className="mt-0.5 break-words text-[11px] text-[var(--color-text-muted)]">{item.title}</p>}
                            <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-muted)]">
                              {preview.caption || "No preview caption"}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1" aria-label="Package language media coverage">
                              {languages.map((language) => (
                                <span key={language.key} className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " +
                                  (language.complete ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-amber-50 text-amber-800")}>
                                  {language.label}: {language.complete ? "Ready" : "Incomplete"}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
        Date-only ranges are previewed using Malaysia time. The server's clinic timezone and live promotion settings
        are authoritative. Actual sends also require a matching treatment/package, accepted Follow-up 3, safe spacing,
        an open channel reply window, consent where applicable, and provider approval.
      </p>
    </section>
  );
}
