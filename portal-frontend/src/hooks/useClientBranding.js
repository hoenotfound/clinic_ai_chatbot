import { useEffect, useState } from "react";
import agencyLogo from "../assets/DAlogo.png";

const FALLBACK = Object.freeze({
  clientName: "Client Portal",
  clientLogoUrl: "",
  clientAppIcon180Url: "",
  clientAppIcon192Url: "",
  clientAppIcon512Url: "",
  loginTagline: "Sign in to manage customer conversations",
});

let cachedBranding = null;
let pendingBranding = null;

function normalizeBranding(value = {}) {
  return {
    clientName: String(value.clientName || "").trim() || FALLBACK.clientName,
    clientLogoUrl: String(value.clientLogoUrl || "").trim(),
    clientAppIcon180Url: String(value.clientAppIcon180Url || "").trim(),
    clientAppIcon192Url: String(value.clientAppIcon192Url || "").trim(),
    clientAppIcon512Url: String(value.clientAppIcon512Url || "").trim(),
    loginTagline: String(value.loginTagline || "").trim() || FALLBACK.loginTagline,
  };
}

function setHeadLink(rel, href, attributes = {}) {
  if (!href) return;
  let link = document.head.querySelector(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
  for (const [key, value] of Object.entries(attributes)) {
    if (value) link.setAttribute(key, value);
    else link.removeAttribute(key);
  }
}

function setNamedMeta(name, content) {
  let meta = document.head.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}

function initialsFor(value) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return initials || "CP";
}

async function loadBranding() {
  if (cachedBranding) return cachedBranding;
  if (!pendingBranding) {
    pendingBranding = fetch("/api/auth/branding", {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Branding request failed (${response.status})`);
        cachedBranding = normalizeBranding(await response.json());
        return cachedBranding;
      })
      .finally(() => {
        pendingBranding = null;
      });
  }
  return pendingBranding;
}

export function useClientBranding() {
  const [clientBranding, setClientBranding] = useState(cachedBranding || FALLBACK);

  useEffect(() => {
    let active = true;
    loadBranding()
      .then((branding) => {
        if (active) setClientBranding(branding);
      })
      .catch(() => {
        // A branding failure must never block staff from reaching the portal.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const faviconUrl = "/api/auth/branding/favicon.png";
    const appleTouchIconUrl = "/api/auth/branding/apple-touch-icon.png";

    document.title = `${clientBranding.clientName} | AI Chatbot Portal`;
    setHeadLink("icon", faviconUrl, {
      type: "image/png",
      sizes: "192x192",
    });
    setHeadLink("apple-touch-icon", appleTouchIconUrl, {
      sizes: "180x180",
    });
    setNamedMeta("apple-mobile-web-app-title", clientBranding.clientName);
  }, [clientBranding.clientName]);

  return {
    ...clientBranding,
    initials: initialsFor(clientBranding.clientName),
    agencyName: "DA Smarketing Solutions",
    agencyLogo,
  };
}

export { FALLBACK, initialsFor, normalizeBranding };
