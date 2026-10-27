import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";

const OUTCOMES = [
  ["contacted", "Message sent, waiting for reply"],
  ["later", "Customer asked to follow up later"],
  ["booked", "Appointment confirmed"],
  ["not_interested", "Customer is not interested"],
  ["unable", "Could not contact customer"]
];
const OUTCOME_LABELS = Object.fromEntries(OUTCOMES);
const REASON_LABELS = {
  new: "Ready to contact",
  follow_up_due: "Follow-up due",
  interested_again: "Interested again",
  booking_cancelled: "Booking cancelled"
};
function inDaysLocal(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = n => String(n).padStart(2, "0");
  return [d.getFullYear(),pad(d.getMonth()+1),pad(d.getDate())].join("-") +
    "T" + [pad(d.getHours()),pad(d.getMinutes())].join(":");
}
function ageLabel(value) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  if (Number.isFinite(days) && days >= 0) {
    if (days === 0) return "Today";
    if (days === 1) return "1 day ago";
    return days + " days ago";
  }
  return fmt(value);
}
const fmt = (value) => value
  ? new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Not available";

export default function SalesFollowUp() {
  const { permissions } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState("weekly");
  const [temperature, setTemperature] = useState("all");
  const [selected, setSelected] = useState(null);
  const [outcome, setOutcome] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [recent, setRecent] = useState([]);
  const [undoConfirm, setUndoConfirm] = useState(null);
  const [openedLeadId, setOpenedLeadId] = useState(null);
  const [visibleCount, setVisibleCount] = useState(30);
  const canUpdate = permissions.manage_assigned_leads === true;
  const canExport = permissions.export_customer_data === true;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await api.getSalesFollowUps());
      if (canUpdate) {
        try { setRecent((await api.getRecentSalesFollowUps()).updates || []); }
        catch (err) { setRecent([]); showToast(err.message || "Recent results unavailable.", "error"); }
      }
    }
    catch (error) { setPayload(null); showToast(error.message || "Could not load follow-ups.", "error"); }
    finally { setLoading(false); }
  }, [canUpdate, showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const leads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (payload?.leads || [])
      .filter(lead => temperature === "all" || lead.temperature === temperature)
      .filter(lead => !query || [lead.customerName,lead.whatsappNumber,lead.treatment]
        .some(v => String(v || "").toLocaleLowerCase().includes(query)))
      .sort((a,b) => {
        const due = (a.reason === "follow_up_due" ? 0 : 1) - (b.reason === "follow_up_due" ? 0 : 1);
        return due || (a.temperature === "hot" ? 0 : 1) - (b.temperature === "hot" ? 0 : 1);
      });
  }, [payload,temperature,search]);
  const dueCount = (payload?.leads || []).filter(l => l.reason === "follow_up_due").length;
  useEffect(() => { setVisibleCount(30); }, [temperature, search]);

  async function exportReport() {
    if (exporting || !canExport) return;
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadSalesFollowUps(period);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast("Sales follow-up list downloaded.", "info");
    } catch (error) { showToast(error.message || "Export failed.", "error"); }
    finally { setExporting(false); }
  }

  function openResult(lead) {
    setSelected(lead);
    setOutcome("");
    setDueAt("");
  }

  function selectOutcome(value) {
    setOutcome(value);
    setDueAt(["contacted","later"].includes(value) ? inDaysLocal(3) : "");
  }

  async function undoResult() {
    if (!undoConfirm || saving) return;
    setSaving(true);
    try {
      await api.undoSalesFollowUp(undoConfirm.leadId, undoConfirm.eventId);
      setUndoConfirm(null);
      showToast("Previous result restored.", "info");
      await refresh();
    } catch (error) {
      setUndoConfirm(null);
      showToast(error.message || "Could not correct this result. Review Pipeline.", "error");
      await refresh();
    } finally { setSaving(false); }
  }

  async function saveResult(event) {
    event.preventDefault();
    if (!selected || saving || !canUpdate || !outcome) return;
    if (["later", "booked", "contacted"].includes(outcome) && !dueAt) {
      showToast("Choose a reminder or appointment date.", "warning");
      return;
    }
    setSaving(true);
    try {
      await api.updateSalesFollowUp(selected.leadId, {
        status: outcome,
        expectedLastInboundId: selected.lastInboundId,
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {})
      });
      setSelected(null);
      setOpenedLeadId(null);
      showToast("Result saved. Correct mistakes under Recent results.", "info");
      await refresh();
    } catch (error) {
      showToast(error.message || "Could not save result.", "error");
      if (error.status === 409) { setSelected(null); await refresh(); }
    } finally { setSaving(false); }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-7 lg:py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold sm:text-2xl">Customers to Contact</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Open WhatsApp, contact the customer, then record what happened.
            </p>
          </div>
          <button type="button" onClick={refresh} disabled={loading} className="rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium disabled:opacity-50">Refresh</button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-4">
          {[
            ["To Contact", payload?.counts?.pending ?? "–"],
            ["Follow-up Due", payload ? dueCount : "–"],
            ["High Interest", payload?.counts?.hot ?? "–"]
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-[var(--color-border)] bg-white p-3 sm:p-4">
              <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
              <p className="mt-1 font-display text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>


        {canUpdate && recent.length > 0 && (
          <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-white p-3">
            <h2 className="text-sm font-semibold">Recent results</h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Made a mistake? You can undo your last result within 10 minutes if nothing else has changed.
            </p>
            <div className="mt-2 grid gap-2">
              {recent.map(item => (
                <div key={item.eventId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--color-bg)] p-2 text-sm">
                  <span>{item.customerName} · {OUTCOME_LABELS[item.outcome] || item.outcome}</span>
                  <button type="button" onClick={() => setUndoConfirm(item)}
                    className="rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 font-medium">
                    Correct result
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-base font-bold">Customers waiting for follow-up</h2><p className="text-xs text-[var(--color-text-muted)]">Due reminders and high interest first</p></div>
          <label className="text-sm">
            <span className="mr-2 text-[var(--color-text-muted)]">Interest</span>
            <select value={temperature} onChange={event => setTemperature(event.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-white px-3 py-2">
              <option value="all">All</option><option value="hot">High interest</option><option value="warm">Interested</option>
            </select>
          </label>
        </div>
        <label htmlFor="sales-follow-up-search" className="mt-3 block text-xs text-[var(--color-text-muted)]">
          Find a customer
        </label>
        <input id="sales-follow-up-search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search name, phone or treatment" autoComplete="off"
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-white px-4 py-3 text-sm"/>
        {loading ? <p className="mt-8 text-sm text-[var(--color-text-muted)]">Loading follow-ups...</p>
          : !payload ? <p className="mt-8 text-sm">Unable to load. Use Refresh to retry.</p>
            : leads.length === 0 ? (
              <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-white p-6 text-center text-sm text-[var(--color-text-muted)]">
                {search.trim() ? "No customers match your search." : "No customers need a personal follow-up right now."}
              </div>
            ) : (
              <div className="mt-3 grid gap-3">
                {leads.slice(0, visibleCount).map(lead => (
                  <article key={lead.leadId} className="rounded-xl border border-[var(--color-border)] bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{lead.customerName}</h3>
                        <p className="mt-0.5 break-words text-sm text-[var(--color-text-muted)]">{lead.treatment} · {lead.whatsappNumber}</p>
                      </div>
                      <span className={"rounded-full px-2.5 py-1 text-xs font-semibold " + (lead.temperature === "hot" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>
                        {lead.temperature === "hot" ? "High Interest" : "Interested"}
                      </span>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-[var(--color-primary)]">
                      {REASON_LABELS[lead.reason] || "Ready to contact"}
                      {lead.reason === "follow_up_due" && lead.taskDueAt ? " · " + fmt(lead.taskDueAt) : ""}
                    </p>
                    {lead.summary && <p className="mt-2 text-sm">{lead.summary}</p>}
                    {lead.nextAction && <div className="mt-2 rounded-lg bg-[var(--color-bg)] p-2 text-sm"><strong>Suggested next step:</strong> {lead.nextAction}</div>}
                    <p className="mt-2 text-xs text-[var(--color-text-muted)]">Last customer reply: {ageLabel(lead.lastCustomerReplyAt)} · Assigned to {lead.owner}</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <a href={lead.whatsappUrl} target="_blank" rel="noopener noreferrer"
                        onClick={() => setOpenedLeadId(lead.leadId)}
                        className="rounded-lg bg-[var(--color-primary)] px-4 py-3 text-center text-sm font-semibold text-white">
                        1. Open WhatsApp
                      </a>
                      {canUpdate && <button type="button" onClick={() => openResult(lead)}
                        className="rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                        2. Record Result
                      </button>}
                    </div>
                    {openedLeadId === lead.leadId && (
                      <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
                        After messaging from your personal WhatsApp, return here to record the result.
                        Opening WhatsApp does not send a message automatically.
                      </p>
                    )}
                    <a href={"/inbox?contact=" + encodeURIComponent(lead.contactId)}
                      className="mt-3 inline-block text-sm text-[var(--color-primary)] hover:underline">View chatbot history</a>
                  </article>
                ))}
              </div>
            )}
        {leads.length > visibleCount && !loading && (
          <button type="button" onClick={() => setVisibleCount(value => value + 30)}
            className="mt-4 w-full rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium">
            Show more ({leads.length - visibleCount} remaining)
          </button>
        )}

        {canExport && (
          <details className="mt-6 rounded-xl border border-[var(--color-border)] bg-white p-3">
            <summary className="cursor-pointer text-sm font-semibold">Manager reports &amp; export</summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="sales-follow-up-period" className="text-sm font-medium">Report type</label>
            <select id="sales-follow-up-period" value={period} onChange={event => setPeriod(event.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-sm">
              <option value="weekly">Weekly pending list</option>
              <option value="monthly">Monthly pending + results</option>
            </select>
            <button type="button" onClick={exportReport} disabled={exporting || loading}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {exporting ? "Preparing..." : "Export CSV"}
            </button>
            <p className="w-full text-xs text-[var(--color-text-muted)]">
              Weekly downloads the pending backlog. Monthly also includes the current month's contacted and booking totals. Both include older outstanding enquiries.
            </p>
          </div>
          </details>
        )}


        {selected && canUpdate && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
            <form onSubmit={saveResult} role="dialog" aria-modal="true" aria-labelledby="sales-follow-up-result-title"
              className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
              <h2 id="sales-follow-up-result-title" className="text-lg font-bold">Update follow-up result</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{selected.customerName}</p>
              <fieldset className="mt-4 space-y-3">
                {OUTCOMES.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-3 text-sm">
                    <input type="radio" name="follow-up-outcome" value={value} checked={outcome === value}
                      onChange={() => { setOutcome(value); setDueAt(""); }} />
                    {label}
                  </label>
                ))}
              </fieldset>
              {["later", "booked", "contacted"].includes(outcome) && (
                <label className="mt-4 block text-sm font-medium">
                  {outcome === "booked" ? "Confirmed appointment date and time" :
                    outcome === "later" ? "Next follow-up date and time" : "Remind me again (optional)"}
                  <input type="datetime-local" required={outcome !== "contacted"} value={dueAt} onChange={event => setDueAt(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"/>
                </label>
              )}
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Opening WhatsApp does not mark a message as sent. Choose the actual result only after contacting the customer.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" disabled={saving} onClick={() => setSelected(null)}
                  className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm">Cancel</button>
                <button type="submit" disabled={saving} className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {saving ? "Saving..." : "Save result"}
                </button>
              </div>
            </form>
          </div>
        )}
        <ToastContainer toasts={toasts} onDismiss={dismissToast}/>
      </div>
    </div>
  );
}
