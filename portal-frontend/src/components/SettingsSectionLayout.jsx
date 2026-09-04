import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function SettingsSectionLayout({ children }) {
  const { user, permissions } = useAuth();
  const items = [
    permissions.manage_settings
      ? { to: "/settings", label: "Configuration", end: true }
      : null,
    permissions.manage_users
      ? { to: "/settings/team", label: "Team & Access", end: true }
      : null,
    user?.role === "admin"
      ? { to: "/settings/setup", label: "Setup Status", end: true }
      : null,
  ].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      {items.length > 1 && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-5 lg:px-6">
          <nav
            aria-label="Settings sections"
            className="flex min-h-12 items-center gap-1 overflow-x-auto py-1.5"
          >
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `inline-flex h-9 shrink-0 items-center rounded-xl px-3 text-xs font-semibold transition-colors sm:text-sm ${
                    isActive
                      ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
