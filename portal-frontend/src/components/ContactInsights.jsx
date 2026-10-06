import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useBusinessConfig } from "../context/BusinessConfigContext";
import { getBusinessTerminology } from "../utils/businessTerminology";
import Spinner from "./Spinner";

const TEMPERATURE_STYLES = {
  hot: "bg-red-50 text-red-700 border-red-100",
  warm: "bg-orange-50 text-orange-700 border-orange-100",
  cold: "bg-blue-50 text-blue-700 border-blue-100",
};

const TEMPERATURE_LABELS = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

const TEMPERATURE_DOTS = {
  hot: "bg-red-500",
  warm: "bg-orange-500",
  cold: "bg-blue-500",
};

function valueOrFallback(value, fallback = "Not captured") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function conversionDisplay(summaryPreferred, lead, ui) {
  const status = lead?.appointmentStatus || "none";
  const formalAppointment = lead?.appointmentAt ? formatDateTime(lead.appointmentAt) : "";
  const optionLabel = Object.fromEntries(ui.conversionStatusOptions || []);

  if (status === "cancelled") return optionLabel.cancelled || "Cancelled";
  if (status === "reschedule") return optionLabel.reschedule || "Needs reschedule";
  if (status === "visited") {
    return formalAppointment ? `${optionLabel.visited || "Visited"} · ${formalAppointment}` : (optionLabel.visited || "Visited");
  }
  if (status === "set") {
    return formalAppointment || summaryPreferred || optionLabel.set || "Next step set";
  }
  return summaryPreferred || "";
}

function TemperatureBadge({
  temperature,
  onClick = null,
  manual = false,
  busy = false,
  expanded = false,
}) {
  const normalized = String(temperature || "").toLowerCase();
  const label = TEMPERATURE_LABELS[normalized];
  if (!label) return null;

  const interactiveProps = onClick
    ? {
        type: "button",
        onClick,
        disabled: busy,
        "aria-expanded": expanded,
        "aria-label": `Change lead temperature. Current temperature: ${label}`,
      }
    : {};
  const Component = onClick ? "button" : "span";

  return (
    <Component
      {...interactiveProps}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${TEMPERATURE_STYLES[normalized]} ${onClick ? "touch-manipulation transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/25 disabled:opacity-60" : ""}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${TEMPERATURE_DOTS[normalized]}`} />
      <span>{label}</span>
      {manual && (
        <span className="border-l border-current/20 pl-1.5 text-[9px] font-bold uppercase tracking-wide opacity-70">
          Manual
        </span>
      )}
      {onClick && <span aria-hidden="true" className={`text-[9px] transition-transform ${expanded ? "rotate-180" : ""}`}>▾</span>}
    </Component>
  );
}

function MiniBadge({ children }) {
  if (!children) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-muted)]">
      {children}
    </span>
  );
}

function DetailItem({ label, value }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-[var(--color-text)]">
        {valueOrFallback(value)}
      </p>
    </div>
  );
}

export default function ContactInsights({ contactId, className = "" }) {
  const { permissions } = useAuth();
  const { config } = useBusinessConfig();
  const ui = getBusinessTerminology(config || {});
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [temperatureEditorOpen, setTemperatureEditorOpen] = useState(false);
  const [temperatureSaving, setTemperatureSaving] = useState(false);
  const [temperatureError, setTemperatureError] = useState(null);
  const canManageLeads = permissions.manage_assigned_leads === true;

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getContactInsights(contactId);
      setData(result);
    } catch (err) {
      console.error("Failed to load contact insights:", err);
      setError(err.message || "Couldn't load AI insights.");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    setData(null);
    setTemperatureEditorOpen(false);
    setTemperatureError(null);
    load();
  }, [load]);

  if (loading) {
    return (
      <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Spinner className="text-[var(--color-primary)]" />
          Loading AI conversation insights…
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}>
        <p className="text-sm font-semibold">AI Conversation Insights</p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-xs font-semibold hover:bg-[var(--color-bg)]"
        >
          Try again
        </button>
      </section>
    );
  }

  const lead = data?.lead;
  const insights = data?.aiInsights;
  const summary = insights?.summary || {};
  const treatment = summary.treatmentInterest || lead?.treatmentInterest;
  const branch = summary.preferredBranch || lead?.branchName;
  const conversion = conversionDisplay(summary.preferredAppointment, lead, ui);

  async function updateLeadTemperature(patch) {
    if (!lead?.id || !canManageLeads || temperatureSaving) return;
    setTemperatureSaving(true);
    setTemperatureError(null);
    try {
      const updated = await api.updateLead(lead.id, patch);
      setData((current) => {
        if (!current?.lead || Number(current.lead.id) !== Number(lead.id)) return current;
        return {
          ...current,
          lead: {
            ...current.lead,
            temperature: updated?.temperature ?? current.lead.temperature,
            temperatureLocked:
              updated?.temperature_locked ??
              updated?.temperatureLocked ??
              current.lead.temperatureLocked,
            temperatureSource:
              updated?.temperature_source ??
              updated?.temperatureSource ??
              current.lead.temperatureSource,
          },
        };
      });
      setTemperatureEditorOpen(false);
    } catch (err) {
      console.error("Failed to update lead temperature:", err);
      setTemperatureError(err.message || "Couldn't update the lead temperature.");
    } finally {
      setTemperatureSaving(false);
    }
  }

  function selectTemperature(temperature) {
    updateLeadTemperature({
      temperature,
      temperatureLocked: true,
    });
  }

  function allowAutomaticTemperatureUpdates() {
    updateLeadTemperature({ temperatureLocked: false });
  }

  return (
    <section className={`overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)]" aria-hidden="true"><InsightIcon className="h-4 w-4" /></span>
            <div>
              <h3 className="text-sm font-bold">AI Conversation Insights</h3>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Latest saved conversation summary and lead details</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="shrink-0 rounded-lg border border-[var(--color-border)] bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-5 p-5">
        {lead && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">Current lead status</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TemperatureBadge
                temperature={lead.temperature}
                manual={lead.temperatureLocked}
                busy={temperatureSaving}
                expanded={temperatureEditorOpen}
                onClick={canManageLeads ? () => setTemperatureEditorOpen((current) => !current) : null}
              />
              <MiniBadge>{lead.stageName || "No stage"}</MiniBadge>
              {lead.isClosed && <MiniBadge>Closed journey</MiniBadge>}
            </div>

            {canManageLeads && temperatureEditorOpen && (
              <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold">Set lead temperature</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      Choosing a temperature gives staff control so AI and rules cannot overwrite it.
                    </p>
                  </div>
                  {temperatureSaving && <Spinner className="mt-0.5 shrink-0 text-[var(--color-primary)]" />}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  {["hot", "warm", "cold"].map((temperature) => (
                    <button
                      key={temperature}
                      type="button"
                      disabled={temperatureSaving}
                      onClick={() => selectTemperature(temperature)}
                      className={`min-h-10 touch-manipulation rounded-xl border px-2 py-2 text-xs font-semibold transition disabled:opacity-60 ${lead.temperature === temperature ? TEMPERATURE_STYLES[temperature] : "border-[var(--color-border)] bg-white text-[var(--color-text)] hover:bg-[var(--color-bg)]"}`}
                    >
                      {TEMPERATURE_LABELS[temperature]}
                    </button>
                  ))}
                </div>

                <div className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3 min-[390px]:flex-row min-[390px]:items-center min-[390px]:justify-between">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold">
                      Automatic scoring {lead.temperatureLocked ? "off" : "on"}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      {lead.temperatureLocked
                        ? "Staff control is active."
                        : "AI and conversation rules may update the temperature."}
                    </p>
                  </div>
                  {lead.temperatureLocked && (
                    <button
                      type="button"
                      disabled={temperatureSaving}
                      onClick={allowAutomaticTemperatureUpdates}
                      className="min-h-10 shrink-0 touch-manipulation rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-[11px] font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary-light)] disabled:opacity-60"
                    >
                      Allow AI updates
                    </button>
                  )}
                </div>

                {temperatureError && (
                  <p className="mt-2 text-[10px] leading-4 text-[var(--color-danger)]">{temperatureError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {!lead && (
          <div className="rounded-xl bg-[var(--color-bg)] px-4 py-4">
            <p className="text-sm font-semibold">No lead journey yet</p>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Lead details will appear here after this contact enters the pipeline.
            </p>
          </div>
        )}

        {lead && !insights && (
          <div className="rounded-xl bg-[var(--color-bg)] px-4 py-4">
            <p className="text-sm font-semibold">No AI summary yet</p>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              It will appear automatically after lead scoring completes for this lead journey.
            </p>
          </div>
        )}

        {insights && (
          <>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">AI assessment</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <TemperatureBadge temperature={insights.temperature} />
                    {insights.confidence && <MiniBadge>{`${insights.confidence} confidence`}</MiniBadge>}
                    <MiniBadge>{insights.applied ? "Applied when scored" : "Suggestion only"}</MiniBadge>
                  </div>
                </div>
              </div>
            </div>

            {insights.isStale && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                <p className="text-xs font-semibold">New customer messages since this summary</p>
                <p className="mt-1 text-[11px] leading-4">
                  This snapshot does not include the newest customer messages yet. It will refresh after the next scoring pass.
                </p>
              </div>
            )}

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">Chat summary</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--color-text)]">
                {valueOrFallback(summary.chatSummary, "No conversation summary was captured.")}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <DetailItem label={ui.insightsInterestLabel} value={treatment} />
              <DetailItem label={ui.preferredLocationLabel} value={branch} />
              <DetailItem label={ui.conversionLabel} value={conversion} />
              <DetailItem label="Main Concern / Goal" value={summary.mainConcern} />
            </div>

            <div className="rounded-xl border border-[var(--color-primary)]/15 bg-[var(--color-primary-light)] px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-primary)]">Recommended next action</p>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5">
                {valueOrFallback(summary.nextAction, "No specific next action captured.")}
              </p>
            </div>

            {insights.reason && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">Why the AI scored it this way</p>
                <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">{insights.reason}</p>
              </div>
            )}

            <div className="border-t border-[var(--color-border)] pt-3 text-[10px] text-[var(--color-text-muted)]">
              {insights.updatedAt ? `Updated ${formatDateTime(insights.updatedAt)}` : "Saved AI summary"}
            </div>
          </>
        )}
      </div>
    </section>
  );
}


function InsightIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
