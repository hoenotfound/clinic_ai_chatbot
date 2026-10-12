import { useEffect, useState } from "react";
import { api } from "../../api";
import Spinner from "../Spinner";

const STATUS_LABELS = {
  not_verified: "Not verified",
  eligible: "Assessment attended",
  issued: "Voucher issued",
  redeemed: "Redeemed",
  voided: "Voided",
};

export default function AssessmentVoucherPanel({ lead, canManage, onToast, onChanged }) {
  const [voucher, setVoucher] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [termsConfirmed, setTermsConfirmed] = useState(false);
  const [redemptionNote, setRedemptionNote] = useState("");
  const [termsNote, setTermsNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setVoucher(null);
    setTermsConfirmed(false);
    setRedemptionNote("");
    setTermsNote("");
    setExpiresAt("");
    api.getAssessmentVoucher(lead.id)
      .then((record) => { if (active) setVoucher(record); })
      .catch((error) => { if (active) onToast(error.message || "Couldn't load voucher status.", "error"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [lead.id, onToast]);

  const status = voucher?.status || "not_verified";
  const pelvicInterest = /^(?:骨盆(?:调理|調理|矫正|矯正|调整|調整)|骨盤(?:調理|调理)|骨盘(?:调理|調理)|pelvic\s+(?:care|adjustment|treatment))$/iu
    .test(String(lead.treatment_interest || "").trim());
  const attendanceMarked = lead.appointment_status === "visited";
  const eligibilityCurrent = pelvicInterest && attendanceMarked;

  async function changeStatus(next) {
    if (!canManage || saving) return;
    setSaving(true);
    try {
      const changed = await api.updateAssessmentVoucher(lead.id, {
        status: next,
        ...(next === "issued" ? {
          termsConfirmed, termsNote: termsNote.trim(),
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        } : {}),
        ...(next === "redeemed" ? { redemptionNote: redemptionNote.trim() } : {}),
      });
      setVoucher(changed);
      setTermsConfirmed(false);
      setRedemptionNote("");
      setTermsNote("");
      setExpiresAt("");
      onToast("Voucher status saved.", "info");
      onChanged?.();
    } catch (error) {
      onToast(error.message || "Couldn't update voucher.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5" aria-label="Pelvic assessment voucher">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-bold">RM100 骨盆调理 assessment voucher</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Internal staff record. Attendance, issuance and redemption are never automatic.
          </p>
        </div>
        <span className="rounded-lg bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold">
          {loading ? "Loading…" : STATUS_LABELS[status] || status}
        </span>
      </div>
      {!loading && (
        <div className="mt-4 space-y-3">
          {status === "not_verified" && (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">
                First confirm the customer completed an assessment + experience. Set their treatment interest to 骨盆调理 and appointment status to Visited, then save the lead.
              </p>
              {canManage && (
                <button type="button" disabled={saving || !pelvicInterest || !attendanceMarked}
                  onClick={() => changeStatus("eligible")}
                  className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                  Confirm assessment attendance
                </button>
              )}
            </>
          )}
          {(status === "eligible" || status === "issued") && !eligibilityCurrent && (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              This lead no longer has both pelvic treatment interest and Visited status.
              Confirm or correct the lead details before issuing or redeeming the voucher.
            </p>
          )}
          {status === "eligible" && (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">
                Attendance verified. Before issuing, staff must independently confirm redemption conditions; no automatic stacking with existing package discounts.
              </p>
              {canManage && (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={termsConfirmed} onChange={(e) => setTermsConfirmed(e.target.checked)} className="mt-1" />
                    I have confirmed the applicable voucher terms with the clinic.
                  </label>
                  <label className="block text-xs text-[var(--color-text-muted)]">
                    Approved redemption conditions (required)
                    <textarea rows={2} maxLength={500} value={termsNote} onChange={(e) => setTermsNote(e.target.value)}
                      placeholder="E.g. One-time RM100 off pelvic treatment, not combinable with October package offer"
                      className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
                  </label>
                  <label className="block text-xs text-[var(--color-text-muted)]">
                    Expiry (optional, only if confirmed by the clinic)
                    <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
                  </label>
                  <button type="button" disabled={saving || !eligibilityCurrent || !termsConfirmed || !termsNote.trim()}
                    onClick={() => changeStatus("issued")}
                    className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                    Mark voucher issued
                  </button>
                </>
              )}
            </>
          )}
          {status === "issued" && (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">
                Approved terms: {voucher.termsNote || "Not recorded"}
                {voucher.expiresAt ? ` · Expires ${new Date(voucher.expiresAt).toLocaleString()}` : " · No confirmed expiry recorded"}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">Mark redeemed only after staff verify the actual transaction. Describe the agreed redemption conditions.</p>
              {canManage && (
                <>
                  <textarea rows={2} maxLength={500} value={redemptionNote}
                    onChange={(e) => setRedemptionNote(e.target.value)}
                    placeholder="E.g. Treatment booked; voucher applied once, no stacking confirmed"
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
                  <button type="button" disabled={saving || !eligibilityCurrent || !redemptionNote.trim()}
                    onClick={() => changeStatus("redeemed")}
                    className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                    Mark redeemed
                  </button>
                </>
              )}
            </>
          )}
          {status === "redeemed" && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Redeemed by {voucher.updatedBy}. {voucher.redemptionNote || ""}
              {voucher.termsNote ? ` · Terms: ${voucher.termsNote}` : ""}
            </p>
          )}
          {status === "voided" && <p className="text-xs text-[var(--color-text-muted)]">Voucher voided; consult the activity history for details.</p>}
          {canManage && (status === "eligible" || status === "issued") && (
            <button type="button" disabled={saving} onClick={() => changeStatus("voided")}
              className="block text-xs text-[var(--color-danger)] underline disabled:opacity-50">
              Void this voucher
            </button>
          )}
          {saving && <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Spinner className="h-3 w-3" /> Saving…</div>}
        </div>
      )}
    </section>
  );
}
