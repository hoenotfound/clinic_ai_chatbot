const SOURCE_LABELS = {
  meta_ads: "Meta Ads",
  meta_post: "Meta post",
  facebook_referral: "Facebook referral",
  instagram_referral: "Instagram referral",
  facebook_organic: "Facebook organic",
  instagram_organic: "Instagram organic",
  whatsapp_unattributed: "WhatsApp direct / untracked",
};

export function sourceLabel(value) {
  return SOURCE_LABELS[value] || value || "Unknown";
}

export function sourceTone(value) {
  if (value === "meta_ads") return "bg-blue-50 text-blue-700";
  if (value === "instagram_organic" || value === "instagram_referral") return "bg-pink-50 text-pink-700";
  if (value === "facebook_organic" || value === "facebook_referral" || value === "meta_post") return "bg-indigo-50 text-indigo-700";
  return "bg-slate-100 text-slate-600";
}

export function LeadSourceBadge({ source, className = "" }) {
  if (!source) return null;
  return (
    <span className={`rounded-full px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${sourceTone(source)} ${className}`}>
      {sourceLabel(source)}
    </span>
  );
}

export default function LeadAttributionPanel({ lead }) {
  const attribution = lead?.attribution;
  if (!attribution && !lead?.source) return null;

  const source = attribution?.source || lead.source;
  const adLabel = attribution?.ad_name || attribution?.headline || null;
  const adFieldLabel = attribution?.ad_name ? "Ad" : attribution?.headline ? "Creative" : "Ad";
  const campaignLabel = attribution?.campaign_name || null;
  const panelEyebrow = attribution ? "Captured acquisition" : "Lead source";
  const sourceOverride = attribution && lead.source && lead.source !== attribution.source
    ? lead.source
    : null;
  const campaignOverride = attribution && lead.campaign_name && lead.campaign_name !== attribution.campaign_name
    ? lead.campaign_name
    : null;

  return (
    <section className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{panelEyebrow}</p>
          <h3 className="mt-1 font-display text-base font-bold">{sourceLabel(source)}</h3>
        </div>
        <LeadSourceBadge source={source} />
      </div>

      <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <AttributionRow label="Channel" value={formatChannel(attribution?.channel || lead.channel)} />
        <AttributionRow label="Platform" value={attribution?.platform || (source === "meta_ads" ? "Meta" : null)} />
        <AttributionRow
          label={adFieldLabel}
          value={adLabel || (attribution?.meta_ad_id ? `Meta Ad ${attribution.meta_ad_id}` : null)}
          mutedFallback={source === "meta_ads" ? "Ad name available after Meta Ads API sync" : "—"}
        />
        <AttributionRow
          label="Campaign"
          value={campaignLabel}
          mutedFallback={source === "meta_ads" ? "Available after Meta Ads API sync" : "—"}
        />
        {sourceOverride && <AttributionRow label="Source override" value={sourceLabel(sourceOverride)} />}
        {campaignOverride && <AttributionRow label="Campaign override" value={campaignOverride} />}
        {attribution?.meta_ad_id && <AttributionRow label="Meta Ad ID" value={attribution.meta_ad_id} mono />}
        {attribution?.ctwa_clid && <AttributionRow label="CTWA click ID" value={attribution.ctwa_clid} mono />}
      </div>

      {(attribution?.headline || attribution?.body) && (
        <div className="mt-4 rounded-xl bg-[var(--color-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Referral creative</p>
          {attribution.headline && <p className="mt-1.5 text-xs font-semibold">{attribution.headline}</p>}
          {attribution.body && <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{attribution.body}</p>}
        </div>
      )}
    </section>
  );
}

function AttributionRow({ label, value, mutedFallback = "—", mono = false }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <p className={`mt-1 truncate text-xs ${value ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"} ${mono ? "font-mono" : ""}`} title={value || undefined}>
        {value || mutedFallback}
      </p>
    </div>
  );
}

function formatChannel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  if (channel === "whatsapp") return "WhatsApp";
  return channel || "—";
}
