import { useState } from "react";
import { MascotArtwork, DASHY_POSES } from "../components/InboxMascot";
import { useMascotMode } from "../hooks/useMascotMode";

const OPTIONS = [
  ["animated", "Animated", "Occasional gentle movement and brief reactions."],
  ["stationary", "Stationary", "Keep Dashy visible without movement."],
  ["hidden", "Hidden", "Remove Dashy from your Inbox."],
];
export default function Appearance() {
  const [mode, setMode] = useMascotMode();
  const [preview, setPreview] = useState("idle");
  return (
    <main className="h-full overflow-y-auto px-3.5 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8">
      <section className="max-w-3xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold">Appearance</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Personalise your workspace on this browser.</p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-4">
            <MascotArtwork mode={mode === "animated" ? "animated" : "stationary"} pose={preview} />
            <div>
              <h2 className="text-sm font-semibold">Dashy · Inbox mascot</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">A small companion that never covers your conversations.</p>
            </div>
          </div>
          <label className="mt-4 block text-xs font-semibold text-[var(--color-text-muted)]">
            Preview Dashy expression
            <select value={preview} onChange={event => setPreview(event.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]">
              {DASHY_POSES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">Preview only. This does not simulate chatbot activity or change your Inbox.</p>
          <fieldset className="mt-4 space-y-2">
            <legend className="sr-only">Inbox mascot display mode</legend>
            {OPTIONS.map(([value, label, description]) => (
              <label key={value} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2">
                <input type="radio" name="mascot-mode" value={value} checked={mode === value}
                  onChange={() => setMode(value)} className="h-4 w-4 accent-[var(--color-primary)]" />
                <span><span className="block text-sm font-semibold">{label}</span>
                  <span className="block text-xs text-[var(--color-text-muted)]">{description}</span></span>
              </label>
            ))}
          </fieldset>
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">Saved automatically on this browser. Your device's reduced-motion preference is respected.</p>
        </div>
      </section>
    </main>
  );
}
