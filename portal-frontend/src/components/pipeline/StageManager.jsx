import { useEffect, useState } from "react";
import Spinner from "../Spinner";

const inputClass =
  "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15";

export default function StageManager({ stages, onClose, onSaveStage, onCreateStage, onDeleteStage, onReorder, onToast }) {
  const [drafts, setDrafts] = useState(stages.map(toDraft));
  const [newStage, setNewStage] = useState({ name: "", color: "#2f6f62", stageType: "open" });
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setDrafts(stages.map(toDraft));
  }, [stages]);

  function updateDraft(id, key, value) {
    setDrafts((current) => current.map((stage) => stage.id === id ? { ...stage, [key]: value } : stage));
  }

  function move(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= drafts.length) return;
    setDrafts((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      for (const draft of drafts) {
        const original = stages.find((stage) => Number(stage.id) === Number(draft.id));
        if (
          original.name !== draft.name.trim() ||
          original.color !== draft.color ||
          original.stage_type !== draft.stageType
        ) {
          await onSaveStage(draft.id, {
            name: draft.name.trim(),
            color: draft.color,
            stageType: draft.stageType,
          });
        }
      }
      await onReorder(drafts.map((stage) => stage.id));
      onToast("Pipeline stages updated.", "info");
      onClose();
    } catch (err) {
      onToast(err.message || "Couldn't update the stages.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!newStage.name.trim()) return;
    setCreating(true);
    try {
      await onCreateStage({ ...newStage, name: newStage.name.trim() });
      setNewStage({ name: "", color: "#2f6f62", stageType: "open" });
      onToast("Stage added.", "info");
    } catch (err) {
      onToast(err.message || "Couldn't add the stage.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(stage) {
    if (stage.systemKey) {
      onToast("Built-in stages can be renamed and reordered, but cannot be deleted.", "warning");
      return;
    }
    if (stage.leadCount > 0) {
      onToast("Move the leads out of this stage before deleting it.", "warning");
      return;
    }
    try {
      await onDeleteStage(stage.id);
      onToast("Stage deleted.", "info");
    } catch (err) {
      onToast(err.message || "Couldn't delete the stage.", "error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-[var(--color-surface)] shadow-2xl" role="dialog" aria-modal="true" aria-label="Manage pipeline stages" onMouseDown={(event) => event.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5">
          <div>
            <h2 className="font-display text-xl font-bold">Manage stages</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Rename, colour and reorder the columns your team works with.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]" aria-label="Close">✕</button>
        </header>

        <div className="p-6">
          <div className="space-y-2">
            {drafts.map((stage, index) => (
              <div key={stage.id} className="grid items-center gap-2 rounded-2xl border border-[var(--color-border)] p-3 sm:grid-cols-[auto_1fr_9rem_auto_auto]">
                <input type="color" value={stage.color} onChange={(event) => updateDraft(stage.id, "color", event.target.value)} className="h-10 w-10 cursor-pointer rounded-lg border-0 bg-transparent p-0" aria-label={`Colour for ${stage.name}`} />
                <div className="min-w-0">
                  <input className={`${inputClass} w-full`} value={stage.name} onChange={(event) => updateDraft(stage.id, "name", event.target.value)} />
                  <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    {stage.leadCount} lead{stage.leadCount === 1 ? "" : "s"}{stage.systemKey ? " · Built-in workflow" : ""}
                  </p>
                </div>
                <select className={inputClass} value={stage.stageType} disabled={!!stage.systemKey} title={stage.systemKey ? "Built-in workflow type" : undefined} onChange={(event) => updateDraft(stage.id, "stageType", event.target.value)}>
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
                <div className="flex gap-1">
                  <MoveButton label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</MoveButton>
                  <MoveButton label="Move down" disabled={index === drafts.length - 1} onClick={() => move(index, 1)}>↓</MoveButton>
                </div>
                <button type="button" onClick={() => handleDelete(stage)} disabled={!!stage.systemKey} title={stage.systemKey ? "Built-in stages are required for workflow automation" : undefined} className="rounded-lg px-2 py-2 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)] disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)] disabled:hover:bg-transparent">Delete</button>
              </div>
            ))}
          </div>

          <form onSubmit={handleCreate} className="mt-6 rounded-2xl bg-[var(--color-bg)] p-4">
            <h3 className="text-sm font-bold">Add a new stage</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_9rem_auto]">
              <input type="color" value={newStage.color} onChange={(event) => setNewStage((current) => ({ ...current, color: event.target.value }))} className="h-10 w-10 cursor-pointer rounded-lg border-0 bg-transparent p-0" aria-label="New stage colour" />
              <input className={`${inputClass} w-full`} value={newStage.name} onChange={(event) => setNewStage((current) => ({ ...current, name: event.target.value }))} placeholder="Stage name" />
              <select className={inputClass} value={newStage.stageType} onChange={(event) => setNewStage((current) => ({ ...current, stageType: event.target.value }))}>
                <option value="open">Open</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </select>
              <button type="submit" disabled={creating || !newStage.name.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                {creating && <Spinner className="h-4 w-4" />}
                Add stage
              </button>
            </div>
          </form>

          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]">Cancel</button>
            <button type="button" onClick={handleSave} disabled={saving || drafts.some((stage) => !stage.name.trim())} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
              {saving && <Spinner className="h-4 w-4" />}
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function toDraft(stage) {
  return {
    id: Number(stage.id),
    name: stage.name,
    color: stage.color,
    stageType: stage.stage_type,
    leadCount: Number(stage.lead_count || 0),
    systemKey: stage.system_key,
  };
}

function MoveButton({ children, label, disabled, onClick }) {
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="h-9 w-9 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg)] disabled:opacity-30">{children}</button>;
}
