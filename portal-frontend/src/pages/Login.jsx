import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { branding } from "../config/branding";

const REMEMBER_KEY = "portal.rememberedUsername";

export default function Login() {
  const { username, login, error } = useAuth();
  const [form, setForm] = useState({ username: "", password: "" });
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) {
      setForm((f) => ({ ...f, username: saved }));
      setRemember(true);
    }
  }, []);

  if (username) return <Navigate to="/inbox" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);

    if (remember) {
      localStorage.setItem(REMEMBER_KEY, form.username);
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }

    await login(form.username, form.password);
    setSubmitting(false);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--color-sidebar)] px-4 py-10">
      {/* Ambient background accents */}
      <div
        className="pointer-events-none absolute -top-32 -left-24 h-80 w-80 rounded-full opacity-20 blur-3xl"
        style={{ background: "var(--color-primary)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full opacity-20 blur-3xl"
        style={{ background: "var(--color-accent)" }}
      />

      <div className="relative flex min-h-[calc(100vh-5rem)] w-full flex-col items-center justify-center">
        <div className="w-full max-w-sm">
          {/* Client identity */}
          <div className="mb-8 flex flex-col items-center text-center">
            <img
              src={branding.clientLogo}
              alt={`${branding.clientName} logo`}
              className="mb-4 h-20 w-20 rounded-2xl object-contain shadow-lg ring-1 ring-white/10"
            />
            <h1 className="font-display text-2xl font-bold text-white">
              {branding.clientName}
            </h1>
            <p className="mt-1 text-sm text-[var(--color-sidebar-text-muted)]">
              {branding.loginTagline}
            </p>
          </div>

          {/* Sign-in card */}
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-2xl bg-[var(--color-surface)] p-6 shadow-xl"
          >
            <div>
              <label
                htmlFor="username"
                className="mb-1.5 block text-sm font-medium text-[var(--color-text)]"
              >
                Username
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[var(--color-text-muted)]">
                  <UserIcon className="h-4 w-4" />
                </span>
                <input
                  id="username"
                  type="text"
                  autoFocus
                  autoComplete="username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className="w-full rounded-lg border border-[var(--color-border)] py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  required
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-[var(--color-text)]"
              >
                Password
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[var(--color-text-muted)]">
                  <LockIcon className="h-4 w-4" />
                </span>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full rounded-lg border border-[var(--color-border)] py-2 pl-9 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  {showPassword ? (
                    <EyeOffIcon className="h-4 w-4" />
                  ) : (
                    <EyeIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <label className="flex cursor-pointer items-center gap-2 text-[var(--color-text-muted)]">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                />
                Remember me
              </label>
              <span
                className="cursor-default text-[var(--color-text-muted)]"
                title="Contact your administrator to reset your password"
              >
                Forgot password?
              </span>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--color-danger-light)] px-3 py-2 text-sm text-[var(--color-danger)]">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
            >
              {submitting && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-[var(--color-sidebar-text-muted)]">
            Staff accounts are created by an admin. Contact the admin if you forgot the password or need more account.
          </p>

          {/* Agency credit */}
          <div className="mt-10 flex flex-col items-center gap-2 border-t border-white/10 pt-6">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-sidebar-text-muted)]">
              Powered by
            </span>
            <img
              src={branding.agencyLogo}
              alt={branding.agencyName}
              className="h-8 w-auto object-contain opacity-90"
            />
            <span className="text-xs font-medium text-[var(--color-sidebar-text-muted)]">
              {branding.agencyName}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M17.9 17.9A10.9 10.9 0 0 1 12 19.5c-7 0-10.5-7-10.5-7a12.9 12.9 0 0 1 4.2-4.9M9.9 5.1A10.6 10.6 0 0 1 12 4.5c7 0 10.5 7 10.5 7a13 13 0 0 1-2.2 3.1M14.1 14.1a3 3 0 1 1-4.2-4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M1.5 1.5l21 21" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v5M12 16h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
