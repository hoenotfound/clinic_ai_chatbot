import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const CONFIG_ITEMS = [
  { id: "general", label: "General" },
  { id: "branches", label: "Branches" },
  { id: "hours", label: "Hours & Contact" },
  { id: "services", label: "Services" },
  { id: "aliases", label: "Service Terms" },
  { id: "faqs", label: "FAQs" },
  { id: "promotions", label: "Promotions" },
  { id: "aiBehavior", label: "AI Behavior" },
  { id: "escalation", label: "Handoff & Rules" },
];

function configDestination(id) {
  return id === "general" ? "/settings" : `/settings?tab=${encodeURIComponent(id)}`;
}

export default function SettingsSectionLayout({ children }) {
  const { user, permissions } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isTeam = location.pathname === "/settings/team";
  const isSetup = location.pathname === "/settings/setup";
  const mobileValue = isTeam ? "team" : isSetup ? "setup" : "general";

  const administrationItems = [
    permissions.manage_users
      ? { id: "team", to: "/settings/team", label: "Team & Access" }
      : null,
    user?.role === "admin"
      ? { id: "setup", to: "/settings/setup", label: "Setup Status" }
      : null,
  ].filter(Boolean);

  function handleMobileChange(value) {
    const configItem = CONFIG_ITEMS.find((item) => item.id === value);
    if (configItem) {
      navigate(configDestination(configItem.id));
      return;
    }
    const adminItem = administrationItems.find((item) => item.id === value);
    if (adminItem) navigate(adminItem.to);
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg)] md:flex-row">
      <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:flex">
        <div className="border-b border-[var(--color-border)] px-5 py-5">
          <h1 className="font-display text-lg font-bold">Settings</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">Bot & clinic configuration</p>
        </div>

        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
          {permissions.manage_settings && (
            <div className="space-y-1">
              {CONFIG_ITEMS.map((item) => (
                <NavLink
                  key={item.id}
                  to={configDestination(item.id)}
                  className="block min-h-10 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          )}

          {administrationItems.length > 0 && (
            <div className={permissions.manage_settings ? "mt-3 border-t border-[var(--color-border)] pt-3" : ""}>
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                Administration
              </p>
              <div className="space-y-1">
                {administrationItems.map((item) => (
                  <NavLink
                    key={item.id}
                    to={item.to}
                    end
                    className={({ isActive }) =>
                      `block min-h-10 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--color-primary-light)] font-semibold text-[var(--color-primary)]"
                          : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          )}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-4 sm:px-5 md:hidden">
          <h1 className="font-display text-xl font-bold">Settings</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">Manage configuration, team access and setup health.</p>
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Section</span>
            <select
              value={mobileValue}
              onChange={(event) => handleMobileChange(event.target.value)}
              className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm font-semibold text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20"
            >
              {permissions.manage_settings && CONFIG_ITEMS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
              {administrationItems.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
        </header>

        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
