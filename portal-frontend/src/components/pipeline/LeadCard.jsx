import { useAuth } from "../../context/AuthContext";
import ContactAvatar from "../ContactAvatar";
import {
  displayName,
  formatDateTime,
  formatMoney,
  formatRelative,
  isNoReply,
  isOverdue,
  temperatureStyle,
} from "./pipelineUtils";

export default function LeadCard({ lead, now, noReplyHours, onOpen, onDragStart }) {
  const { permissions } = useAuth();
  const overdue = isOverdue(lead, now);
  const noReply = isNoReply(lead, noReplyHours, now);
  const canMoveLead = permissions.manage_assigned_leads === true && typeof onDragStart === "function";

  return (
    <button
      type="button"
      draggable={canMoveLead}
      onDragStart={canMoveLead ? (event) => onDragStart(event, lead) : undefined}
      onClick={() => onOpen(lead.id)}
      className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--color-primary)]/40 hover:shadow-md active:translate-y-0"
    >
      <div className="flex items-start gap-3">
        <ContactAvatar src={lead.photo_url} channel={lead.channel} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-semibold">{displayName(lead)}</p>
            {lead.estimated_value != null && (
              <span className="shrink-0 text-[11px] font-semibold text-[var(--color-primary)]">
                {formatMoney(lead.estimated_value)}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
            {lead.treatment_interest || "Treatment not selected"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge className={temperatureStyle(lead.temperature)}>{capitalize(lead.temperature)}</Badge>
        <Badge className="bg-[var(--color-primary-light)] text-[var(--color-primary)]">
          {lead.branch_name || "Unassigned"}
        </Badge>
        {noReply && <Badge className="bg-slate-100 text-slate-600">No reply</Badge>}
        {lead.appointment_status === "reschedule" && (
          <Badge className="bg-[var(--color-accent-light)] text-[#8a641f]">Reschedule</Badge>
        )}
        {lead.appointment_status === "cancelled" && (
          <Badge className="bg-[var(--color-danger-light)] text-[var(--color-danger)]">Cancelled</Badge>
        )}
        {lead.needs_attention && (
          <Badge className="bg-[var(--color-danger-light)] text-[var(--color-danger)]">Attention</Badge>
        )}
      </div>

      {(lead.appointment_at || lead.next_follow_up_at) && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2.5 text-[11px]">
          {lead.appointment_at && (
            <MetaRow icon="calendar" label={formatDateTime(lead.appointment_at)} />
          )}
          {lead.next_follow_up_at && (
            <MetaRow
              icon="clock"
              label={`${overdue ? "Overdue" : "Follow up"} · ${formatDateTime(lead.next_follow_up_at)}`}
              danger={overdue}
            />
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="truncate">{lead.owner_username ? `Owner: ${lead.owner_username}` : "No owner"}</span>
        <span className="shrink-0">{formatRelative(lead.last_message_at, now)}</span>
      </div>
    </button>
  );
}

function Badge({ children, className }) {
  return <span className={`rounded-full px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${className}`}>{children}</span>;
}

function MetaRow({ icon, label, danger }) {
  return (
    <div className={`flex items-center gap-1.5 ${danger ? "font-medium text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
      {icon === "calendar" ? <CalendarIcon /> : <ClockIcon />}
      <span className="truncate">{label}</span>
    </div>
  );
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function CalendarIcon() {
  return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>;
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
}
