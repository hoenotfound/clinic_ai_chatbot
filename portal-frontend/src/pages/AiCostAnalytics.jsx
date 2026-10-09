import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const CATEGORY = {
  customer_reply: "Customer replies",
  follow_up_generation: "AI follow-ups",
  follow_up_translation: "Follow-up translation",
  follow_up_translation_batch: "Batch translation",
  lead_scoring: "Temperature scoring",
  voice_transcription: "Voice transcription",
};

function money(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Not available";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    minimumFractionDigits: amount < 0.01 && amount > 0 ? 4 : 2,
    maximumFractionDigits: amount < 0.01 && amount > 0 ? 4 : 2,
  }).format(amount);
}

export default function AiCostAnalytics({ onSwitchToCrm }) {
  const [days, setDays] = useState(7);
  const [refreshKey, setRefreshKey] = useState(0);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getAiCostAnalytics({ days })
      .then((result) => { if (!cancelled) setPayload(result); })
      .catch((err) => { if (!cancelled) setError(err.message || "Unable to load AI usage."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, refreshKey]);

  const daily = payload?.daily || [];
  const totals = useMemo(() => daily.reduce((acc, row) => ({
    usd: acc.usd + row.estimatedUsd,
    myr: acc.myr + (row.estimatedMyr || 0),
    leads: acc.leads + row.newLeads,
    priced: acc.priced + row.pricedCalls,
    unpriced: acc.unpriced + row.unpricedCalls,
    missing: acc.missing + row.unattributedCalls,
  }), { usd: 0, myr: 0, leads: 0, priced: 0, unpriced: 0, missing: 0 }), [daily]);
  const currency = payload?.currency || "USD";
  const value = (usd, myr) => money(currency === "MYR" ? myr : usd, currency);
  const total = currency === "MYR" ? totals.myr : totals.usd;
  const leadSummary = payload?.leadSummary || {};
  const perLead = leadSummary.pricedLeads
    ? (currency === "MYR" ? leadSummary.attributedMyr : leadSummary.attributedUsd) / leadSummary.pricedLeads
    : null;
  const pricedCount = totals.priced + totals.unpriced;

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <button type="button" onClick={onSwitchToCrm} className="mb-2 text-xs font-semibold text-[var(--color-primary)] hover:underline">
              Back to CRM Analytics
            </button>
            <h1 className="font-display text-xl font-bold">AI Costs</h1>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--color-text-muted)]">
              Model-based estimates, not provider invoices. Dates use Malaysia time. Historical
              Gemini calls before attribution are estimated from saved tokens, but cannot be assigned to individual leads.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="ai-cost-days" className="text-xs font-semibold">Period</label>
            <select id="ai-cost-days" value={days} onChange={(event) => setDays(Number(event.target.value))}
              className="h-10 rounded-lg border border-[var(--color-border)] bg-white px-2 text-xs">
              <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
            </select>
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)}
              className="h-10 rounded-lg border border-[var(--color-border)] bg-white px-3 text-xs font-semibold">Refresh</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4 sm:px-6">
        {error && <p role="alert" className="rounded-lg border border-[var(--color-danger)] p-3 text-sm">{error}</p>}
        {loading && <p role="status" className="text-sm text-[var(--color-text-muted)]">Loading AI costs…</p>}
        {!loading && payload && <>
          {!payload.usdToMyr && <p className="text-xs text-[var(--color-text-muted)]">
            Showing USD. Set AI_USD_MYR_RATE in Render to also display MYR estimates at your chosen exchange rate.
          </p>}
          <section aria-label="AI cost totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Estimated AI cost", value(totals.usd, totals.myr)],
              ["Avg. / attributed lead", perLead === null ? "No priced leads" : money(perLead, currency)],
              ["Leads with priced AI usage", (leadSummary.pricedLeads || 0).toLocaleString()],
              ["Unpriced AI calls", totals.unpriced.toLocaleString()],
            ].map(([label, content]) => (
              <div key={label} className="min-w-0 rounded-xl border border-[var(--color-border)] bg-white p-3.5">
                <p className="text-[11px] text-[var(--color-text-muted)]">{label}</p>
                <p className="mt-1 break-words text-lg font-bold sm:text-xl">{content}</p>
              </div>
            ))}
          </section>
          <p className="text-xs text-[var(--color-text-muted)]">
            {pricedCount} provider calls recorded in this period. {totals.missing} lack contact attribution.
            The average uses only priced calls linked to permitted CRM leads, not all costs
            divided by newly arriving contacts. Unpriced calls are excluded and could increase actual spending.
          </p>
          <section className="rounded-xl border border-[var(--color-border)] bg-white p-3.5 sm:p-4">
            <h2 className="mb-3 font-display text-sm font-bold">Daily AI spending and cost per active lead</h2>
            <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs">
              <thead className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                <tr><th className="py-2">Date (MYT)</th><th>New contacts</th><th>Priced leads</th><th>AI calls</th><th>Total est. cost</th><th>Avg. / priced lead</th></tr>
              </thead><tbody>{daily.map((row) => {
                const amount = currency === "MYR" ? row.estimatedMyr : row.estimatedUsd;
                return <tr key={row.day} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5">{row.day}</td><td>{row.newLeads}</td>
                  <td>{row.pricedActiveLeads}</td><td>{row.calls}</td>
                  <td>{money(amount, currency)}</td>
                  <td>{row.pricedActiveLeads
                    ? money((currency === "MYR" ? row.attributedMyr : row.attributedUsd) / row.pricedActiveLeads, currency)
                    : "—"}</td>
                </tr>;
              })}</tbody>
            </table></div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-[var(--color-border)] bg-white p-3.5 sm:p-4">
              <h2 className="mb-3 font-display text-sm font-bold">Cost by AI task</h2>
              {(payload.byCategory || []).length === 0 && <p className="text-xs">No usage recorded yet.</p>}
              <div className="space-y-3">
                {(payload.byCategory || []).map((row) => <div key={row.provider + ":" + row.purpose}>
                  <div className="flex justify-between gap-3 text-xs">
                    <span>{CATEGORY[row.purpose] || row.purpose} <span className="text-[var(--color-text-muted)]">({row.provider})</span></span>
                    <span className="font-semibold">{value(row.estimatedUsd, row.estimatedMyr)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    {row.calls} calls · {row.unpricedCalls} unpriced · {row.promptTokens.toLocaleString()} input tokens
                  </p>
                </div>)}
              </div>
            </section>
            <section className="rounded-xl border border-[var(--color-border)] bg-white p-3.5 sm:p-4">
              <h2 className="mb-3 font-display text-sm font-bold">Most expensive lead journeys</h2>
              <p className="mb-3 text-xs text-[var(--color-text-muted)]">Costs for identified CRM leads in the selected period. Older unlinked usage cannot be attributed to a lead.</p>
              {(payload.byLead || []).length === 0 && <p className="text-xs">No attributed AI calls yet.</p>}
              <div className="max-h-80 space-y-2 overflow-auto">
                {(payload.byLead || []).map((row) => (
                  <div key={row.leadId} className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2 text-xs">
                    <div><p className="font-semibold">Lead #{row.leadId}</p>
                      <p className="text-[var(--color-text-muted)]">Contact #{row.contactId} · {row.calls} calls · {row.unpricedCalls} unpriced</p></div>
                    <span className="font-semibold">{value(row.estimatedUsd, row.estimatedMyr)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <section className="rounded-xl border border-[var(--color-border)] bg-white p-3.5 sm:p-4">
            <h2 className="mb-2 font-display text-sm font-bold">Cache diagnostics</h2>
            <p className="mb-3 text-xs text-[var(--color-text-muted)]">
              A short follow-up can be below Gemini's cache threshold. A longer prompt is only eligible, not guaranteed to hit cache.
              Missing metadata is not proof of no caching.
            </p>
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-xs">
              <thead className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                <tr><th className="py-2">Task / model</th><th>Avg. input</th><th>Below 4,096</th><th>Cache hits</th><th>Metadata missing</th></tr>
              </thead>
              <tbody>{(payload.cacheDiagnostics || []).map((row) =>
                <tr key={row.model + row.purpose} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5">{CATEGORY[row.purpose] || row.purpose} <span className="text-[var(--color-text-muted)]">{row.model}</span></td>
                  <td>{row.meanPromptTokens.toLocaleString()}</td><td>{row.below4096}/{row.successfulCalls}</td>
                  <td>{row.cacheHits}</td><td>{row.cacheMetadataMissing}</td>
                </tr>)}</tbody>
            </table></div>
          </section>
        </>}
      </main>
    </div>
  );
}
