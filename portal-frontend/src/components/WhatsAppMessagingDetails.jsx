import { useEffect, useState } from "react";
import { whatsappPolicyStatus } from "../utils/whatsappPolicy";

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(value) {
  if (!value) return "Not recorded";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function policyField(contact, snakeCase, camelCase) {
  return contact?.[snakeCase] || contact?.[camelCase] || null;
}

function PolicyDetail({ label, value, className = "" }) {
  return (
    <div className={`min-w-0 rounded-xl bg-[var(--color-bg)]/70 px-2.5 py-2.5 sm:px-3 ${className}`}>
      <dt className="text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-1 break-words text-[11px] leading-4 text-[var(--color-text)] sm:text-xs sm:leading-5">{value}</dd>
    </div>
  );
}

export default function WhatsAppMessagingDetails({ contact, className = "" }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if ((contact?.channel || "whatsapp") !== "whatsapp") return null;

  const policy = whatsappPolicyStatus(contact, now);
  const optInAt = policyField(contact, "whatsapp_opt_in_at", "whatsappOptInAt");
  const optInSource = policyField(contact, "whatsapp_opt_in_source", "whatsappOptInSource");
  const optOutAt = policyField(contact, "whatsapp_opt_out_at", "whatsappOptOutAt");
  const optOutSource = policyField(contact, "whatsapp_opt_out_source", "whatsappOptOutSource");
  const statusTone = policy.freeformAllowed
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4 ${className}`}>
      <div className="flex flex-col items-start gap-2 min-[400px]:flex-row min-[400px]:justify-between min-[400px]:gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold">WhatsApp messaging</h3>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            Reply-window status and WhatsApp-specific consent records
          </p>
        </div>
        <span className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusTone}`}>
          {policy.freeformAllowed ? "Reply available" : "Sending restricted"}
        </span>
      </div>

      <div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-5 ${statusTone}`}>
        <p className="text-[9px] font-semibold uppercase tracking-[0.08em] opacity-70">Current reply window</p>
        <p className="font-semibold">{policy.label}</p>
        <p className="mt-0.5 break-words text-[11px] opacity-80">{policy.explanation}</p>
      </div>

      {optOutAt && (
        <p className="mt-3 break-words rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-5 text-amber-900">
          Customer opted out of WhatsApp messages on {formatDateTime(optOutAt)}.
          {policy.customerReinitiatedAfterOptOut
            ? " You may reply to their current request while the reply window is open, but automated follow-ups remain blocked."
            : " Normal replies and automated follow-ups are currently blocked."}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <PolicyDetail label="Latest customer message" value={formatDateTime(policy.latestCustomerMessageAt) || "No customer message"} />
        <PolicyDetail label="Reply window expires" value={formatDateTime(policy.replyWindowExpiresAt) || "Not available"} />
        <PolicyDetail label="WhatsApp opt-in" value={optInAt ? "Recorded" : "Not recorded"} />
        <PolicyDetail label="WhatsApp opt-out" value={optOutAt ? "Recorded" : "Not recorded"} />
        <PolicyDetail className="col-span-2" label="Opt-in date / source" value={optInAt ? `${formatDateTime(optInAt)} · ${sourceLabel(optInSource)}` : "Not recorded"} />
        <PolicyDetail className="col-span-2" label="Opt-out date / source" value={optOutAt ? `${formatDateTime(optOutAt)} · ${sourceLabel(optOutSource)}` : "Not recorded"} />
      </dl>
    </section>
  );
}
