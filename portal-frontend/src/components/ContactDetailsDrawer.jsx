import { useEffect } from "react";
import ContactAvatar from "./ContactAvatar";
import ContactInsights from "./ContactInsights";

function formatPhone(number) {
  return number ? `+${number}` : "";
}

function displayName(contact) {
  return (
    contact?.name ||
    contact?.whatsapp_profile_name ||
    contact?.whatsappProfileName ||
    formatPhone(contact?.whatsapp_number || contact?.whatsappNumber) ||
    "Contact"
  );
}

export default function ContactDetailsDrawer({ open, contact, onClose }) {
  const contactId = contact?.contact_id || contact?.id;

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open || !contact || !contactId) return null;

  const number = contact.whatsapp_number || contact.whatsappNumber;
  const photo = contact.photo_url || contact.photoUrl;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end" role="dialog" aria-modal="true" aria-label={`Details for ${displayName(contact)}`}>
      <button
        type="button"
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label="Close contact details"
      />
      <aside className="relative flex h-full w-full max-w-[29rem] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-[-18px_0_50px_rgba(24,39,33,0.18)]">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <ContactAvatar src={photo} channel={contact.channel} size={46} />
            <div className="min-w-0">
              <h2 className="truncate font-display text-base font-bold">{displayName(contact)}</h2>
              <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{formatPhone(number)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close contact details"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-white text-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <ContactInsights contactId={contactId} />
        </div>
      </aside>
    </div>
  );
}
