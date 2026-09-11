import { useEffect, useState } from "react";
import agencyLogo from "../assets/DAlogo.png";

const FALLBACK = Object.freeze({
  clientName: "Client Portal",
  clientLogoUrl: "",
  loginTagline: "Sign in to manage customer conversations",
});

let cachedBranding = null;
let pendingBranding = null;

function normalizeBranding(value = {}) {
  return {
    clientName: String(value.clientName || "").trim() || FALLBACK.clientName,
    clientLogoUrl: String(value.clientLogoUrl || "").trim(),
    loginTagline: String(value.loginTagline || "").trim() || FALLBACK.loginTagline,
  };
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
    document.title = `${clientBranding.clientName} | AI Chatbot Portal`;
  }, [clientBranding.clientName]);

  return {
    ...clientBranding,
    initials: initialsFor(clientBranding.clientName),
    agencyName: "DA Smarketing Solutions",
    agencyLogo,
  };
}

export { FALLBACK, initialsFor, normalizeBranding };
