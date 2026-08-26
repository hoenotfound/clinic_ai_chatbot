import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
  { to: "/inbox", label: "Inbox", icon: ChatIcon, active: true },
  { to: "/contacts", label: "Contacts", icon: ContactsIcon, active: true },
  { to: "/pipeline", label: "Pipeline", icon: PipelineIcon, active: false },
  {
    to: "/analytics",
    label: "Analytics",
    icon: AnalyticsIcon,
    active: false,
  },
  { to: "/tools", label: "Tools", icon: ToolsIcon, active: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, active: true },
];

export default function Sidebar() {
  const { username, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <aside className="w-60 shrink-0 bg-[var(--color-sidebar)] text-[var(--color-sidebar-text)] flex flex-col h-screen">
      {/* Logo */}
      <div className="px-5 py-5 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-[var(--color-primary)] flex items-center justify-center shrink-0">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.2"
          >
            <path
              d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <span className="font-display font-bold text-white text-[15px]">
          Clinic Portal
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {NAV_ITEMS.map((item) =>
          item.active ? (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover)]"
                }`
              }
            >
              <item.icon className="w-[18px] h-[18px] shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          ) : (
            <div
              key={item.to}
              title="Coming soon"
              aria-disabled="true"
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-[var(--color-sidebar-text-muted)] cursor-not-allowed select-none"
            >
              <span className="flex items-center gap-3">
                <item.icon className="w-[18px] h-[18px] shrink-0" />
                <span>{item.label}</span>
              </span>

              <span className="text-[10px] uppercase tracking-wide bg-white/10 px-1.5 py-0.5 rounded">
                Soon
              </span>
            </div>
          )
        )}
      </nav>

      {/* User and logout */}
      <div className="px-3 py-4 border-t border-white/10">
        <div className="px-3 py-2 mb-1">
          <p className="text-xs text-[var(--color-sidebar-text-muted)]">
            Signed in as
          </p>

          <p className="text-sm font-medium text-white truncate">
            {username}
          </p>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--color-sidebar-text-muted)] hover:bg-[var(--color-sidebar-hover)] hover:text-white transition-colors"
        >
          Log out
        </button>
      </div>
    </aside>
  );
}

function ChatIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ContactsIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="7" r="4" />
      <path
        d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PipelineIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="7" width="5" height="14" rx="1" />
      <rect x="17" y="11" width="4" height="10" rx="1" />
    </svg>
  );
}

function AnalyticsIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M3 3v18h18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 16l4-5 3 3 5-7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolsIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.4 7.2 6.1 4.9a4 4 0 0 0 5 5L4 17a2.1 2.1 0 0 0 3 3l7.1-7.1a4 4 0 0 0 5-5l-2.3 2.3-3.6-3.6 1.5-1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon(props) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
