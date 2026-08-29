import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import Inbox from "../pages/Inbox";
import ContactDetailsDrawer from "./ContactDetailsDrawer";

function parseContactId(value) {
  if (!/^\d+$/.test(value || "")) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isThreadHeaderAvatar(target) {
  const element = target instanceof Element ? target : null;
  const avatar = element?.closest?.('[data-contact-avatar="true"]');
  if (!avatar) return false;

  const header = avatar.closest("header");
  const thread = avatar.closest('section[aria-label^="Conversation with "]');
  return Boolean(header && thread && thread.contains(header));
}

export default function InboxWithContactDetails() {
  const [searchParams] = useSearchParams();
  const [drawerContact, setDrawerContact] = useState(null);
  const [open, setOpen] = useState(false);
  const openingRef = useRef(false);

  async function firstConversationId() {
    const conversations = await api.listConversations();
    const id = Number(conversations?.[0]?.contact_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  async function loadContact(contactId) {
    if (!contactId) return null;
    try {
      return await api.getContact(contactId);
    } catch (err) {
      if (err?.status !== 404) throw err;
      return null;
    }
  }

  async function openDetails() {
    if (openingRef.current) return;
    openingRef.current = true;

    try {
      const requestedId = parseContactId(searchParams.get("contact"));
      let contact = await loadContact(requestedId);

      // Inbox selects the first conversation locally on its initial load, so
      // there may not be a ?contact= query value until staff selects another
      // thread. Resolve that one case only when the avatar is actually clicked.
      if (!contact) {
        const fallbackId = await firstConversationId();
        contact = await loadContact(fallbackId);
      }

      if (!contact) return;
      setDrawerContact(contact);
      setOpen(true);
    } catch (err) {
      console.error("Failed to load Inbox contact profile:", err);
    } finally {
      openingRef.current = false;
    }
  }

  function handleClickCapture(event) {
    if (!isThreadHeaderAvatar(event.target)) return;
    openDetails();
  }

  return (
    <div className="h-full" onClickCapture={handleClickCapture}>
      <Inbox />
      <ContactDetailsDrawer
        open={open}
        contact={drawerContact}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
