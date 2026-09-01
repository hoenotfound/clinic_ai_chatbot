import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToasts, ToastContainer } from "../components/Toast";
import Spinner from "../components/Spinner";
import ContactAvatar from "../components/ContactAvatar";
import ContactInsights from "../components/ContactInsights";
import LeadAssignmentBadge, {
  buildLeadAssignmentFilterOptions,
  matchesLeadAssignment,
} from "../components/LeadAssignmentBadge";

const SEARCH_DEBOUNCE_MS = 300;
const CONTACT_REALTIME_DEBOUNCE_MS = 150;

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-[var(--color-surface)]";
const labelClass = "block text-xs font-medium text-[var(--color-text-muted)] mb-1.5";

export default function Contacts() {
  const { permissions, username } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();
  const canCreateContacts = permissions.create_leads === true;
  const canManageContacts = permissions.manage_assigned_leads === true;

  const [contacts, setContacts] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [assignmentFilter, setAssignmentFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [panelMode, setPanelMode] = useState("view");
  const searchInputRef = useRef(searchInput);
  searchInputRef.current = searchInput;

  async function refreshContacts(search) {
    try {
      const data = await api.listContacts(search);
      setContacts(data);
    } catch (err) {
      console.error("Failed to load contacts:", err);
      showToast("Couldn't load contacts. Please try again.", "error");
    }
  }

  useEffect(() => {
    refreshContacts("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => refreshContacts(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  useEffect(() => {
    const source = new EventSource("/api/conversations/events", { withCredentials: true });
    let debounceTimer = null;

    function scheduleRefresh() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        refreshContacts(searchInputRef.current);
      }, CONTACT_REALTIME_DEBOUNCE_MS);
    }

    source.addEventListener("conversation_changed", scheduleRefresh);
    source.onopen = scheduleRefresh;
    source.onerror = () => {
      // EventSource reconnects automatically. The next open reconciles the list.
    };

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      source.removeEventListener("conversation_changed", scheduleRefresh);
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (panelMode === "create" && !canCreateContacts) setPanelMode("view");
    if (panelMode === "edit" && !canManageContacts) setPanelMode("view");
  }, [canCreateContacts, canManageContacts, panelMode]);

  function handleSelect(id) {
    setSelectedId(id);
    setPanelMode("view");
  }

  function handleAddNew() {
    if (!canCreateContacts) return;
    setSelectedId(null);
    setPanelMode("create");
  }

  function handleBackToList() {
    setSelectedId(null);
    setPanelMode("view");
  }

  async function handleSaved(savedContact, isNew) {
    await refreshContacts(searchInput);
    setSelectedId(savedContact.id);
    setPanelMode("view");
    showToast(isNew ? "Contact added." : "Contact updated.", "info");
  }

  const selectedContact = contacts?.find((c) => c.id === selectedId) || null;
  const mobilePanelOpen = panelMode !== "view" || Boolean(selectedContact);

  return (
    <div className="flex h-full min-w-0">
      <ContactList
        contacts={contacts}
        selectedId={selectedId}
        onSelect={handleSelect}
        onAddNew={handleAddNew}
        canCreateContacts={canCreateContacts}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
        assignmentFilter={assignmentFilter}
        onAssignmentFilterChange={setAssignmentFilter}
        currentUsername={username}
        hiddenOnMobile={mobilePanelOpen}
      />
      <div className={`${mobilePanelOpen ? "block" : "hidden"} min-w-0 flex-1 overflow-y-auto md:block`}>
        {canCreateContacts && panelMode === "create" && (
          <div className="mx-auto w-full max-w-lg px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            <MobileBackButton onClick={handleBackToList} label="Back to contacts" />
            <ContactForm
              onSaved={(c) => handleSaved(c, true)}
              onCancel={handleBackToList}
              onError={(m) => showToast(m, "error")}
            />
          </div>
        )}
        {canManageContacts && panelMode === "edit" && selectedContact && (
          <div className="mx-auto w-full max-w-lg px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            <MobileBackButton onClick={() => setPanelMode("view")} label="Back to contact" />
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
              currentUsername={username}
              canManage={canManageContacts}
              canCreateLeads={canCreateContacts}
              onEdit={() => canManageContacts && setPanelMode("edit")}
              onBack={handleBackToList}
              onToast={showToast}
            />
          ) : (
            <div className="hidden h-full items-center justify-center px-6 text-center md:flex">
              <p className="text-sm text-[var(--color-text-muted)]">
                {contacts?.length === 0
                  ? canCreateContacts ? "No contacts yet. Add one to get started." : "No accessible contacts yet."
                  : "Select a contact to view their profile."}
              </p>
            </div>
          ))}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ContactList({
  contacts,
  selectedId,
  onSelect,
  onAddNew,
  canCreateContacts,
  searchInput,
  onSearchChange,
  assignmentFilter,
  onAssignmentFilterChange,
  currentUsername,
  hiddenOnMobile,
}) {
  const contactList = useMemo(() => contacts || [], [contacts]);
  const assignmentOptions = useMemo(
    () => buildLeadAssignmentFilterOptions(contactList, currentUsername),
    [contactList, currentUsername]
  );
  const filteredContacts = useMemo(
    () => contactList.filter((contact) => matchesLeadAssignment(contact, assignmentFilter, currentUsername)),
    [contactList, assignmentFilter, currentUsername]
  );
  const assignmentFilterActive = assignmentFilter !== "all";

  return (
    <div className={`${hiddenOnMobile ? "hidden md:flex" : "flex"} h-full w-full min-w-0 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] md:w-80`}>
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-display text-lg font-bold">Contacts</h1>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {contacts
                ? assignmentFilterActive
                  ? `${filteredContacts.length} shown from ${contactList.length}`
                  : `${contactList.length} contact${contactList.length === 1 ? "" : "s"}`
                : "Loading…"}
            </p>
          </div>
          {canCreateContacts && (
            <button
              type="button"
              onClick={onAddNew}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)]"
            >
              + Add
            </button>
          )}
        </div>
        <input
          className={`${inputClass} mt-3 text-xs`}
          placeholder="Search by name, number or social ID…"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <label className="relative mt-2 block">
          <span className="sr-only">Filter contacts by lead assignment</span>
          <select
            value={assignmentFilter}
            onChange={(event) => onAssignmentFilterChange(event.target.value)}
            className="w-full appearance-none rounded-lg border border-[var(--color-border)] bg-white py-2 pl-2.5 pr-8 text-[11px] font-medium text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
          >
            {assignmentOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-text-muted)]">▾</span>
        </label>
      </div>

      {contacts && contacts.length === 0 && (
        <div className="px-4 py-10 text-center sm:px-5">
          <p className="text-sm text-[var(--color-text-muted)]">
            {searchInput ? "No contacts match that search." : "No accessible contacts yet."}
          </p>
        </div>
      )}

      {contacts && contacts.length > 0 && filteredContacts.length === 0 && (
        <div className="px-4 py-10 text-center sm:px-5">
          <p className="text-sm font-medium">No contacts match this assignment</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">Choose another assignment filter to see more contacts.</p>
        </div>
      )}

      {filteredContacts.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={`relative w-full border-b border-[var(--color-border)] px-4 py-3.5 text-left transition-colors sm:px-5 ${
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
                <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                  <span className="truncate">{displayName(c)}</span>
                  {c.mode === "human" && <ModeBadge mode="human" />}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{formatTime(c.last_message_at)}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
                {contactIdentifier(c)}
                {c.message_count === 0 && " · No conversation yet"}
              </p>
              <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                <LeadAssignmentBadge
                  ownerUsername={c.lead_owner_username}
                  ownerDisplayName={c.lead_owner_display_name}
                  currentUsername={currentUsername}
                  compact
                />
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ContactProfile({ contact, currentUsername, canManage, canCreateLeads, onEdit, onBack, onToast }) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [addingLead, setAddingLead] = useState(false);

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
    if (!canManage || !content || saving) return;
    setSaving(true);
    try {
      const note = await api.addContactNote(contact.id, content);
      setNotes((prev) => [note, ...(prev || [])]);
      setDraft("");
    } catch (err) {
      console.error("Failed to save note:", err);
      onToast(err.message || "Couldn't save that note.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteNote(noteId) {
    if (!canManage) return;
    const previous = notes;
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    try {
      await api.deleteContactNote(contact.id, noteId);
    } catch (err) {
      console.error("Failed to delete note:", err);
      setNotes(previous);
      onToast("Couldn't delete that note.", "error");
    }
  }

  async function handleOpenPipeline() {
    if (addingLead) return;
    if (!canCreateLeads) {
      navigate("/pipeline");
      return;
    }
    setAddingLead(true);
    try {
      const result = await api.createLead({ contactId: contact.id });
      navigate(`/pipeline?lead=${result.lead.id}`);
    } catch (err) {
      onToast(err.message || "Couldn't add this contact to the pipeline.", "error");
    } finally {
      setAddingLead(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
      <MobileBackButton onClick={onBack} label="Back to contacts" />

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ContactAvatar src={contact.photo_url} channel={contact.channel} size={48} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="flex min-w-0 items-center gap-2 font-display text-xl font-bold">
                <span className="truncate">{displayName(contact)}</span>
                {contact.mode === "human" && <ModeBadge mode="human" />}
              </h2>
              {!canManage && <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2 py-1 text-[9px] font-bold uppercase text-[var(--color-text-muted)]">View only</span>}
            </div>
            <p className="mt-1 break-all text-sm text-[var(--color-text-muted)]">{contactIdentifier(contact)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <LeadAssignmentBadge
                ownerUsername={contact.lead_owner_username}
                ownerDisplayName={contact.lead_owner_display_name}
                currentUsername={currentUsername}
              />
              <span className="text-xs text-[var(--color-text-muted)]">
                Added {new Date(contact.created_at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {canManage && (
            <button
              type="button"
              onClick={onEdit}
              className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-bg)] sm:flex-none"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenPipeline}
            disabled={addingLead}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50 sm:flex-none"
          >
            {addingLead && <Spinner className="h-3 w-3" />}
            {addingLead ? "Opening…" : "Pipeline"}
          </button>
          {contact.message_count > 0 ? (
            <button
              type="button"
              onClick={() => navigate(`/inbox?contact=${contact.id}`)}
              className="w-full rounded-lg bg-[var(--color-primary)] px-3 py-2 text-center text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)] sm:w-auto"
            >
              View conversation
            </button>
          ) : (
            <span
              className="w-full cursor-not-allowed rounded-lg bg-[var(--color-bg)] px-3 py-2 text-center text-xs font-medium text-[var(--color-text-muted)] sm:w-auto"
              title="This contact hasn't messaged in yet."
            >
              No conversation yet
            </span>
          )}
        </div>
      </div>

      <ContactInsights contactId={contact.id} className="mb-8" />

      <div>
        <h3 className="mb-3 text-sm font-semibold">Notes</h3>
        {canManage ? (
          <div className="mb-4">
            <textarea
              className={`${inputClass} resize-y`}
              rows={2}
              placeholder="Add a note about this patient. Visible to staff only, never sent or shown to the AI."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-2">
              <button
                type="button"
                onClick={handleAddNote}
                disabled={saving || !draft.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {saving && <Spinner className="h-3 w-3" />}
                {saving ? "Saving…" : "Add note"}
              </button>
            </div>
          </div>
        ) : (
          <p className="mb-4 text-xs text-[var(--color-text-muted)]">You can view staff notes, but editing notes is disabled for this account.</p>
        )}

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
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{n.content}</p>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleDeleteNote(n.id)}
                      aria-label="Delete note"
                      className="shrink-0 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-danger)]"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
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

function MobileBackButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] md:hidden"
    >
      <span aria-hidden="true">←</span>
      {label}
    </button>
  );
}

function ContactForm({ contact, onSaved, onCancel, onError }) {
  const isNew = !contact;
  const isSocial = !isNew && isSocialContact(contact);
  const [name, setName] = useState(contact?.name || "");
  const [whatsappNumber, setWhatsappNumber] = useState(contact?.whatsapp_number || "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isSocial && !whatsappNumber.trim()) {
      onError("A WhatsApp number is required.");
      return;
    }
    setSaving(true);
    try {
      let saved;
      if (isNew) {
        saved = await api.createContact({
          name: name.trim(),
          whatsappNumber: whatsappNumber.trim(),
        });
      } else if (isSocial) {
        saved = await api.updateContact(contact.id, { name: name.trim() });
      } else {
        saved = await api.updateContact(contact.id, {
          name: name.trim(),
          whatsappNumber: whatsappNumber.trim(),
        });
      }
      onSaved(saved);
    } catch (err) {
      onError(err.message || "Couldn't save this contact.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="mb-1 font-display text-lg font-bold">{isNew ? "Add contact" : "Edit contact"}</h2>
      <p className="mb-6 text-sm text-[var(--color-text-muted)]">
        {isNew
          ? "Manually add a patient who hasn't messaged in yet. If they message this WhatsApp number later, it'll link to this same contact."
          : isSocial
          ? `Update this patient's name. Their ${channelLabel(contact.channel)} account identifier is managed by Meta.`
          : "Update this patient's name or WhatsApp number."}
      </p>

      <div className="mb-4">
        <label className={labelClass}>Name</label>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
      </div>

      {isSocial ? (
        <div className="mb-6">
          <label className={labelClass}>Channel</label>
          <div className={`${inputClass} cursor-not-allowed text-[var(--color-text-muted)]`}>
            {channelLabel(contact.channel)}
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            The customer identifier is supplied by Meta and can't be edited manually.
          </p>
        </div>
      ) : (
        <div className="mb-6">
          <label className={labelClass}>WhatsApp number</label>
          <input
            className={inputClass}
            value={whatsappNumber}
            onChange={(e) => setWhatsappNumber(e.target.value)}
            placeholder="e.g. +60 12-345 6789"
          />
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Any format works. It's normalized to match how WhatsApp identifies the patient.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50 sm:flex-none"
        >
          {saving && <Spinner />}
          {saving ? "Saving…" : isNew ? "Add contact" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-10 flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] sm:flex-none"
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
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
        isHuman ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      }`}
    >
      {isHuman ? "Staff" : "AI"}
    </span>
  );
}

function isSocialContact(contact) {
  return contact?.channel === "facebook" || contact?.channel === "instagram";
}

function channelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function formatPhone(number) {
  return number ? `+${number}` : "";
}

function contactIdentifier(contact) {
  if (isSocialContact(contact)) return channelLabel(contact.channel);
  return formatPhone(contact?.whatsapp_number);
}

function displayName(contact) {
  return (
    contact?.name ||
    contact?.whatsapp_profile_name ||
    (contact?.channel === "facebook" ? "Facebook user" : null) ||
    (contact?.channel === "instagram" ? "Instagram user" : null) ||
    formatPhone(contact?.whatsapp_number) ||
    "Contact"
  );
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
