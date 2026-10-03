import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import Spinner from "../Spinner";

const TIME_ZONE = "Asia/Kuala_Lumpur";
const PRESETS = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["custom", "Custom range"],
];
const LEVELS = [
  ["campaign", "Campaign"],
  ["adset", "Ad Set"],
  ["ad", "Ad"],
];

function dateInMalaysia(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeForDays(days) {
  const to = dateInMalaysia();
  return { from: shiftDate(to, -(days - 1)), to };
}

function formatCurrency(value, currency, { compact = false } = {}) {
  if (value == null || !currency) return "—";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
  }).format(Number(value) || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-MY", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function formatPercent(value) {
  if (value == null) return "—";
  return `${Number(value).toFixed(1)}%`;
}

function formatDateTime(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function SummaryCard({ label, value, detail }) {
  return (
    <div className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </p>
      <p className="mt-2 truncate font-display text-2xl font-bold text-[var(--color-text)]">
        {value}
      </p>
      {detail && (
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{detail}</p>
      )}
    </div>
  );
}

function EntityName({ row, level }) {
  const label = row.name || `${level === "adset" ? "Ad Set" : level === "ad" ? "Ad" : "Campaign"} ${row.id}`;
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-[var(--color-text)]">{label}</p>
      <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
        ID {row.id}{row.accountName ? ` · ${row.accountName}` : ""}
      </p>
    </div>
  );
}

export default function MetaAdsAnalyticsView({ onSwitchToCrm }) {
  const navigate = useNavigate();
  const initialRange = useMemo(() => rangeForDays(30), []);
  const [preset, setPreset] = useState("30");
  const [draftRange, setDraftRange] = useState(initialRange);
  const [appliedRange, setAppliedRange] = useState(initialRange);
  const [level, setLevel] = useState("campaign");
  const [accountId, setAccountId] = useState("all");
  const [campaignId, setCampaignId] = useState("");
  const [adsetId, setAdsetId] = useState("");
  const [adId, setAdId] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");

    api.getMetaAdsAnalytics({
      ...appliedRange,
      level,
      accountId,
      campaignId,
      adsetId,
      adId,
    })
      .then((payload) => {
        if (requestId === requestIdRef.current) setData(payload);
      })
      .catch((err) => {
        console.error("Failed to load Meta Ads analytics:", err);
        if (requestId === requestIdRef.current) {
          setError(err.message || "Couldn't load Meta Ads analytics.");
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [accountId, adId, adsetId, appliedRange, campaignId, level, refreshToken]);

  function applyPreset(value) {
    setPreset(value);
    if (value === "custom") return;
    setDraftRange(rangeForDays(Number(value)));
  }

  function applyDateRange() {
    setAppliedRange({ ...draftRange });
  }

  function changeAccount(value) {
    setAccountId(value);
    setCampaignId("");
    setAdsetId("");
    setAdId("");
    setLevel("campaign");
  }

  function changeLevel(nextLevel) {
    setLevel(nextLevel);
    if (nextLevel === "campaign") {
      setCampaignId("");
      setAdsetId("");
      setAdId("");
    } else if (nextLevel === "adset") {
      setAdsetId("");
      setAdId("");
    } else {
      setAdId("");
    }
  }

  function drillInto(row) {
    if (row.accountId) setAccountId(row.accountId);
    if (level === "campaign") {
      setCampaignId(row.id);
      setAdsetId("");
      setAdId("");
      setLevel("adset");
      return;
    }
    if (level === "adset") {
      setAdsetId(row.id);
      setAdId("");
      setLevel("ad");
      return;
    }
    viewLeads(row);
  }

  function viewLeads(row) {
    const params = new URLSearchParams({
      from: appliedRange.from,
      to: appliedRange.to,
      source: "meta_ads",
    });
    const effectiveAccountId = row?.accountId || (accountId !== "all" ? accountId : "");
    if (effectiveAccountId) params.set("meta_account_id", effectiveAccountId);

    const effectiveCampaignId = level === "campaign" && row?.id
      ? row.id
      : campaignId;
    const effectiveAdsetId = level === "adset" && row?.id
      ? row.id
      : adsetId;
    const effectiveAdId = level === "ad" && row?.id
      ? row.id
      : adId;

    if (effectiveCampaignId) params.set("meta_campaign_id", effectiveCampaignId);
    if (effectiveAdsetId) params.set("meta_adset_id", effectiveAdsetId);
    if (effectiveAdId) params.set("meta_ad_id", effectiveAdId);

    navigate(`/pipeline?${params.toString()}`);
  }

  const rows = data?.rows || [];
  const accounts = data?.accounts || [];
  const summary = data?.summary || {};
  const money = data?.money || {};
  const currency = money.currency;
  const coverage = data?.attributionCoverage || {};
  const selectedAccount = accounts.find((account) => account.accountId === accountId)
    || (accounts.length === 1 ? accounts[0] : null);
  const hasHierarchyFilter = Boolean(campaignId || adsetId || adId);
  const syncError = selectedAccount?.lastError || null;
  const noDataConfigured = !loading && !error && accounts.length === 0 && rows.length === 0;
  const mixedCurrency = money.mixedCurrency === true;

  return (
    <div data-testid="meta-ads-analytics" className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold sm:text-[22px]">Analytics</h1>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)] sm:text-sm">
              Connect Meta ad spend to CRM leads, appointments, visits and won outcomes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
            className="h-10 rounded-xl border border-[var(--color-border)] bg-white px-3 text-xs font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-bg)] disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
          <button
            type="button"
            onClick={onSwitchToCrm}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
          >
            CRM Analytics
          </button>
          <button
            type="button"
            className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-[var(--color-text)]"
          >
            Meta Ads
          </button>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[180px_1fr_1fr_190px_auto] lg:items-end">
          <label className="min-w-0">
            <span className="mb-1.5 block text-[11px] font-semibold text-[var(--color-text-muted)]">Date range</span>
            <select
              value={preset}
              onChange={(event) => applyPreset(event.target.value)}
              className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm"
            >
              {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <label className="min-w-0">
            <span className="mb-1.5 block text-[11px] font-semibold text-[var(--color-text-muted)]">From</span>
            <input
              type="date"
              value={draftRange.from}
              onChange={(event) => {
                setPreset("custom");
                setDraftRange((current) => ({ ...current, from: event.target.value }));
              }}
              className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm"
            />
          </label>

          <label className="min-w-0">
            <span className="mb-1.5 block text-[11px] font-semibold text-[var(--color-text-muted)]">To</span>
            <input
              type="date"
              value={draftRange.to}
              onChange={(event) => {
                setPreset("custom");
                setDraftRange((current) => ({ ...current, to: event.target.value }));
              }}
              className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm"
            />
          </label>

          <label className="min-w-0">
            <span className="mb-1.5 block text-[11px] font-semibold text-[var(--color-text-muted)]">Ad account</span>
            <select
              value={accountId}
              onChange={(event) => changeAccount(event.target.value)}
              className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 text-sm"
            >
              <option value="all">All ad accounts</option>
              {accounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.accountName || `Account ${account.accountId}`}
                  {account.currency ? ` · ${account.currency}` : ""}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={applyDateRange}
            disabled={loading || !draftRange.from || !draftRange.to}
            className="h-10 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </header>

      <main className="space-y-4 px-3.5 py-4 sm:px-5 sm:py-5 lg:px-7">
        {error && (
          <div className="rounded-2xl border border-[var(--color-danger)]/30 bg-white p-4 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {syncError && (
          <div className="rounded-2xl border border-[var(--color-danger)]/30 bg-white p-4">
            <p className="text-sm font-semibold text-[var(--color-danger)]">Meta Ads sync needs attention</p>
            <p className="mt-1 break-words text-xs leading-5 text-[var(--color-text-muted)]">{syncError}</p>
          </div>
        )}

        {mixedCurrency && (
          <div className="rounded-2xl border border-[var(--color-accent)]/30 bg-white p-4 text-xs leading-5 text-[var(--color-text-muted)]">
            Multiple ad-account currencies are selected ({(money.currencies || []).join(", ")}). Spend-based totals are hidden until you select one account, so currencies are never added together.
          </div>
        )}

        {noDataConfigured ? (
          <div className="rounded-3xl border border-[var(--color-border)] bg-white p-6 text-center sm:p-8">
            <h2 className="font-display text-lg font-bold">Meta Ads data isn't available yet</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--color-text-muted)]">
              Configure the Meta Marketing access token and ad account ID, then let the background sync complete its first backfill. This page reads the local synced data only.
            </p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-6">
              <SummaryCard
                label="Spend"
                value={mixedCurrency ? "Mixed" : formatCurrency(summary.spend, currency, { compact: true })}
                detail={currency || "Select one account for spend metrics"}
              />
              <SummaryCard
                label="CRM Leads"
                value={formatNumber(summary.crmLeads)}
                detail={`${formatNumber(summary.hotLeads)} hot`}
              />
              <SummaryCard
                label="Cost / Lead"
                value={formatCurrency(summary.costPerLead, currency)}
                detail="Meta spend ÷ CRM leads"
              />
              <SummaryCard
                label="Appointments"
                value={formatNumber(summary.appointments)}
                detail={`${formatPercent(summary.leadToAppointmentRate)} of leads`}
              />
              <SummaryCard
                label="Won"
                value={formatNumber(summary.won)}
                detail={`${formatPercent(summary.leadToWonRate)} of leads`}
              />
              <SummaryCard
                label="Est. ROAS"
                value={summary.estimatedRoas == null ? "—" : `${Number(summary.estimatedRoas).toFixed(2)}×`}
                detail={money.estimatedRoasAvailable ? "Estimated won value ÷ spend" : "Available when ad spend is in MYR"}
              />
            </section>

            <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Attribution coverage</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {formatNumber(coverage.matchedToSyncedAds)} of {formatNumber(coverage.metaAttributedLeads)} Meta-attributed leads match a synced Ad ID.
                  </p>
                </div>
                <span className="rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-xs font-bold">
                  {formatPercent(coverage.matchedRate)}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-bg)]">
                <div
                  className="h-full rounded-full bg-[var(--color-primary)] transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, Number(coverage.matchedRate) || 0))}%` }}
                />
              </div>
              {Number(coverage.unmatchedToSyncedAds) > 0 && (
                <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {coverage.unmatchedToSyncedAds} lead(s) have a captured Meta Ad ID but no matching locally synced insight row yet. They remain in CRM totals instead of being silently dropped.
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-[var(--color-border)] bg-white">
              <div className="border-b border-[var(--color-border)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-bold">Ads → CRM performance</h2>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      Spend and delivery come from Meta; lead outcomes come from your CRM journey.
                    </p>
                  </div>
                  <div className="inline-flex rounded-xl bg-[var(--color-bg)] p-1">
                    {LEVELS.map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        onClick={() => changeLevel(value)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${level === value ? "bg-white text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {hasHierarchyFilter && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-semibold text-[var(--color-text-muted)]">Drill-down:</span>
                    {campaignId && <span className="rounded-full bg-[var(--color-bg)] px-2.5 py-1">Campaign {campaignId}</span>}
                    {adsetId && <span className="rounded-full bg-[var(--color-bg)] px-2.5 py-1">Ad Set {adsetId}</span>}
                    {adId && <span className="rounded-full bg-[var(--color-bg)] px-2.5 py-1">Ad {adId}</span>}
                    <button
                      type="button"
                      onClick={() => {
                        setCampaignId("");
                        setAdsetId("");
                        setAdId("");
                        setLevel("campaign");
                      }}
                      className="font-semibold text-[var(--color-primary)]"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {loading && !data ? (
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner className="h-7 w-7 text-[var(--color-primary)]" />
                </div>
              ) : rows.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm font-semibold">No matching Meta Ads data</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">Try a wider date range or clear the current drill-down.</p>
                </div>
              ) : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="min-w-[1120px] w-full text-left">
                      <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                        <tr>
                          <th className="px-4 py-3 font-semibold">{LEVELS.find(([value]) => value === level)?.[1]}</th>
                          <th className="px-3 py-3 text-right font-semibold">Spend</th>
                          <th className="px-3 py-3 text-right font-semibold">Impr.</th>
                          <th className="px-3 py-3 text-right font-semibold">Clicks</th>
                          <th className="px-3 py-3 text-right font-semibold">CTR</th>
                          <th className="px-3 py-3 text-right font-semibold">CRM Leads</th>
                          <th className="px-3 py-3 text-right font-semibold">CPL</th>
                          <th className="px-3 py-3 text-right font-semibold">Appts.</th>
                          <th className="px-3 py-3 text-right font-semibold">Won</th>
                          <th className="px-3 py-3 text-right font-semibold">Est. ROAS</th>
                          <th className="px-4 py-3 text-right font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {rows.map((row) => (
                          <tr key={`${row.accountId || "unknown"}-${row.id}`} className="hover:bg-[var(--color-bg)]/60">
                            <td className="max-w-[280px] px-4 py-3"><EntityName row={row} level={level} /></td>
                            <td className="px-3 py-3 text-right text-xs font-semibold">{formatCurrency(row.spend, row.currency)}</td>
                            <td className="px-3 py-3 text-right text-xs">{formatNumber(row.impressions)}</td>
                            <td className="px-3 py-3 text-right text-xs">{formatNumber(row.clicks)}</td>
                            <td className="px-3 py-3 text-right text-xs">{formatPercent(row.ctr)}</td>
                            <td className="px-3 py-3 text-right text-xs font-semibold">{row.crmLeads}</td>
                            <td className="px-3 py-3 text-right text-xs">{formatCurrency(row.costPerLead, row.currency)}</td>
                            <td className="px-3 py-3 text-right text-xs">{row.appointments}</td>
                            <td className="px-3 py-3 text-right text-xs">{row.won}</td>
                            <td className="px-3 py-3 text-right text-xs">{row.estimatedRoas == null ? "—" : `${Number(row.estimatedRoas).toFixed(2)}×`}</td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex justify-end gap-2">
                                {row.crmLeads > 0 && (
                                  <button type="button" onClick={() => viewLeads(row)} className="text-xs font-semibold text-[var(--color-primary)]">
                                    Leads
                                  </button>
                                )}
                                <button type="button" onClick={() => drillInto(row)} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold">
                                  {level === "ad" ? "View leads" : "Drill down"}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="divide-y divide-[var(--color-border)] md:hidden">
                    {rows.map((row) => (
                      <article key={`${row.accountId || "unknown"}-${row.id}`} className="p-4">
                        <EntityName row={row} level={level} />
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">Spend</p>
                            <p className="mt-1 text-xs font-semibold">{formatCurrency(row.spend, row.currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">Leads</p>
                            <p className="mt-1 text-xs font-semibold">{row.crmLeads}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">CPL</p>
                            <p className="mt-1 text-xs font-semibold">{formatCurrency(row.costPerLead, row.currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">Appointments</p>
                            <p className="mt-1 text-xs font-semibold">{row.appointments}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">Won</p>
                            <p className="mt-1 text-xs font-semibold">{row.won}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase text-[var(--color-text-muted)]">ROAS</p>
                            <p className="mt-1 text-xs font-semibold">{row.estimatedRoas == null ? "—" : `${Number(row.estimatedRoas).toFixed(2)}×`}</p>
                          </div>
                        </div>
                        <div className="mt-3 flex gap-2">
                          {row.crmLeads > 0 && (
                            <button
                              type="button"
                              onClick={() => viewLeads(row)}
                              className="h-9 flex-1 rounded-xl border border-[var(--color-border)] text-xs font-semibold"
                            >
                              View leads
                            </button>
                          )}
                          {level !== "ad" && (
                            <button
                              type="button"
                              onClick={() => drillInto(row)}
                              className="h-9 flex-1 rounded-xl bg-[var(--color-primary)] text-xs font-semibold text-white"
                            >
                              Drill down
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4 text-xs leading-5 text-[var(--color-text-muted)]">
              <div className="flex flex-wrap justify-between gap-2">
                <span>
                  Data through: <strong className="text-[var(--color-text)]">{selectedAccount?.dataThrough || "No synced rows"}</strong>
                </span>
                <span>
                  Last sync: <strong className="text-[var(--color-text)]">{formatDateTime(selectedAccount?.lastSuccessAt)}</strong>
                </span>
              </div>
              <p className="mt-2">
                CTR, CPC and CPM are recalculated from total clicks, impressions and spend. Daily reach/frequency are intentionally not summed across this date range.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
