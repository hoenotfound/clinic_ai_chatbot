import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import ContactDetailsDrawer from "./ContactDetailsDrawer";

function parseContactId(search) {
  const value = new URLSearchParams(search).get("contact");
  if (!/^\d+$/.test(value || "")) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function findThreadAvatar(target) {
  const element = target instanceof Element ? target : null;
  const avatar = element?.closest?.('[data-contact-avatar="true"]');
  if (!avatar) return null;

  const header = avatar.closest("header");
  const thread = avatar.closest('section[aria-label^="Conversation with "]');
  if (!header || !thread || !thread.contains(header)) return null;
  return avatar;
}

export default function InboxContactDetailsHost() {
  const location = useLocation();
  const isInbox = location.pathname === "/inbox";
  const requestedId = useMemo(() => parseContactId(location.search), [location.search]);
  const [fallbackId, setFallbackId] = useState(null);
  const [fallbackContact, setFallbackContact] = useState(null);
  const [drawerContact, setDrawerContact] = useState(null);
  const [open, setOpen] = useState(false);

  const selectedId = requestedId || fallbackId;

  useEffect(() => {
    if (!isInbox) {
      setFallbackId(null);
      setFallbackContact(null);
      setOpen(false);
      return;
    }

    let cancelled = false;
    api
      .listConversations()
      .then((conversations) => {
        if (cancelled) return;
        const requested = requestedId
          ? conversations.find((item) => Number(item.contact_id) === requestedId)
          : null;
        const selected = requested || conversations[0] || null;
        setFallbackId(selected ? Number(selected.contact_id) : null);
        setFallbackContact(selected);
      })
      .catch((err) => {
        console.error("Failed to prepare Inbox contact details:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [isInbox, requestedId]);

  useEffect(() => {
    setOpen(false);
    setDrawerContact(null);
  }, [selectedId]);

  useEffect(() => {
    if (!isInbox || !selectedId) return;

    let opening = false;
    async function openDetails() {
      if (opening) return;
      opening = true;
      try {
        const contact = await api.getContact(selectedId);
        setDrawerContact(contact);
      } catch (err) {
        console.error("Failed to load Inbox contact profile:", err);
        if (fallbackContact && Number(fallbackContact.contact_id) === Number(selectedId)) {
          setDrawerContact(fallbackContact);
        } else {
          opening = false;
          return;
        }
      }
      setOpen(true);
      opening = false;
    }

    function enhanceHeaderAvatar() {
      const avatar = document.querySelector(
        'section[aria-label^="Conversation with "] header [data-contact-avatar="true"]'
      );
      if (!avatar) return;
      avatar.setAttribute("role", "button");
      avatar.setAttribute("tabindex", "0");
      avatar.setAttribute("title", "View contact details");
      avatar.setAttribute("aria-label", "View contact details");
      avatar.style.cursor = "pointer";
    }

    function handleClick(event) {
      if (!findThreadAvatar(event.target)) return;
      openDetails();
    }

    function handleKeyDown(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!findThreadAvatar(event.target)) return;
      event.preventDefault();
      openDetails();
    }

    enhanceHeaderAvatar();
    const observer = new MutationObserver(enhanceHeaderAvatar);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [fallbackContact, isInbox, selectedId]);

  return (
    <ContactDetailsDrawer
      open={open}
      contact={drawerContact}
      onClose={() => setOpen(false)}
    />
  );
}
