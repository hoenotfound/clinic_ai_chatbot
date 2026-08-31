import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import Spinner from "../Spinner";
import ContactAvatar from "../ContactAvatar";
import {
  contactIdentifier,
  displayName,
  TEMPERATURE_OPTIONS,
} from "./pipelineUtils";

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15";

export default function AddLeadModal({ branches, services, onClose, onCreated, onToast }) {
  const [contacts, setContacts] = useState(null);
  const [search, setSearch] = useState("");
  const [contactId, setContactId] = useState(null);
  const [temperature, setTemperature] = useState("warm");
  const [branchName, setBranchName] = useState("");
  const [treatmentInterest, setTreatmentInterest] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listContacts("")
      .then((data) => {
        if (!cancelled) setContacts(data);
      })
      .catch((err) => {
        console.error("Failed to load contacts for lead creation:", err);
        if (!cancelled) onToast("Couldn't load contacts.", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [onToast]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return contacts || [];
    return (contacts || []).filter((contact) =>
      [
        contact.name,
        contact.whatsapp_profile_name,
        contact.whatsapp_number,
        contact.channel_user_id,
        contact.channel,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    );
  }, [contacts, search]);

  async function handleCreate() {
    if (!contactId || saving) return;
    setSaving(true);
    try {
      const result = await api.createLead({
        contactId,
        temperature,
        temperatureLocked: temperature !== "warm",
        branchName: branchName || null,
        treatmentInterest: treatmentInterest || null,
      });
      onCreated(result.lead, result.created);
    } catch (err) {
      onToast(err.message || "Couldn't create the lead.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-3xl bg-[var(--color-surface)] shadow-2xl" role="dialog" aria-modal="true" aria-label="Add lead" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between border-b border-[var(--color-border)] px-6 py-5">
          <div>
            <h2 className="font-display text-xl font-bold">Add lead</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Choose an existing contact to start a sales journey.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]" aria-label="Close">✕</button>
        </header>

        <div className="min-h-0 overflow-y-auto p-6">
          <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, number or social ID…" autoFocus />
          <div className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-[var(--color-border)]">
            {contacts === null ? (
              <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-[var(--color-text-muted)]" /></div>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">No matching contacts. Add the patient from Contacts first.</p>
            ) : filtered.map((contact) => (
              <button key={contact.id} type="button" onClick={() => setContactId(contact.id)} className={`flex w-full items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 ${Number(contactId) === Number(contact.id) ? "bg-[var(--color-primary-light)]" : "hover:bg-[var(--color-bg)]"}`}>
                <ContactAvatar src={contact.photo_url} channel={contact.channel} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{displayName(contact)}</p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">{contactIdentifier(contact)}</p>
                </div>
                {Number(contactId) === Number(contact.id) && <span className="text-sm font-bold text-[var(--color-primary)]">✓</span>}
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label>
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Temperature</span>
              <select className={inputClass} value={temperature} onChange={(event) => setTemperature(event.target.value)}>
                {TEMPERATURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <span className="mt-1.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">
                A staff-selected Hot or Cold value is protected from automatic updates.
              </span>
            </label>
            <label>
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Branch</span>
              <select className={inputClass} value={branchName} onChange={(event) => setBranchName(event.target.value)}>
                <option value="">Unassigned</option>
                {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Treatment interest</span>
            <input className={inputClass} list="new-lead-services" value={treatmentInterest} onChange={(event) => setTreatmentInterest(event.target.value)} placeholder="Optional" />
            <datalist id="new-lead-services">{services.map((service) => <option key={service} value={service} />)}</datalist>
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--color-border)] px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={!contactId || saving} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
            {saving && <Spinner className="h-4 w-4" />}
            {saving ? "Adding…" : "Add lead"}
          </button>
        </footer>
      </div>
    </div>
  );
}
