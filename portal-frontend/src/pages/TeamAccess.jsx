import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { teamApi } from "../teamApi";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";

const inputClass =
  "h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20";

export default function TeamAccess() {
  const { user: signedInUser, refreshUser } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    teamApi
      .listUsers()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load team access.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function replaceUser(updated) {
    setData((current) => ({
      ...current,
      users: current.users.map((user) => (user.id === updated.id ? updated : user)),
    }));
  }

  function handleUpdated(updated, message) {
    replaceUser(updated);
    showToast(message, "info");
    if (Number(updated.id) === Number(signedInUser?.id)) {
      refreshUser().catch(() => {
        showToast("Your access was saved, but the page couldn't refresh your session. Reload the portal.", "warning");
      });
    }
  }

  function refresh() {
    setReloadToken((value) => value + 1);
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm">
          <h1 className="font-display text-lg font-bold">Couldn't load Team & Access</h1>
          <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>
          <button type="button" onClick={refresh} className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)]">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  const branches = Array.isArray(data.branches) ? data.branches : [];

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto w-full max-w-5xl px-3.5 py-5 sm:px-5 sm:py-7 lg:px-8">
        <div className="mb-5 sm:mb-7">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-primary)]">Settings</p>
          <h1 className="mt-1 font-display text-2xl font-bold sm:text-3xl">Team & Access</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">
            Add staff accounts, choose Admin or Sales, assign Sales accounts to branches, and control exactly what each person can see or change.
          </p>
        </div>

        <CreateStaffCard
          branches={branches}
          onCreated={(created) => {
            setData((current) => ({ ...current, users: [created, ...current.users] }));
            showToast("Staff account created.", "info");
          }}
          onError={(message) => showToast(message, "error")}
        />

        <div className="mt-6 space-y-4">
          {data.users.map((staff) => (
            <StaffCard
              key={staff.id}
              staff={staff}
              branches={branches}
              currentUserId={data.currentUserId || signedInUser?.id}
              permissionDefinitions={data.permissionDefinitions}
              onUpdated={(updated) => handleUpdated(updated, "Access updated.")}
              onRemoved={(updated) => handleUpdated(updated, "Account access removed.")}
              onError={(message) => showToast(message, "error")}
            />
          ))}
        </div>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function CreateStaffCard({ branches, onCreated, onError }) {
  const [form, setForm] = useState({
    displayName: "",
    username: "",
    password: "",
    role: "sales",
    branchName: "",
  });
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await teamApi.createUser(form);
      onCreated(result.user);
      setForm({ displayName: "", username: "", password: "", role: "sales", branchName: "" });
    } catch (err) {
      onError(err.message || "Couldn't create this account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:rounded-3xl sm:p-6">
      <div className="mb-4">
        <h2 className="font-display text-lg font-bold">Add staff account</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
          Sales accounts can see all leads by default, while lead assignment shows workload ownership and powers personal filters. A fixed branch is used for branch-first assignment when that branch is already known as the lead is created.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Display name</span>
          <input className={inputClass} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Jessica Tan" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Username</span>
          <input className={inputClass} autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="jessica" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Temporary password</span>
          <input className={inputClass} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Role</span>
          <select
            className={inputClass}
            value={form.role}
            onChange={(e) => setForm({
              ...form,
              role: e.target.value,
              branchName: e.target.value === "sales" ? form.branchName : "",
            })}
          >
            <option value="sales">Sales</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {form.role === "sales" && (
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Sales branch</span>
            <select className={inputClass} value={form.branchName} onChange={(e) => setForm({ ...form, branchName: e.target.value })}>
              <option value="">No fixed branch</option>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
            <span className="mt-1.5 block text-[11px] leading-5 text-[var(--color-text-muted)]">
              Used only when a trusted branch is already known at lead creation. Later branch record changes never move the lead to another owner.
            </span>
          </label>
        )}
      </div>
      <button type="submit" disabled={saving} className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto">
        {saving && <Spinner />}
        {saving ? "Creating…" : "Add account"}
      </button>
    </form>
  );
}

function StaffCard({ staff, branches, currentUserId, permissionDefinitions, onUpdated, onRemoved, onError }) {
  const [displayName, setDisplayName] = useState(staff.displayName || staff.username);
  const [branchName, setBranchName] = useState(staff.branchName || "");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const isCurrent = Number(staff.id) === Number(currentUserId);
  const savedBranchName = staff.branchName || "";
  const staleBranch = Boolean(savedBranchName) && !branches.includes(savedBranchName);

  useEffect(() => {
    setDisplayName(staff.displayName || staff.username);
    setBranchName(staff.branchName || "");
  }, [staff.displayName, staff.username, staff.branchName]);

  async function patch(updates, success = onUpdated) {
    setBusy(true);
    try {
      const result = await teamApi.updateUser(staff.id, updates);
      success(result.user);
      return result.user;
    } catch (err) {
      onError(err.message || "Couldn't update this account.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    const updates = { displayName };
    if (staff.role === "sales" && branchName !== savedBranchName) {
      updates.branchName = branchName;
    }
    if (newPassword) updates.password = newPassword;
    const updated = await patch(updates);
    if (updated) setNewPassword("");
  }

  async function changeRole(role) {
    const updated = await patch({ role });
    if (updated?.role !== "sales") setBranchName("");
  }

  async function togglePermission(key) {
    await patch({ permissions: { ...staff.permissions, [key]: !staff.permissions[key] } });
  }

  async function removeAccess() {
    if (!window.confirm(`Remove portal access for ${staff.displayName || staff.username}? Their account record stays for lead history.`)) return;
    setBusy(true);
    try {
      const result = await teamApi.removeUser(staff.id);
      onRemoved(result.user);
    } catch (err) {
      onError(err.message || "Couldn't remove this account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`rounded-2xl border bg-[var(--color-surface)] p-4 shadow-sm sm:rounded-3xl sm:p-6 ${staff.isActive ? "border-[var(--color-border)]" : "border-dashed border-[var(--color-border)] opacity-75"}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-display text-lg font-bold">{staff.displayName || staff.username}</h2>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${staff.role === "admin" ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
              {staff.role}
            </span>
            {staff.role === "sales" && staff.branchName && (
              <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${staleBranch ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"}`}>
                {staff.branchName}{staleBranch ? " · old branch" : ""}
              </span>
            )}
            {!staff.isActive && <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Access removed</span>}
            {isCurrent && <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--color-text-muted)]">You</span>}
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">@{staff.username}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select disabled={busy} value={staff.role} onChange={(e) => changeRole(e.target.value)} className="h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs font-semibold">
            <option value="sales">Sales</option>
            <option value="admin">Admin</option>
          </select>
          <button type="button" disabled={busy || isCurrent} onClick={() => patch({ isActive: !staff.isActive })} className="h-10 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-40">
            {staff.isActive ? "Disable" : "Reactivate"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Display name</span>
          <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Reset password</span>
          <input className={inputClass} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Leave blank to keep current password" />
        </label>
        {staff.role === "sales" && (
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">Sales branch</span>
            <select className={inputClass} value={branchName} onChange={(e) => setBranchName(e.target.value)}>
              <option value="">No fixed branch</option>
              {staleBranch && (
                <option value={savedBranchName}>{savedBranchName} · no longer configured</option>
              )}
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
            {staleBranch ? (
              <span className="mt-1.5 block text-[11px] leading-5 text-[var(--color-danger)]">
                This branch no longer exists in clinic settings. You can still save this staff member's name or password without changing it, but choose a current branch or No fixed branch before branch-specific routing can use this account again.
              </span>
            ) : (
              <span className="mt-1.5 block text-[11px] leading-5 text-[var(--color-text-muted)]">
                Used for branch-first assignment only when the branch is already known as the lead is created. Every eligible Sales account still participates in the global rotation for leads without a known branch.
              </span>
            )}
          </label>
        )}
      </div>
      <button type="button" disabled={busy} onClick={saveProfile} className="mt-3 h-10 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-50">
        Save account details
      </button>

      <div className="mt-6 border-t border-[var(--color-border)] pt-5">
        <div className="mb-3">
          <h3 className="text-sm font-bold">Capabilities</h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">Backend authorization uses these switches too — hiding a menu item is not the security boundary.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {permissionDefinitions.map((permission) => {
            const enabled = staff.permissions?.[permission.key] === true;
            return (
              <button
                key={permission.key}
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={busy || !staff.isActive}
                onClick={() => togglePermission(permission.key)}
                className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-left disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-[var(--color-text)]">{permission.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-text-muted)]">{permission.description}</span>
                </span>
                <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
                  <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {!isCurrent && staff.isActive && (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <button type="button" disabled={busy} onClick={removeAccess} className="h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)] disabled:opacity-50">
            Remove access
          </button>
        </div>
      )}
    </section>
  );
}
