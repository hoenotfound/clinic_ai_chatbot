export function matchesLeadAssignment(item, value, currentUsername) {
  if (value === "all") return true;
  if (value === "mine") return Boolean(currentUsername) && item?.lead_owner_username === currentUsername;
  if (value === "unassigned") return !item?.lead_owner_username;
  if (value?.startsWith("owner:")) {
    return item?.lead_owner_username === value.slice("owner:".length);
  }
  return true;
}

export function buildLeadAssignmentFilterOptions(items, currentUsername) {
  const owners = new Map();
  for (const item of items || []) {
    const username = String(item?.lead_owner_username || "").trim();
    if (!username || username === currentUsername) continue;
    const displayName = String(item?.lead_owner_display_name || username).trim() || username;
    owners.set(username, displayName);
  }

  const specificOwners = Array.from(owners.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([username, displayName]) => [`owner:${username}`, displayName]);

  return [
    ["all", "All leads"],
    ["mine", "My leads"],
    ["unassigned", "Unassigned"],
    ...specificOwners,
  ];
}

export default function LeadAssignmentBadge({
  ownerUsername,
  ownerDisplayName,
  currentUsername,
  compact = false,
}) {
  const assigned = Boolean(ownerUsername);
  const mine = assigned && ownerUsername === currentUsername;
  const name = ownerDisplayName || ownerUsername;
  const label = !assigned
    ? "Unassigned"
    : mine
      ? compact
        ? "You"
        : "Assigned to you"
      : name;

  return (
    <span
      title={
        assigned
          ? `Assigned to ${name}${ownerUsername ? ` (@${ownerUsername})` : ""}`
          : "This lead is unassigned"
      }
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full font-semibold ${
        compact ? "max-w-32 px-1.5 py-0.5 text-[9px]" : "max-w-full px-2.5 py-1 text-[10px]"
      } ${
        assigned
          ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
          : "border border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          assigned ? "bg-[var(--color-primary)]" : "bg-[var(--color-text-muted)]/50"
        }`}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
