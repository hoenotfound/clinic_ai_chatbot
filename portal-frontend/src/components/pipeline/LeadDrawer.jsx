import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import ContactAvatar from "../ContactAvatar";
import Spinner from "../Spinner";
import {
  APPOINTMENT_OPTIONS,
  CONSENT_OPTIONS,
  TEMPERATURE_OPTIONS,
  contactIdentifier,
  displayName,
  buildLeadUpdatePayload,
  formatDateTime,
  isNoReply,
  toDateTimeInput,
} from "./pipelineUtils";

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15 disabled:cursor-not-allowed disabled:bg-[var(--color-bg)] disabled:text-[var(--color-text-muted)]";
const labelClass = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]";

export default function LeadDrawer({ lead, stages, owners, services, now, noReplyHours, onClose, onSaved, onToast }) {
  const navigate = useNavigate();
  const { permissions } = useAuth();
  const canManageLeads = permissions.manage_assigned_leads === true;
  const canAssignLeads = permissions.manage_lead_assignment === true;
  const [form, setForm] = useState(() => formFromLead(lead));
  const [dirtyFields, setDirtyFields] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [activities, setActivities] = useState(null);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [configuredBranches, setConfiguredBranches] = useState([]);

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
    let cancelled = false;
    api.getConfiguredBranches()
      .then((data) => {
        if (!cancelled) {
          setConfiguredBranches(Array.isArray(data?.branches) ? data.branches : []);
        }
      })
      .catch((err) => {
        console.error("Failed to load configured branches for lead editing:", err);
        if (!cancelled) {
          setConfiguredBranches([]);
          onToast("Couldn't refresh current branch options. Existing lead data is unchanged.", "warning");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id, onToast]);

  useEffect(() => {
    const latest = formFromLead(lead);
    setForm((current) => {
      const merged = { ...current };
      for (const [key, value] of Object.entries(latest)) {
        if (!dirtyFields.has(key)) merged[key] = value;
      }
      if (
        dirtyFields.has("temperature") ||
        dirtyFields.has("temperatureLocked")
      ) {
        merged.temperatureSource = current.temperatureSource;
      }
      return merged;
    });
  }, [lead, dirtyFields]);

  const selectedStage = useMemo(
    () => stages.find((stage) => Number(stage.id) === Number(form.stageId)),
    [form.stageId, stages]
  );
  const staleCurrentBranch = Boolean(form.branchName) && !configuredBranches.includes(form.branchName);

  function markDirty(...keys) {
    if (!canManageLeads) return;
    setDirtyFields((current) => new Set([...current, ...keys]));
  }

  function update(key, value) {
    if (!canManageLeads) return;
    setForm((current) => ({ ...current, [key]: value }));
    markDirty(key);
  }

  function updateTemperature(value) {
    if (!canManageLeads) return;
    setForm((current) => ({
      ...current,
      temperature: value,
      temperatureLocked: true,
      temperatureSource: "manual",
    }));
    markDirty("temperature", "temperatureLocked");
  }

  function updateTemperatureLock(allowAutomatic) {
    if (!canManageLeads) return;
    setForm((current) => ({
      ...current,
      temperatureLocked: !allowAutomatic,
      temperatureSource: allowAutomatic ? current.temperatureSource : "manual",
    }));
    markDirty("temperatureLocked");
  }

  function updateAppointmentStatus(value) {
    if (!canManageLeads) return;
    const stageKey = value === "set" ? "appointment_set" : value === "visited" ? "visited" : null;
    const matchingStage = stageKey
      ? stages.find((stage) => stage.system_key === stageKey)
      : null;
    setForm((current) => {
      const next = { ...current, appointmentStatus: value };
      if (matchingStage) next.stageId = String(matchingStage.id);
      return next;
    });
    markDirty("appointmentStatus");
    if (matchingStage && String(matchingStage.id) !== form.stageId) {
      markDirty("stageId");
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!canManageLeads || dirtyFields.size === 0) return;
    setSaving(true);
    try {
      const updated = await api.updateLead(
        lead.id,
        buildLeadUpdatePayload(form, { dirtyFields })
      );
      onSaved(updated);
      setForm(formFromLead(updated));
      setDirtyFields(new Set());
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
    if (!canManageLeads || !content || savingNote) return;
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
              <div className="flex items-center gap-2">
                <h2 className="truncate font-display text-lg font-bold">{displayName(lead)}</h2>
                {!canManageLeads && <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2 py-1 text-[9px] font-bold uppercase text-[var(--color-text-muted)]">View only</span>}
              </div>
              <p className="truncate text-xs text-[var(--color-text-muted)]">{contactIdentifier(lead)}</p>
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
            {isNoReply(lead, noReplyHours, now) && <StatusPill tone="neutral">No customer reply</StatusPill>}
            {lead.needs_attention && <StatusPill tone="danger">Needs attention</StatusPill>}
            {lead.is_unread && <StatusPill tone="primary">Unread</StatusPill>}
          </div>

          <form onSubmit={handleSave} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-bold">Lead details</h3>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {canManageLeads ? "Update progress and the next action." : "You can view this lead, but editing is disabled for your account."}
                </p>
              </div>
              <span className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ backgroundColor: selectedStage?.color || lead.stage_color }}>
                {selectedStage?.name || lead.stage_name}
              </span>
            </div>

            <fieldset disabled={!canManageLeads} className="disabled:opacity-90">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Pipeline stage">
                  <select className={inputClass} value={form.stageId} onChange={(event) => update("stageId", event.target.value)}>
                    {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                  </select>
                </Field>
                <Field label="Lead temperature">
                  <select className={inputClass} value={form.temperature} onChange={(event) => updateTemperature(event.target.value)}>
                    {TEMPERATURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <label className="mt-2 flex items-start gap-2 rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                    <input
                      type="checkbox"
                      checked={!form.temperatureLocked}
                      onChange={(event) => updateTemperatureLock(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]/25"
                    />
                    <span className="text-[11px] leading-4 text-[var(--color-text-muted)]">
                      Allow rules and AI scoring to update this temperature
                    </span>
                  </label>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                    {form.temperatureLocked
                      ? "Staff control is on. Automatic scoring cannot change it."
                      : `Automatic updates are allowed. Current source: ${temperatureSourceLabel(form.temperatureSource)}.`}
                  </p>
                </Field>
                <Field label="Branch">
                  <select className={inputClass} value={form.branchName} onChange={(event) => update("branchName", event.target.value)}>
                    <option value="">Unassigned</option>
                    {staleCurrentBranch && (
                      <option value={form.branchName}>{form.branchName} · no longer configured</option>
                    )}
                    {configuredBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                  </select>
                  {staleCurrentBranch ? (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-danger)]">
                      This is historical branch data. You can save other lead changes without touching it, but choose a current branch or Unassigned before changing the branch.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      Only branches that currently exist in Clinic Settings can be newly selected.
                    </p>
                  )}
                </Field>
                <Field label="Lead owner">
                  <select
                    className={inputClass}
                    value={form.ownerUsername}
                    disabled={!canManageLeads || !canAssignLeads}
                    onChange={(event) => update("ownerUsername", event.target.value)}
                    title={!canAssignLeads ? "Lead assignment is disabled for this account." : undefined}
                  >
                    <option value="">No owner</option>
                    {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                  </select>
                  {canManageLeads && !canAssignLeads && <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">Only staff with Assign leads permission can change ownership.</p>}
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
            </fieldset>

            {canManageLeads && (
              <div className="mt-5 flex justify-end">
                <button type="submit" disabled={saving || dirtyFields.size === 0} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                  {saving && <Spinner className="h-4 w-4" />}
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            )}
          </form>

          <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <h3 className="font-display text-base font-bold">Activity</h3>
            {canManageLeads ? (
              <div className="mt-3 flex gap-2">
                <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an internal note…" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); handleAddNote(); } }} />
                <button type="button" onClick={handleAddNote} disabled={!note.trim() || savingNote} className="shrink-0 rounded-xl border border-[var(--color-border)] px-3.5 text-sm font-semibold hover:bg-[var(--color-bg)] disabled:opacity-50">
                  {savingNote ? "Saving…" : "Add"}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">Activity history is available to view; adding notes is disabled for your account.</p>
            )}

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
    temperatureLocked: lead.temperature_locked === true,
    temperatureSource: lead.temperature_source || "system",
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

function temperatureSourceLabel(source) {
  return {
    ai: "AI conversation score",
    rule: "message rule",
    manual: "staff setting",
    system: "default",
  }[source] || "default";
}

function Field({ label, children }) {
  return <label><span className={labelClass}>{label}</span>{children}</label>;
}

function StatusPill({ children, tone }) {
  const styles = {
    danger: "bg-[var(--color-danger-light)] text-[var(--color-danger)]",
    primary: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
    neutral: "bg-slate-100 text-slate-600",
  };
  return <span className={`rounded-xl px-3 py-2 text-xs font-semibold ${styles[tone]}`}>{children}</span>;
}
