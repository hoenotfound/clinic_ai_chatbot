import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import ContactAvatar from "../ContactAvatar";
import Spinner from "../Spinner";
import {
  APPOINTMENT_OPTIONS,
  CONSENT_OPTIONS,
  TEMPERATURE_OPTIONS,
  displayName,
  formatDateTime,
  inputToIso,
  toDateTimeInput,
} from "./pipelineUtils";

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15";
const labelClass = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]";

export default function LeadDrawer({ lead, stages, branches, owners, services, onClose, onSaved, onToast }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => formFromLead(lead));
  const [saving, setSaving] = useState(false);
  const [activities, setActivities] = useState(null);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [temperatureSuggestion, setTemperatureSuggestion] = useState(null);
  const [suggestingTemperature, setSuggestingTemperature] = useState(false);
  const [applyingTemperature, setApplyingTemperature] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setActivities(null);
    api.listLeadActivities(lead.id)
      .then((data) => {
        if (!cancelled) setActivities(data);
      })
      .catch((err) => {
        console.error("Failed to load lead activity:", err);
        if (!cancelled) onToast("Couldn't load this lead's activity.", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id, onToast]);

  useEffect(() => {
    // Pipeline SSE updates can arrive while this drawer remains mounted. Keep
    // the temperature current so a later full-form save cannot silently put an
    // AI-updated lead back to the drawer's stale value.
    setForm((current) => ({
      ...current,
      temperature: lead.temperature || "warm",
    }));
  }, [lead.temperature]);

  const selectedStage = useMemo(
    () => stages.find((stage) => Number(stage.id) === Number(form.stageId)),
    [form.stageId, stages]
  );

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateAppointmentStatus(value) {
    setForm((current) => {
      const next = { ...current, appointmentStatus: value };
      const stageKey = value === "set" ? "appointment_set" : value === "visited" ? "visited" : null;
      const matchingStage = stageKey
        ? stages.find((stage) => stage.system_key === stageKey)
        : null;
      if (matchingStage) next.stageId = String(matchingStage.id);
      return next;
    });
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateLead(lead.id, {
        stageId: Number(form.stageId),
        temperature: form.temperature,
        branchName: form.branchName || null,
        ownerUsername: form.ownerUsername || null,
        treatmentInterest: form.treatmentInterest || null,
        estimatedValue: form.estimatedValue === "" ? null : Number(form.estimatedValue),
        source: form.source || null,
        campaignName: form.campaignName || null,
        appointmentStatus: form.appointmentStatus,
        appointmentAt: inputToIso(form.appointmentAt),
        nextFollowUpAt: inputToIso(form.nextFollowUpAt),
        lostReason: form.lostReason || null,
        marketingConsent: form.marketingConsent,
        notes: form.notes || null,
      });
      onSaved(updated);
      onToast("Lead updated.", "info");
      setActivities(await api.listLeadActivities(lead.id));
    } catch (err) {
      onToast(err.message || "Couldn't update this lead.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddNote() {
    const content = note.trim();
    if (!content || savingNote) return;
    setSavingNote(true);
    try {
      const activity = await api.addLeadNote(lead.id, content);
      setActivities((current) => [activity, ...(current || [])]);
      setNote("");
      onToast("Note added.", "info");
    } catch (err) {
      onToast(err.message || "Couldn't add that note.", "error");
    } finally {
      setSavingNote(false);
    }
  }

  async function handleSuggestTemperature() {
    if (suggestingTemperature) return;
    setSuggestingTemperature(true);
    try {
      setTemperatureSuggestion(await api.suggestLeadTemperature(lead.id));
    } catch (err) {
      onToast(err.message || "Couldn't suggest a lead temperature.", "error");
    } finally {
      setSuggestingTemperature(false);
    }
  }

  async function useTemperatureSuggestion() {
    if (!temperatureSuggestion || applyingTemperature) return;
    if (form.temperature === temperatureSuggestion.temperature) {
      setTemperatureSuggestion(null);
      onToast(`This lead is already ${temperatureLabel(form.temperature)}.`, "info");
      return;
    }

    setApplyingTemperature(true);
    try {
      const updated = await api.updateLead(lead.id, {
        temperature: temperatureSuggestion.temperature,
      });
      update("temperature", updated.temperature);
      onSaved(updated);
      setTemperatureSuggestion(null);
      setActivities(await api.listLeadActivities(lead.id));
      onToast(`Lead changed to ${temperatureLabel(updated.temperature)}.`, "info");
    } catch (err) {
      onToast(err.message || "Couldn't apply the temperature suggestion.", "error");
    } finally {
      setApplyingTemperature(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" role="presentation" onMouseDown={onClose}>
      <aside
        className="h-full w-full max-w-2xl overflow-y-auto bg-[var(--color-bg)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Lead details for ${displayName(lead)}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <ContactAvatar src={lead.photo_url} channel={lead.channel} size={42} />
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg font-bold">{displayName(lead)}</h2>
              <p className="truncate text-xs text-[var(--color-text-muted)]">+{lead.whatsapp_number}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]" aria-label="Close lead details">✕</button>
        </header>

        <div className="p-5">
          <div className="mb-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigate(`/inbox?contact=${lead.contact_id}`)}
              className="rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)]"
            >
              View conversation
            </button>
            {lead.no_reply && <StatusPill tone="neutral">No customer reply</StatusPill>}
            {lead.needs_attention && <StatusPill tone="danger">Needs attention</StatusPill>}
            {lead.is_unread && <StatusPill tone="primary">Unread</StatusPill>}
          </div>

          <form onSubmit={handleSave} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-bold">Lead details</h3>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Update ownership, progress and the next action.</p>
              </div>
              <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ backgroundColor: selectedStage?.color || lead.stage_color }}>
                {selectedStage?.name || lead.stage_name}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pipeline stage">
                <select className={inputClass} value={form.stageId} onChange={(event) => update("stageId", event.target.value)}>
                  {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
              </Field>
              <Field label="Lead temperature">
                <select className={inputClass} value={form.temperature} onChange={(event) => update("temperature", event.target.value)}>
                  {TEMPERATURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Branch">
                <select className={inputClass} value={form.branchName} onChange={(event) => update("branchName", event.target.value)}>
                  <option value="">Unassigned</option>
                  {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </Field>
              <Field label="Lead owner">
                <select className={inputClass} value={form.ownerUsername} onChange={(event) => update("ownerUsername", event.target.value)}>
                  <option value="">No owner</option>
                  {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                </select>
              </Field>
              <Field label="Treatment interest">
                <input className={inputClass} list="pipeline-services" value={form.treatmentInterest} onChange={(event) => update("treatmentInterest", event.target.value)} placeholder="e.g. HIFU" />
                <datalist id="pipeline-services">{services.map((service) => <option key={service} value={service} />)}</datalist>
              </Field>
              <Field label="Estimated value (RM)">
                <input className={inputClass} type="number" min="0" step="0.01" value={form.estimatedValue} onChange={(event) => update("estimatedValue", event.target.value)} placeholder="0.00" />
              </Field>
              <Field label="Appointment status">
                <select className={inputClass} value={form.appointmentStatus} onChange={(event) => updateAppointmentStatus(event.target.value)}>
                  {APPOINTMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Appointment date and time">
                <input className={inputClass} type="datetime-local" value={form.appointmentAt} onChange={(event) => update("appointmentAt", event.target.value)} />
              </Field>
              <Field label="Next follow-up">
                <input className={inputClass} type="datetime-local" value={form.nextFollowUpAt} onChange={(event) => update("nextFollowUpAt", event.target.value)} />
              </Field>
              <Field label="Marketing consent">
                <select className={inputClass} value={form.marketingConsent} onChange={(event) => update("marketingConsent", event.target.value)}>
                  {CONSENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Lead source">
                <input className={inputClass} value={form.source} onChange={(event) => update("source", event.target.value)} placeholder="WhatsApp, Meta Ad, Referral…" />
              </Field>
              <Field label="Campaign">
                <input className={inputClass} value={form.campaignName} onChange={(event) => update("campaignName", event.target.value)} placeholder="Optional campaign name" />
              </Field>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold">Temperature suggestion</p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">AI can automatically move Warm leads when the chat has clear, high-confidence evidence. Staff can still review or override it.</p>
                </div>
                <button type="button" onClick={handleSuggestTemperature} disabled={suggestingTemperature} className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold hover:border-[var(--color-primary)]/40 disabled:opacity-50">
                  {suggestingTemperature && <Spinner className="h-3.5 w-3.5" />}
                  {suggestingTemperature ? "Reviewing chat…" : temperatureSuggestion ? "Check again" : "Suggest from chat"}
                </button>
              </div>

              {temperatureSuggestion && (
                <div className="mt-3 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-surface)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[var(--color-primary-light)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-primary)]">
                      Suggested: {temperatureLabel(temperatureSuggestion.temperature)}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                      {temperatureSuggestion.confidence} confidence
                    </span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${temperatureSuggestion.enoughInformation ? "text-emerald-600" : "text-amber-600"}`}>
                      {temperatureSuggestion.enoughInformation ? "Enough evidence" : "More information needed"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed">{temperatureSuggestion.reason}</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={useTemperatureSuggestion} disabled={applyingTemperature} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                      {applyingTemperature && <Spinner className="h-3.5 w-3.5" />}
                      {applyingTemperature ? "Applying…" : "Use suggestion"}
                    </button>
                    <button type="button" onClick={() => setTemperatureSuggestion(null)} disabled={applyingTemperature} className="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-50">Dismiss</button>
                  </div>
                </div>
              )}
            </div>

            {selectedStage?.stage_type === "lost" && (
              <div className="mt-4">
                <Field label="Lost reason">
                  <input className={inputClass} value={form.lostReason} onChange={(event) => update("lostReason", event.target.value)} placeholder="No budget, unreachable, chose another clinic…" />
                </Field>
              </div>
            )}

            <div className="mt-4">
              <Field label="Lead notes">
                <textarea className={`${inputClass} resize-y`} rows={3} value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Short summary visible to staff" />
              </Field>
            </div>

            <div className="mt-5 flex justify-end">
              <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                {saving && <Spinner className="h-4 w-4" />}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>

          <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <h3 className="font-display text-base font-bold">Activity</h3>
            <div className="mt-3 flex gap-2">
              <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an internal note…" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); handleAddNote(); } }} />
              <button type="button" onClick={handleAddNote} disabled={!note.trim() || savingNote} className="shrink-0 rounded-xl border border-[var(--color-border)] px-3.5 text-sm font-semibold hover:bg-[var(--color-bg)] disabled:opacity-50">
                {savingNote ? "Saving…" : "Add"}
              </button>
            </div>

            {activities === null ? (
              <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-[var(--color-text-muted)]" /></div>
            ) : activities.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">No activity yet.</p>
            ) : (
              <div className="mt-5 space-y-4">
                {activities.map((activity) => (
                  <div key={activity.id} className="relative border-l-2 border-[var(--color-border)] pl-4">
                    <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-[var(--color-primary)]" />
                    <p className="text-sm leading-relaxed">{activity.description}</p>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{activity.actor} · {formatDateTime(activity.created_at)}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

function formFromLead(lead) {
  return {
    stageId: String(lead.stage_id),
    temperature: lead.temperature || "warm",
    branchName: lead.branch_name || "",
    ownerUsername: lead.owner_username || "",
    treatmentInterest: lead.treatment_interest || "",
    estimatedValue: lead.estimated_value ?? "",
    source: lead.source || "",
    campaignName: lead.campaign_name || "",
    appointmentStatus: lead.appointment_status || "none",
    appointmentAt: toDateTimeInput(lead.appointment_at),
    nextFollowUpAt: toDateTimeInput(lead.next_follow_up_at),
    lostReason: lead.lost_reason || "",
    marketingConsent: lead.marketing_consent || "unknown",
    notes: lead.notes || "",
  };
}

function Field({ label, children }) {
  return <label><span className={labelClass}>{label}</span>{children}</label>;
}

function temperatureLabel(value) {
  return TEMPERATURE_OPTIONS.find(([option]) => option === value)?.[1] || value;
}

function StatusPill({ children, tone }) {
  const styles = {
    danger: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
    primary: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    neutral: "bg-slate-100 text-slate-600",
  };
  return <span className={`rounded-xl px-3 py-2 text-xs font-semibold ${styles[tone]}`}>{children}</span>;
}
