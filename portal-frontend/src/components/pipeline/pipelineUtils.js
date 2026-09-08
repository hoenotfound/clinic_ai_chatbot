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

export function isSocialContact(contact) {
  return contact?.channel === "facebook" || contact?.channel === "instagram";
}

export function channelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

export function formatPhone(number) {
  if (!number) return "";
  const text = String(number).trim();
  if (!text) return "";
  return text.startsWith("+") ? text : `+${text}`;
}

export function contactIdentifier(contact) {
  if (isSocialContact(contact)) return channelLabel(contact.channel);
  return formatPhone(contact?.whatsapp_number || contact?.whatsappNumber);
}

export function displayName(contact) {
  return (
    contact?.name ||
    contact?.whatsapp_profile_name ||
    contact?.whatsappProfileName ||
    (contact?.channel === "facebook" ? "Facebook user" : null) ||
    (contact?.channel === "instagram" ? "Instagram user" : null) ||
    formatPhone(contact?.whatsapp_number || contact?.whatsappNumber) ||
    "Contact"
  );
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

function hasQualificationValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function latestQualificationMetadata(activities = [], fields = []) {
  const activityFields = (fields || []).filter(
    (field) => field?.source === "activity" && field.path
  );
  const snapshotKeys = new Set(
    activityFields.filter((field) => field.snapshot === true).map((field) => field.path)
  );
  const rollingKeys = new Set(
    activityFields.filter((field) => field.snapshot !== true).map((field) => field.path)
  );
  const latest = {};
  if (snapshotKeys.size === 0 && rollingKeys.size === 0) return latest;

  let snapshotCaptured = false;
  for (const activity of activities || []) {
    const metadata = activity?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    // Current conversion-ready persistence keeps this historical outcome key
    // for compatibility. Restrict qualification reads to those activities so
    // unrelated notes/scoring metadata cannot accidentally populate project UI.
    if (metadata.outcome !== "booking_ready") continue;

    // Snapshot-scoped values such as requested next step and its timing must
    // come from the same newest conversion-ready activity. Never fill a missing
    // value from an older conversion snapshot or the UI can display a state
    // that never actually existed (for example, quotation discussion with an
    // old site-visit time).
    if (!snapshotCaptured) {
      snapshotCaptured = true;
      for (const key of snapshotKeys) {
        if (hasQualificationValue(metadata[key])) latest[key] = metadata[key];
      }
    }

    // Stable project context can still fall back to the newest known non-empty
    // value because later conversion snapshots may only update the requested
    // next step while leaving location/summary unchanged.
    for (const key of rollingKeys) {
      if (!Object.hasOwn(latest, key) && hasQualificationValue(metadata[key])) {
        latest[key] = metadata[key];
      }
    }

    if (
      snapshotCaptured &&
      [...rollingKeys].every((key) => Object.hasOwn(latest, key))
    ) {
      break;
    }
  }
  return latest;
}

export function formatQualificationValue(value, format = "text") {
  if (!hasQualificationValue(value)) return "";
  if (format === "money") return formatMoney(value);
  if (format === "dateTime") return formatDateTime(value);
  if (format === "nextStep") {
    const text = String(value).trim().replace(/[_-]+/g, " ");
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
  }
  if (format === "title") {
    const text = String(value).trim();
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
  }
  return String(value).trim();
}

export function buildQualificationRows(qualificationView, lead = {}, activities = []) {
  const fields = qualificationView?.fields || [];
  const activityMetadata = latestQualificationMetadata(activities, fields);
  return fields.map((field) => {
    const rawValue = field.source === "activity"
      ? activityMetadata[field.path]
      : lead?.[field.path];
    const value = formatQualificationValue(rawValue, field.format);
    return {
      key: field.key || field.path,
      label: field.label || field.key || field.path,
      value,
      hasValue: Boolean(value),
    };
  });
}

export function formatRelative(value, now = Date.now()) {
  if (!value) return "No messages";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now - date.getTime()) / 1000);
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

export function buildLeadUpdatePayload(
  form,
  { includeTemperature = false, dirtyFields = null } = {}
) {
  const payload = {
    stageId: Number(form.stageId),
    temperature: form.temperature,
    temperatureLocked: form.temperatureLocked,
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

  if (dirtyFields != null) {
    const selected = dirtyFields instanceof Set
      ? dirtyFields
      : new Set(dirtyFields);
    return Object.fromEntries(
      Object.entries(payload).filter(([key]) => selected.has(key))
    );
  }

  if (!includeTemperature) {
    delete payload.temperature;
    delete payload.temperatureLocked;
  }
  return payload;
}

export function isNoReply(lead, noReplyHours = 24, now = Date.now()) {
  if (
    !lead ||
    lead.is_closed ||
    lead.last_message_role !== "assistant" ||
    !lead.last_message_at
  ) {
    return false;
  }
  if (
    lead.last_message_delivery_status != null &&
    !["pending", "sent", "delivered", "read"].includes(
      lead.last_message_delivery_status
    )
  ) {
    return false;
  }
  const sentAt = new Date(lead.last_message_at).getTime();
  const hours = Number(noReplyHours);
  return (
    Number.isFinite(sentAt) &&
    Number.isFinite(hours) &&
    hours > 0 &&
    sentAt <= now - hours * 60 * 60 * 1000
  );
}

export function isOverdue(lead, now = Date.now()) {
  return !!lead.next_follow_up_at && !lead.is_closed && new Date(lead.next_follow_up_at).getTime() < now;
}

export function toStageDraft(stage) {
  return {
    id: Number(stage.id),
    name: stage.name,
    color: stage.color,
    stageType: stage.stage_type,
    leadCount: Number(stage.lead_count || 0),
    systemKey: stage.system_key,
  };
}

export function mergeStageDrafts(
  stages,
  currentDrafts = [],
  dirtyFieldsById = {},
  orderDirty = false
) {
  const currentById = new Map(
    currentDrafts.map((draft) => [Number(draft.id), draft])
  );
  const mergedById = new Map(
    stages.map((stage) => {
      const serverDraft = toStageDraft(stage);
      const localDraft = currentById.get(serverDraft.id);
      const dirtyFields = dirtyFieldsById[serverDraft.id] || [];
      if (!localDraft || dirtyFields.length === 0) {
        return [serverDraft.id, serverDraft];
      }
      const merged = { ...serverDraft };
      for (const field of dirtyFields) merged[field] = localDraft[field];
      return [serverDraft.id, merged];
    })
  );

  if (!orderDirty) return [...mergedById.values()];

  const ordered = [];
  for (const draft of currentDrafts) {
    const merged = mergedById.get(Number(draft.id));
    if (merged) {
      ordered.push(merged);
      mergedById.delete(Number(draft.id));
    }
  }
  return [...ordered, ...mergedById.values()];
}

export function temperatureStyle(temperature) {
  if (temperature === "hot") return "bg-[var(--color-danger-light)] text-[var(--color-danger)]";
  if (temperature === "cold") return "bg-slate-100 text-slate-600";
  return "bg-[var(--color-accent-light)] text-[#8a641f]";
}
