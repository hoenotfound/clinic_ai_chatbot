import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { branding } from "../config/branding";

const LEAD_VIEW = ["view_assigned_leads", "view_all_leads"];
const NAV_ITEMS = [
  { to: "/inbox", label: "Inbox", icon: ChatIcon, capabilities: LEAD_VIEW },
  { to: "/contacts", label: "Contacts", icon: ContactsIcon, capabilities: LEAD_VIEW },
  { to: "/pipeline", label: "Pipeline", icon: PipelineIcon, capabilities: LEAD_VIEW },
  { to: "/analytics", label: "Analytics", icon: AnalyticsIcon, capabilities: ["view_analytics"] },
  { to: "/tools", label: "Tools", icon: ToolsIcon, capabilities: ["manage_tools"] },
  {
    to: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    capabilities: ["manage_settings", "manage_users"],
    adminAlso: true,
  },
];

export default function Sidebar() {
  const { user, username, permissions, logout } = useAuth();
  const navigate = useNavigate();
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.adminAlso && user?.role === "admin") return true;
    return item.capabilities.some((capability) => permissions[capability] === true);
  });

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <aside className="flex h-screen w-[4.25rem] shrink-0 flex-col bg-[var(--color-sidebar)] text-[var(--color-sidebar-text)] transition-[width] lg:w-60">
      <div className="flex items-center justify-center gap-2.5 px-3 py-5 lg:justify-start lg:px-5">
        <img
          src={branding.clientLogo}
          alt={`${branding.clientName} logo`}
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
        />
        <span className="hidden truncate font-display text-[15px] font-bold text-white lg:inline">
          {branding.clientName}
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2 lg:px-3">
        {visibleItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={item.label}
            aria-label={item.label}
            className={({ isActive }) =>
              `flex items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm font-medium transition-colors lg:justify-start lg:px-3 ${
                isActive
                  ? "bg-[var(--color-primary)] text-white"
                  : "text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover)]"
              }`
            }
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" />
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 px-2 py-4 lg:px-3">
        <div className="mb-1 hidden px-3 py-2 lg:block">
          <p className="truncate text-sm font-medium text-white">
            {user?.displayName || username}
          </p>
          <p className="mt-0.5 truncate text-xs text-[var(--color-sidebar-text-muted)]">
            @{username} · {user?.role || "staff"}
          </p>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          title="Log out"
          aria-label="Log out"
          className="flex w-full items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm text-[var(--color-sidebar-text-muted)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-white lg:justify-start lg:px-3"
        >
          <LogoutIcon className="h-[18px] w-[18px] shrink-0" />
          <span className="hidden lg:inline">Log out</span>
        </button>
      </div>
    </aside>
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
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
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
