export const TEMPERATURE_OPTIONS = [
  ["hot", "Hot"],
  ["warm", "Warm"],
  ["cold", "Cold"],
];

export const APPOINTMENT_OPTIONS = [
  ["none", "No appointment"],
  ["set", "Appointment set"],
  ["reschedule", "Needs reschedule"],
  ["cancelled", "Cancelled"],
  ["visited", "Visited clinic"],
];

export const CONSENT_OPTIONS = [
  ["unknown", "Unknown"],
  ["opted_in", "Opted in"],
  ["opted_out", "Opted out"],
];

export function displayName(lead) {
  return lead.name || lead.whatsapp_profile_name || `+${lead.whatsapp_number}`;
}

export function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDateTime(value, options = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  });
}

export function formatRelative(value) {
  if (!value) return "No messages";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function toDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export function inputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildLeadUpdatePayload(form, { includeTemperature = false } = {}) {
  const payload = {
    stageId: Number(form.stageId),
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
  };

  if (includeTemperature) {
    payload.temperature = form.temperature;
    payload.temperatureLocked = form.temperatureLocked;
  }
  return payload;
}

export function isOverdue(lead) {
  return !!lead.next_follow_up_at && !lead.is_closed && new Date(lead.next_follow_up_at).getTime() < Date.now();
}

export function temperatureStyle(temperature) {
  if (temperature === "hot") return "bg-[var(--color-danger-light)] text-[var(--color-danger)]";
  if (temperature === "cold") return "bg-slate-100 text-slate-600";
  return "bg-[var(--color-accent-light)] text-[#8a641f]";
}
