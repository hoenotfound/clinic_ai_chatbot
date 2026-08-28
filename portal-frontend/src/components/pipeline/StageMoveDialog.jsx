import { useState } from "react";
import Spinner from "../Spinner";
import { displayName } from "./pipelineUtils";

export default function StageMoveDialog({ lead, stage, onCancel, onConfirm }) {
  const [lostReason, setLostReason] = useState(lead.lost_reason || "");
  const [estimatedValue, setEstimatedValue] = useState(lead.estimated_value ?? "");
  const [saving, setSaving] = useState(false);
  const isLost = stage.stage_type === "lost";
  const isWon = stage.stage_type === "won";

  async function handleConfirm() {
    if (isLost && !lostReason.trim()) return;
    setSaving(true);
    try {
      await onConfirm({
        stageId: Number(stage.id),
        ...(isLost ? { lostReason: lostReason.trim() } : {}),
        ...(isWon ? { estimatedValue: estimatedValue === "" ? null : Number(estimatedValue) } : {}),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onCancel}>
      <div className="w-full max-w-md rounded-3xl bg-[var(--color-surface)] p-6 shadow-2xl" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: stage.color }} />
          <div>
            <h2 className="font-display text-lg font-bold">Move to {stage.name}</h2>
            <p className="text-sm text-[var(--color-text-muted)]">{displayName(lead)}</p>
          </div>
        </div>

        {isLost && (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Why was this lead lost?</span>
            <input autoFocus value={lostReason} onChange={(event) => setLostReason(event.target.value)} className="w-full rounded-xl border border-[var(--color-border)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20" placeholder="No budget, unreachable, chose another clinic…" />
          </label>
        )}

        {isWon && (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Final value (RM)</span>
            <input autoFocus type="number" min="0" step="0.01" value={estimatedValue} onChange={(event) => setEstimatedValue(event.target.value)} className="w-full rounded-xl border border-[var(--color-border)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20" placeholder="Optional" />
          </label>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">Cancel</button>
          <button type="button" onClick={handleConfirm} disabled={saving || (isLost && !lostReason.trim())} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
            {saving && <Spinner className="h-4 w-4" />}
            Confirm move
          </button>
        </div>
      </div>
    </div>
  );
}
