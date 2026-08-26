import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useToasts, ToastContainer } from "../components/Toast";
import Spinner from "../components/Spinner";
import ContactAvatar from "../components/ContactAvatar";

const SEARCH_DEBOUNCE_MS = 300;

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-[var(--color-surface)]";
const labelClass = "block text-xs font-medium text-[var(--color-text-muted)] mb-1.5";

export default function Contacts() {
  const { toasts, showToast, dismissToast } = useToasts();

  const [contacts, setContacts] = useState(null); // null = loading
  const [searchInput, setSearchInput] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  // "view" shows the selected contact's profile; "create" shows a blank
  // add-contact form; "edit" shows the selected contact's form pre-filled.
  const [panelMode, setPanelMode] = useState("view");

  async function refreshContacts(search) {
    try {
      const data = await api.listContacts(search);
      setContacts(data);
    } catch (err) {
      console.error("Failed to load contacts:", err);
      showToast("Couldn't load contacts — please try again.", "error");
    }
  }

  // Initial load.
  useEffect(() => {
    refreshContacts("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search-as-you-type.
  useEffect(() => {
    const timer = setTimeout(() => refreshContacts(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function handleSelect(id) {
    setSelectedId(id);
    setPanelMode("view");
  }

  function handleAddNew() {
    setSelectedId(null);
    setPanelMode("create");
  }

  async function handleSaved(savedContact, isNew) {
    await refreshContacts(searchInput);
    setSelectedId(savedContact.id);
    setPanelMode("view");
    showToast(isNew ? "Contact added." : "Contact updated.", "info");
  }

  const selectedContact = contacts?.find((c) => c.id === selectedId) || null;

  return (
    <div className="flex h-full">
      <ContactList
        contacts={contacts}
        selectedId={selectedId}
        onSelect={handleSelect}
        onAddNew={handleAddNew}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
      />
      <div className="flex-1 min-w-0 overflow-y-auto">
        {panelMode === "create" && (
          <div className="max-w-lg px-8 py-8">
            <ContactForm onSaved={(c) => handleSaved(c, true)} onCancel={() => setPanelMode("view")} onError={(m) => showToast(m, "error")} />
          </div>
        )}
        {panelMode === "edit" && selectedContact && (
          <div className="max-w-lg px-8 py-8">
            <ContactForm
              contact={selectedContact}
              onSaved={(c) => handleSaved(c, false)}
              onCancel={() => setPanelMode("view")}
              onError={(m) => showToast(m, "error")}
            />
          </div>
        )}
        {panelMode === "view" &&
          (selectedContact ? (
            <ContactProfile
              key={selectedContact.id}
              contact={selectedContact}
              onEdit={() => setPanelMode("edit")}
              onToast={showToast}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-[var(--color-text-muted)]">
                {contacts?.length === 0 ? "No contacts yet — add one to get started." : "Select a contact to view their profile."}
              </p>
            </div>
          ))}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ContactList({ contacts, selectedId, onSelect, onAddNew, searchInput, onSearchChange }) {
  return (
    <div className="w-80 shrink-0 border-r border-[var(--color-border)] h-full overflow-y-auto bg-[var(--color-surface)] flex flex-col">
      <div className="px-5 py-4 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-surface)] z-10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-lg font-bold">Contacts</h1>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {contacts ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : "Loading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onAddNew}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            + Add
          </button>
        </div>
        <input
          className={`${inputClass} mt-3 text-xs`}
          placeholder="Search by name or number…"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {contacts && contacts.length === 0 && (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            {searchInput ? "No contacts match that search." : "No contacts yet."}
          </p>
        </div>
      )}

      {contacts?.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={`relative w-full text-left px-5 py-3.5 border-b border-[var(--color-border)] transition-colors ${
            c.id === selectedId
              ? "bg-[var(--color-primary-light)]"
              : c.needs_attention
              ? "bg-[var(--color-danger-light)] hover:brightness-95"
              : "hover:bg-[var(--color-bg)]"
          }`}
        >
          <div className="flex items-center gap-3">
            <ContactAvatar src={c.photo_url} channel={c.channel} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate flex items-center gap-1.5">
                  {displayName(c)}
                  {c.mode === "human" && <ModeBadge mode="human" />}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{formatTime(c.last_message_at)}</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                {formatPhone(c.whatsapp_number)}
                {c.message_count === 0 && " · No conversation yet"}
              </p>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ContactProfile({ contact, onEdit, onToast }) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState(null); // null = loading
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    api
      .listContactNotes(contact.id)
      .then((data) => {
        if (!cancelled) setNotes(data);
      })
      .catch((err) => {
        console.error("Failed to load notes:", err);
        if (!cancelled) onToast("Couldn't load notes for this contact.", "error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id]);

  async function handleAddNote() {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const note = await api.addContactNote(contact.id, content);
      setNotes((prev) => [note, ...(prev || [])]);
      setDraft("");
    } catch (err) {
      console.error("Failed to add note:", err);
      onToast(err.message || "Couldn't save that note.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteNote(noteId) {
    const previous = notes;
    setNotes((prev) => prev.filter((n) => n.id !== noteId)); // optimistic
    try {
      await api.deleteContactNote(contact.id, noteId);
    } catch (err) {
      console.error("Failed to delete note:", err);
      setNotes(previous); // revert
      onToast("Couldn't delete that note.", "error");
    }
  }

  return (
    <div className="max-w-2xl px-8 py-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <ContactAvatar src={contact.photo_url} channel={contact.channel} size={48} />
          <div className="min-w-0">
            <h2 className="font-display text-xl font-bold flex items-center gap-2">
              <span className="truncate">{displayName(contact)}</span>
              {contact.mode === "human" && <ModeBadge mode="human" />}
            </h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">{formatPhone(contact.whatsapp_number)}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Added {new Date(contact.created_at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors"
          >
            Edit
          </button>
          {contact.message_count > 0 ? (
            <button
              type="button"
              onClick={() => navigate(`/inbox?contact=${contact.id}`)}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              View conversation
            </button>
          ) : (
            <span
              className="text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-bg)] text-[var(--color-text-muted)] cursor-not-allowed"
              title="This contact hasn't messaged in yet."
            >
              No conversation yet
            </span>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-3">Notes</h3>
        <div className="mb-4">
          <textarea
            className={`${inputClass} resize-y`}
            rows={2}
            placeholder="Add a note about this patient — visible to staff only, never sent or shown to the AI."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-2">
            <button
              type="button"
              onClick={handleAddNote}
              disabled={saving || !draft.trim()}
              className="inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {saving && <Spinner className="h-3 w-3" />}
              {saving ? "Saving…" : "Add note"}
            </button>
          </div>
        </div>

        {notes === null ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5 text-[var(--color-text-muted)]" />
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No notes yet.</p>
        ) : (
          <div className="space-y-3">
            {notes.map((n) => (
              <div key={n.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm whitespace-pre-wrap flex-1">{n.content}</p>
                  <button
                    type="button"
                    onClick={() => handleDeleteNote(n.id)}
                    aria-label="Delete note"
                    className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors text-xs"
                  >
                    ✕
                  </button>
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-2">
                  {n.author} · {formatTime(n.created_at)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Shared form for both "Add contact" and "Edit contact" — the only
// difference is whether `contact` (the existing row) is passed in.
function ContactForm({ contact, onSaved, onCancel, onError }) {
  const isNew = !contact;
  const [name, setName] = useState(contact?.name || "");
  const [whatsappNumber, setWhatsappNumber] = useState(contact?.whatsapp_number || "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!whatsappNumber.trim()) {
      onError("A WhatsApp number is required.");
      return;
    }
    setSaving(true);
    try {
      const saved = isNew
        ? await api.createContact({ name: name.trim(), whatsappNumber: whatsappNumber.trim() })
        : await api.updateContact(contact.id, { name: name.trim(), whatsappNumber: whatsappNumber.trim() });
      onSaved(saved);
    } catch (err) {
      onError(err.message || "Couldn't save this contact.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="font-display text-lg font-bold mb-1">{isNew ? "Add contact" : "Edit contact"}</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        {isNew
          ? "Manually add a patient who hasn't messaged in yet. If they message this WhatsApp number later, it'll link to this same contact."
          : "Update this patient's name or WhatsApp number."}
      </p>

      <div className="mb-4">
        <label className={labelClass}>Name</label>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
      </div>

      <div className="mb-6">
        <label className={labelClass}>WhatsApp number</label>
        <input
          className={inputClass}
          value={whatsappNumber}
          onChange={(e) => setWhatsappNumber(e.target.value)}
          placeholder="e.g. +60 12-345 6789"
        />
        <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
          Any format works — it's normalized to match how WhatsApp identifies the patient.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
        >
          {saving && <Spinner />}
          {saving ? "Saving…" : isNew ? "Add contact" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ModeBadge({ mode }) {
  const isHuman = mode === "human";
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 rounded-full font-medium uppercase tracking-wide text-[9px] px-1.5 py-0.5 ${
        isHuman ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      }`}
    >
      {isHuman ? "Staff" : "AI"}
    </span>
  );
}

function formatPhone(number) {
  return `+${number}`;
}

function displayName(contact) {
  return contact.name || contact.whatsapp_profile_name || formatPhone(contact.whatsapp_number);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
