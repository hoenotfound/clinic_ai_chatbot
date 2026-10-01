import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useClientBranding } from "../hooks/useClientBranding";

const LEAD_VIEW = ["view_assigned_leads", "view_all_leads"];
const SIDEBAR_STORAGE_KEY = "portal.sidebar.expanded";
const PRIMARY_NAV_ITEMS = [
  { to: "/inbox", label: "Inbox", icon: ChatIcon, capabilities: LEAD_VIEW },
  { to: "/contacts", label: "Contacts", icon: ContactsIcon, capabilities: LEAD_VIEW },
  { to: "/pipeline", label: "Pipeline", icon: PipelineIcon, capabilities: LEAD_VIEW },
  { to: "/analytics", label: "Analytics", icon: AnalyticsIcon, capabilities: ["view_analytics"] },
  { to: "/tools", label: "Tools", icon: ToolsIcon, capabilities: ["manage_tools"] },
];
const SETTINGS_ITEM = {
  to: "/settings",
  label: "Settings",
  icon: SettingsIcon,
  capabilities: ["manage_settings", "manage_users"],
  adminAlso: true,
};

function getInitialSidebarPreference() {
  if (typeof window === "undefined") {
    return { expanded: false, explicit: false };
  }

  try {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return { expanded: stored === "true", explicit: true };
    }
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }

  return {
    expanded: window.matchMedia("(min-width: 1280px)").matches,
    explicit: false,
  };
}

function getInitialPhoneState() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 639px)").matches;
}

function initialsForUser(value) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return initials || "U";
}

function canShowItem(item, user, permissions) {
  if (item.adminAlso && user?.role === "admin") return true;
  return item.capabilities.some((capability) => permissions[capability] === true);
}

function SidebarNavLink({
  item,
  onShowTooltip,
  onHideTooltip,
  onNavigate,
}) {
  return (
    <NavLink
      to={item.to}
      aria-label={item.label}
      onMouseEnter={(event) => onShowTooltip(event, item.label)}
      onMouseLeave={onHideTooltip}
      onFocus={(event) => onShowTooltip(event, item.label)}
      onBlur={onHideTooltip}
      onClick={() => {
        onHideTooltip();
        onNavigate?.();
      }}
      className={({ isActive }) =>
        `app-sidebar-nav-item relative flex items-center rounded-xl font-medium transition-colors ${isActive ? "is-active" : ""}`
      }
    >
      <item.icon className="h-[19px] w-[19px] shrink-0" />
      <span className="app-sidebar-label truncate">{item.label}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  const { user, username, permissions, logout } = useAuth();
  const branding = useClientBranding();
  const navigate = useNavigate();
  const [sidebarPreference, setSidebarPreference] = useState(getInitialSidebarPreference);
  const [isPhone, setIsPhone] = useState(getInitialPhoneState);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [tooltip, setTooltip] = useState(null);
  const sidebarExpanded = sidebarPreference.expanded;
  const sidebarOpen = isPhone ? mobileOpen : sidebarExpanded;
  const visiblePrimaryItems = PRIMARY_NAV_ITEMS.filter((item) => canShowItem(item, user, permissions));
  const settingsVisible = canShowItem(SETTINGS_ITEM, user, permissions);
  const userDisplayName = user?.displayName || username || "User";
  const toggleLabel = isPhone
    ? (mobileOpen ? "Close sidebar" : "Open sidebar")
    : (sidebarExpanded ? "Collapse sidebar" : "Expand sidebar");

  useEffect(() => {
    if (sidebarPreference.explicit) return undefined;

    const desktopDefault = window.matchMedia("(min-width: 1280px)");
    const syncWithViewport = (event) => {
      setSidebarPreference((current) => (
        current.explicit
          ? current
          : { expanded: event.matches, explicit: false }
      ));
    };

    desktopDefault.addEventListener("change", syncWithViewport);
    return () => desktopDefault.removeEventListener("change", syncWithViewport);
  }, [sidebarPreference.explicit]);

  useEffect(() => {
    const phoneQuery = window.matchMedia("(max-width: 639px)");
    const syncPhoneState = (event) => {
      setIsPhone(event.matches);
      if (!event.matches) setMobileOpen(false);
    };

    phoneQuery.addEventListener("change", syncPhoneState);
    return () => phoneQuery.removeEventListener("change", syncPhoneState);
  }, []);

  useEffect(() => {
    if (sidebarOpen) setTooltip(null);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!mobileOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  function toggleSidebar() {
    if (isPhone) {
      setMobileOpen((current) => !current);
      return;
    }

    setSidebarPreference((current) => {
      const nextExpanded = !current.expanded;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(nextExpanded));
      } catch {
        // Keep the in-memory preference even when storage is unavailable.
      }
      return { expanded: nextExpanded, explicit: true };
    });
  }

  function closeMobileSidebar() {
    if (isPhone) setMobileOpen(false);
  }

  function showTooltip(event, label) {
    if (sidebarOpen) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      label,
      top: rect.top + (rect.height / 2),
      left: rect.right + 10,
    });
  }

  function hideTooltip() {
    setTooltip(null);
  }

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <>
      {isPhone && mobileOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="app-sidebar-mobile-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        data-testid="app-sidebar"
        data-expanded={sidebarExpanded ? "true" : "false"}
        data-mobile-open={mobileOpen ? "true" : "false"}
        className="app-sidebar flex h-dvh shrink-0 flex-col bg-[var(--color-sidebar)] text-[var(--color-sidebar-text)]"
      >
        <div className="app-sidebar-brand flex items-center">
          <div className="app-sidebar-brand-main flex min-w-0 items-center">
            {branding.clientLogoUrl ? (
              <img
                src={branding.clientLogoUrl}
                alt={`${branding.clientName} logo`}
                className="h-8 w-8 shrink-0 rounded-lg object-contain"
              />
            ) : (
              <div
                aria-label={`${branding.clientName} logo`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-bold text-white"
              >
                {branding.initials}
              </div>
            )}
            <div className="app-sidebar-brand-copy min-w-0">
              <p className="truncate font-display text-[14px] font-bold leading-5 text-white">
                {branding.clientName}
              </p>
              <p className="truncate text-[10px] font-semibold tracking-[0.08em] text-[var(--color-sidebar-text-muted)]">
                DA CHATBOT
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={toggleLabel}
          aria-expanded={sidebarOpen}
          aria-controls="portal-sidebar-primary-nav"
          className="app-sidebar-toggle"
        >
          <span className="app-sidebar-toggle-visual">
            <ChevronLeftIcon className={`h-3.5 w-3.5 transition-transform ${sidebarOpen ? "" : "rotate-180"}`} />
          </span>
        </button>

        <nav
          id="portal-sidebar-primary-nav"
          aria-label="Primary navigation"
          className="app-sidebar-nav flex-1 space-y-1 overflow-y-auto"
        >
          {visiblePrimaryItems.map((item) => (
            <SidebarNavLink
              key={item.to}
              item={item}
              onShowTooltip={showTooltip}
              onHideTooltip={hideTooltip}
              onNavigate={closeMobileSidebar}
            />
          ))}
        </nav>

        <div className="app-sidebar-utility border-t border-white/10">
          {settingsVisible && (
            <nav aria-label="Utility navigation">
              <SidebarNavLink
                item={SETTINGS_ITEM}
                onShowTooltip={showTooltip}
                onHideTooltip={hideTooltip}
                onNavigate={closeMobileSidebar}
              />
            </nav>
          )}

          <div
            className="app-sidebar-user-row flex items-center"
            onMouseEnter={(event) => showTooltip(event, `${userDisplayName} · ${user?.role || "staff"}`)}
            onMouseLeave={hideTooltip}
          >
            <div
              aria-hidden="true"
              className="app-sidebar-user-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white"
            >
              {initialsForUser(userDisplayName)}
            </div>
            <div className="app-sidebar-user-copy min-w-0">
              <p className="truncate text-sm font-medium text-white">
                {userDisplayName}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-[var(--color-sidebar-text-muted)]">
                @{username} · {user?.role || "staff"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            onMouseEnter={(event) => showTooltip(event, "Log out")}
            onMouseLeave={hideTooltip}
            onFocus={(event) => showTooltip(event, "Log out")}
            onBlur={hideTooltip}
            aria-label="Log out"
            className="app-sidebar-logout flex w-full items-center rounded-xl"
          >
            <LogoutIcon className="h-[19px] w-[19px] shrink-0" />
            <span className="app-sidebar-label truncate">Log out</span>
          </button>
        </div>

        {tooltip && (
          <div
            role="tooltip"
            className="app-sidebar-tooltip"
            style={{ top: tooltip.top, left: tooltip.left }}
          >
            {tooltip.label}
          </div>
        )}
      </aside>
    </>
  );
}

function ChevronLeftIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25">
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ContactsIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PipelineIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="7" width="5" height="14" rx="1" />
      <rect x="17" y="11" width="4" height="10" rx="1" />
    </svg>
  );
}

function AnalyticsIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 16l4-5 3 3 5-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolsIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.4 7.2 6.1 4.9a4 4 0 0 0 5 5L4 17a2.1 2.1 0 0 0 3 3l7.1-7.1a4 4 0 0 0 5-5l-2.3 2.3-3.6-3.6 1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LogoutIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 17l5-5-5-5M15 12H3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" strokeLinecap="round" />
    </svg>
  );
}
