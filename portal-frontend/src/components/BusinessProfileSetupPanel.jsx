import { useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";

const LOCK_REASON_COPY = {
  customer_data_exists: "Customer data already exists on this deployment.",
  pipeline_customized: "The Pipeline has already been customized.",
  settings_configured: "Client-specific Settings have already been saved.",
  environment_selected: "The industry was selected explicitly during deployment provisioning.",
  legacy_existing_deployment: "This is an existing deployment created before one-time industry selection was introduced.",
  profile_confirmed: "The business profile has already been confirmed.",
  profile_locked: "The business profile is already locked.",
};

function formatMode(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatSelectionTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function AlignmentItem({ label, value, detail, warning = false }) {
  return (
    <div className="rounded-xl bg-[var(--color-bg)] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
        <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${warning ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
          {warning ? "Fallback" : "Aligned"}
        </span>
      </div>
      <p className="mt-1 text-sm font-bold">{value}</p>
      {detail && <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{detail}</p>}
    </div>
  );
}

export default function BusinessProfileSetupPanel({ profile }) {
  const [selected, setSelected] = useState(profile?.businessType || "aesthetic_clinic");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const options = profile?.options || [];
  const selectedOption = useMemo(
    () => options.find((option) => option.value === selected) || null,
    [options, selected]
  );
  const selection = profile?.selection || {};
  const alignment = profile?.alignment || {};

  if (!profile) return null;

  async function confirmProfile() {
    if (saving || !selection.selectable || !selectedOption) return;

    const changing = selected !== profile.businessType;
    const action = changing
      ? `switch this untouched deployment from ${profile.label} to ${selectedOption.label}`
      : `confirm ${selectedOption.label} for this deployment`;
    const accepted = window.confirm(
      `Confirm business profile?\n\nThis will ${action}. The default business configuration and default Pipeline will be aligned to that profile.\n\nAfter the profile is confirmed, or after client Settings/customer data are added, the industry cannot be changed from Setup Status.`
    );
    if (!accepted) return;

    setSaving(true);
    setError("");
    try {
      await api.selectBusinessProfile(selected);
      // The authenticated business profile is cached in AuthContext. A full
      // reload is deliberate for this one-time admin action so every route,
      // terminology resolver and permission-aware surface receives the new
      // profile together after the backend transaction commits.
      window.location.reload();
    } catch (err) {
      setError(err.message || "Couldn't save the business profile.");
      setSaving(false);
    }
  }

  const lockedReason = LOCK_REASON_COPY[selection.lockReason]
    || "The deployment is no longer eligible for industry changes.";
  const selectedAt = formatSelectionTime(selection.selectedAt);

  return (
    <section>
      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-base font-bold sm:text-lg">Business profile</h2>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${selection.selectable ? "bg-[var(--color-accent-light)] text-[var(--color-text)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
            {selection.selectable ? "Choose once" : "Locked"}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
          Controls the chatbot's terminology, conversion flow, Pipeline defaults, lead-temperature rules and Analytics semantics. Aesthetic Clinic is the default when no industry is selected during provisioning.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Current profile</p>
            <p className="mt-1 font-display text-xl font-bold">{profile.label}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              {selection.selectable
                ? "This is still the untouched default setup. Choose the client's industry before configuring Settings or receiving customer data."
                : lockedReason}
            </p>
          </div>
          {!selection.selectable && (
            <div className="rounded-xl bg-[var(--color-bg)] px-3 py-2 text-[10px] font-semibold leading-4 text-[var(--color-text-muted)]">
              <div>Source: {formatMode(selection.source)}</div>
              {selection.selectedBy && <div>Confirmed by: {selection.selectedBy}</div>}
              {selectedAt && <div>Selected: {selectedAt}</div>}
            </div>
          )}
        </div>

        {selection.selectable && (
          <div className="mt-4">
            <div className="grid gap-2.5 md:grid-cols-3">
              {options.map((option) => {
                const active = selected === option.value;
                return (
                  <label
                    key={option.value}
                    className={`cursor-pointer rounded-2xl border p-3.5 transition ${active ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/40" : "border-[var(--color-border)] bg-white hover:bg-[var(--color-bg)]"}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="business-profile"
                        value={option.value}
                        checked={active}
                        onChange={() => setSelected(option.value)}
                        disabled={saving}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-bold">{option.label}</span>
                          {option.default && (
                            <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-primary)]">Default</span>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{option.description}</p>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {error && (
              <div role="alert" className="mt-3 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-3 py-2.5 text-xs text-[var(--color-danger)]">
                {error}
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">
                Confirming replaces only untouched profile defaults. The server rechecks for customer data and Pipeline customization inside the save transaction.
              </p>
              <button
                type="button"
                onClick={confirmProfile}
                disabled={saving || !selectedOption}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-bold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-wait disabled:opacity-60"
              >
                {saving && <Spinner className="h-4 w-4" />}
                {saving
                  ? "Saving profile…"
                  : selected === profile.businessType
                    ? `Confirm ${selectedOption?.label || "profile"}`
                    : `Use ${selectedOption?.label || "profile"}`}
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <AlignmentItem
            label="Pipeline"
            value={formatMode(alignment.pipeline?.businessType)}
            detail={alignment.pipeline?.mode === "profile_default" ? "Profile default stages" : "Custom stages"}
            warning={alignment.pipeline?.mode !== "profile_default"}
          />
          <AlignmentItem
            label="Conversion"
            value={formatMode(alignment.conversion?.mode)}
            detail={alignment.conversion?.enabled ? "Conversion-ready automation enabled" : "Conversion-ready automation disabled"}
          />
          <AlignmentItem
            label="Lead rules"
            value={formatMode(alignment.leadTemperature?.mode)}
            detail={`${formatMode(alignment.leadTemperature?.businessType)} rules`}
          />
          <AlignmentItem
            label="Analytics"
            value={formatMode(alignment.analytics?.businessType)}
            detail={alignment.analytics?.fallback ? "Using safe legacy Pipeline semantics" : "Matches the active profile"}
            warning={alignment.analytics?.fallback === true}
          />
        </div>
      </div>
    </section>
  );
}
