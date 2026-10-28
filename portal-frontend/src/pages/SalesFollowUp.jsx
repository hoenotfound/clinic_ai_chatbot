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

const RETURN_KEY_PREFIX = "sales-follow-up:return:";
function getPendingReturn(username) {
  if (!username) return null;
  try {
    const saved = window.sessionStorage.getItem(RETURN_KEY_PREFIX + username);
    const id = Number(saved);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}
function rememberPendingReturn(username, leadId) {
  if (!username) return;
  try {
    if (leadId) window.sessionStorage.setItem(RETURN_KEY_PREFIX + username, String(leadId));
    else window.sessionStorage.removeItem(RETURN_KEY_PREFIX + username);
  } catch { /* Restricted/private browser storage: keep in-memory state. */ }
}

export default function SalesFollowUp() {
  const { permissions, username } = useAuth();
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
  const [openedLeadId, setOpenedLeadId] = useState(() => getPendingReturn(username));
  const [visibleCount, setVisibleCount] = useState(30);
  const canUpdate = permissions.manage_assigned_leads === true;
  const canExport = permissions.export_customer_data === true;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const incoming = await api.getSalesFollowUps();
      setPayload(incoming);
      const remembered = getPendingReturn(username);
      if (remembered && !incoming.leads?.some(lead => Number(lead.leadId) === remembered)) {
        rememberPendingReturn(username, null);
        setOpenedLeadId(null);
      }
      if (canUpdate) {
        try { setRecent((await api.getRecentSalesFollowUps()).updates || []); }
        catch (err) { setRecent([]); showToast(err.message || "Recent results unavailable.", "error"); }
      }
    }
    catch (error) { setPayload(null); showToast(error.message || "Could not load follow-ups.", "error"); }
    finally { setLoading(false); }
  }, [canUpdate, showToast, username]);

  useEffect(() => { setOpenedLeadId(getPendingReturn(username)); }, [username]);
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
  const returnLead = (payload?.leads || []).find(lead => Number(lead.leadId) === openedLeadId);
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
      if (Number(openedLeadId) === Number(selected.leadId)) {
        setOpenedLeadId(null);
        rememberPendingReturn(username, null);
      }
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
          <button type="button" onClick={refresh} disabled={loading} className="min-h-11 rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium disabled:opacity-50">Refresh</button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4">
          {[
            ["To Contact", payload?.counts?.pending ?? "–"],
            ["Follow-up Due", payload ? dueCount : "–"],
            ["High Interest", payload?.counts?.hot ?? "–"]
          ].map(([label, value], index) => (
            <div key={label} className={"rounded-xl border border-[var(--color-border)] bg-white p-3 sm:p-4 " + (index === 2 ? "col-span-2 sm:col-span-1" : "")}>
              <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
              <p className="mt-1 font-display text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>


        {canUpdate && returnLead && (
          <section aria-label="Continue WhatsApp follow-up"
            className="mt-4 rounded-xl border border-[var(--color-border)] bg-white p-3">
            <p className="text-sm font-semibold">Continue follow-up: {returnLead.customerName}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              If you sent a message in WhatsApp, return here to record what happened.
              Opening WhatsApp alone does not mean a message was sent.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => openResult(returnLead)}
                className="min-h-11 flex-1 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white">
                Continue: Record Result
              </button>
              <button type="button" onClick={() => { rememberPendingReturn(username, null); setOpenedLeadId(null); }}
                className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm">
                Dismiss
              </button>
            </div>
          </section>
        )}

        {canUpdate && recent.length > 0 && (
          <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-white p-3">
            <h2 className="text-sm font-semibold">Recent results</h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Made a mistake? You can undo your last result within 10 minutes if nothing else has changed.
            </p>
            <div className="mt-2 grid gap-2">
              {recent.map(item => (
                <div key={item.eventId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--color-bg)] p-2 text-sm">
                  <span className="min-w-0 flex-1 break-words">{item.customerName} · {OUTCOME_LABELS[item.outcome] || item.outcome}</span>
                  <button type="button" onClick={() => setUndoConfirm(item)}
                    className="min-h-11 shrink-0 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 font-medium">
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
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-base sm:text-sm">
              <option value="all">All</option><option value="hot">High interest</option><option value="warm">Interested</option>
            </select>
          </label>
        </div>
        <label htmlFor="sales-follow-up-search" className="mt-3 block text-xs text-[var(--color-text-muted)]">
          Find a customer
        </label>
        <input id="sales-follow-up-search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search name, phone or treatment" autoComplete="off"
          className="mt-1 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-white px-4 py-3 text-base sm:text-sm"/>
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
                        onClick={() => { setOpenedLeadId(lead.leadId); rememberPendingReturn(username, lead.leadId); }}
                        className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 py-3 text-center text-sm font-semibold text-white">
                        1. Open WhatsApp
                      </a>
                      {canUpdate && <button type="button" onClick={() => openResult(lead)}
                        className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
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
                      className="mt-3 inline-flex min-h-11 items-center text-sm text-[var(--color-primary)] hover:underline">View chatbot history</a>
                  </article>
                ))}
              </div>
            )}
        {leads.length > visibleCount && !loading && (
          <button type="button" onClick={() => setVisibleCount(value => value + 30)}
            className="mt-4 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium">
            Show more ({leads.length - visibleCount} remaining)
          </button>
        )}

        {canExport && (
          <details className="mt-6 rounded-xl border border-[var(--color-border)] bg-white p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Manager reports &amp; export</summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="sales-follow-up-period" className="text-sm font-medium">Report type</label>
            <select id="sales-follow-up-period" value={period} onChange={event => setPeriod(event.target.value)}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-base sm:text-sm">
              <option value="weekly">Weekly pending list</option>
              <option value="monthly">Monthly pending + results</option>
            </select>
            <button type="button" onClick={exportReport} disabled={exporting || loading}
              className="min-h-11 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
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
              className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 pb-0 shadow-xl sm:max-h-[90dvh]">
              <h2 id="sales-follow-up-result-title" className="text-lg font-bold">Record Follow-up Result</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{selected.customerName}</p>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">Select what actually happened. Opening WhatsApp alone does not count as contact.</p>
              <fieldset className="mt-4 space-y-3">
                <legend className="mb-2 text-sm font-semibold">What happened?</legend>
                {OUTCOMES.map(([value, label]) => (
                  <label key={value} className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm">
                    <input type="radio" name="follow-up-outcome" value={value} checked={outcome === value}
                      onChange={() => selectOutcome(value)} />
                    {label}
                  </label>
                ))}
              </fieldset>
              {["later", "booked", "contacted"].includes(outcome) && (
                <div className="mt-4">
                  <label htmlFor="sales-follow-up-due" className="block text-sm font-semibold">
                    {outcome === "booked" ? "Confirmed appointment date and time" : "When should we follow up again?"}
                  </label>
                  {outcome !== "booked" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" onClick={() => setDueAt(inDaysLocal(3))}
                        className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">In 3 days</button>
                      <button type="button" onClick={() => setDueAt(inDaysLocal(7))}
                        className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">In 7 days</button>
                    </div>
                  )}
                  <input id="sales-follow-up-due" type="datetime-local" required value={dueAt}
                    min={inDaysLocal(0)} onChange={event => setDueAt(event.target.value)}
                    className="mt-2 w-full min-w-0 rounded-lg border border-[var(--color-border)] px-3 py-3 text-base sm:text-sm"/>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {outcome === "booked" ? "Select this only when the appointment is confirmed." :
                      "This customer will reappear when the reminder is due."}
                  </p>
                </div>
              )}
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Opening WhatsApp does not mark a message as sent. Choose the actual result only after contacting the customer.
              </p>
              <div data-testid="sales-result-actions"
                className="sticky bottom-0 z-10 -mx-5 mt-5 flex gap-2 border-t border-[var(--color-border)] bg-white px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                <button type="button" disabled={saving} onClick={() => setSelected(null)}
                  className="min-h-11 flex-1 rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm">Cancel</button>
                <button type="submit" disabled={saving || !outcome}
                  className="min-h-11 flex-1 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {saving ? "Saving..." : "Save result"}
                </button>
              </div>
            </form>
          </div>
        )}
        {undoConfirm && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
            <div role="dialog" aria-modal="true" aria-labelledby="sales-follow-up-undo-title"
              className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
              <h2 id="sales-follow-up-undo-title" className="text-lg font-bold">Correct this result?</h2>
              <p className="mt-2 text-sm">
                Undo the result for <strong>{undoConfirm.customerName}</strong>?
                This restores the prior status only if nothing else has changed.
              </p>
              {undoConfirm.outcome === "booked" && (
                <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                  If other staff acted on the booking, verify the appointment directly with the clinic.
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" disabled={saving} onClick={() => setUndoConfirm(null)}
                  className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm">Keep Result</button>
                <button type="button" disabled={saving} onClick={undoResult}
                  className="min-h-11 rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                  {saving ? "Correcting..." : "Undo Result"}
                </button>
              </div>
            </div>
          </div>
        )}
        <ToastContainer toasts={toasts} onDismiss={dismissToast}/>
      </div>
    </div>
  );
}
