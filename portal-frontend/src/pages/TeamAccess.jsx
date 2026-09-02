import { useEffect, useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [selectedStaffId, setSelectedStaffId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

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

  const users = useMemo(() => data?.users || [], [data?.users]);
  const branches = useMemo(
    () => (Array.isArray(data?.branches) ? data.branches : []),
    [data?.branches]
  );

  const counts = useMemo(
    () => ({
      active: users.filter((staff) => staff.isActive).length,
      sales: users.filter((staff) => staff.isActive && staff.role === "sales").length,
      admin: users.filter((staff) => staff.isActive && staff.role === "admin").length,
      removed: users.filter((staff) => !staff.isActive).length,
    }),
    [users]
  );

  const filteredUsers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return users
      .filter((staff) => {
        if (roleFilter !== "all" && staff.role !== roleFilter) return false;
        if (statusFilter === "active" && !staff.isActive) return false;
        if (statusFilter === "removed" && staff.isActive) return false;
        if (!search) return true;

        return [
          staff.displayName,
          staff.username,
          staff.role,
          staff.branchName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return (a.displayName || a.username).localeCompare(b.displayName || b.username);
      });
  }, [query, roleFilter, statusFilter, users]);

  const selectedStaff = useMemo(
    () => users.find((staff) => Number(staff.id) === Number(selectedStaffId)) || null,
    [selectedStaffId, users]
  );

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
        showToast(
          "Your access was saved, but the page couldn't refresh your session. Reload the portal.",
          "warning"
        );
      });
    }
  }

  function handleCreated(created) {
    setData((current) => ({ ...current, users: [created, ...current.users] }));
    setCreateOpen(false);
    setSelectedStaffId(created.id);
    showToast("Staff account created.", "info");
  }

  function refresh() {
    setReloadToken((value) => value + 1);
  }

  function clearFilters() {
    setQuery("");
    setRoleFilter("all");
    setStatusFilter("active");
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm">
          <h1 className="font-display text-lg font-bold">Couldn't load Team & Access</h1>
          <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-5 h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white"
          >
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

  const currentUserId = data.currentUserId || signedInUser?.id;

  return (
    <div className="h-full overflow-hidden bg-[var(--color-bg)]">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-3.5 py-4 sm:px-5 sm:py-6 lg:px-8">
        <header className="shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-primary)]">
                Settings
              </p>
              <h1 className="mt-1 font-display text-2xl font-bold sm:text-3xl">Team & Access</h1>
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)] sm:text-sm">
                {counts.active} active · {counts.sales} Sales · {counts.admin} Admin
                {counts.removed > 0 ? ` · ${counts.removed} access removed` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-3.5 text-xs font-semibold text-white transition hover:bg-[var(--color-primary-hover)] sm:h-11 sm:px-4 sm:text-sm"
            >
              <PlusIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Add staff</span>
              <span className="sm:hidden">Add</span>
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_10rem]">
            <label className="relative block min-w-0">
              <span className="sr-only">Search staff</span>
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search staff by name, username or branch"
                className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-9 text-xs outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)] sm:h-11 sm:text-sm"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear staff search"
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </label>

            <label>
              <span className="sr-only">Filter by role</span>
              <select
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value)}
                className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold outline-none focus:border-[var(--color-primary)] sm:h-11"
              >
                <option value="all">All roles</option>
                <option value="sales">Sales</option>
                <option value="admin">Admin</option>
              </select>
            </label>

            <label>
              <span className="sr-only">Filter by access status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold outline-none focus:border-[var(--color-primary)] sm:h-11"
              >
                <option value="active">Active accounts</option>
                <option value="all">All accounts</option>
                <option value="removed">Access removed</option>
              </select>
            </label>
          </div>
        </header>

        <section className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] sm:rounded-3xl">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-bold">Staff accounts</h2>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                {filteredUsers.length === users.length
                  ? `${users.length} total`
                  : `${filteredUsers.length} shown from ${users.length}`}
              </p>
            </div>
            {(query || roleFilter !== "all" || statusFilter !== "active") && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]"
              >
                Reset
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-2.5">
            {filteredUsers.length === 0 ? (
              <div className="flex h-full min-h-56 items-center justify-center px-4 text-center">
                <div>
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-[var(--color-primary)]">
                    <UserIcon className="h-5 w-5" />
                  </div>
                  <p className="mt-3 text-sm font-semibold">No matching staff</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Try a different name, role or account status.
                  </p>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-3 text-xs font-semibold text-[var(--color-primary)]"
                  >
                    Show active staff
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {filteredUsers.map((staff) => (
                  <StaffDirectoryRow
                    key={staff.id}
                    staff={staff}
                    currentUserId={currentUserId}
                    branches={branches}
                    onOpen={() => setSelectedStaffId(staff.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {selectedStaff && (
        <StaffEditorModal
          staff={selectedStaff}
          branches={branches}
          currentUserId={currentUserId}
          permissionDefinitions={data.permissionDefinitions}
          onClose={() => setSelectedStaffId(null)}
          onUpdated={(updated) => handleUpdated(updated, "Access updated.")}
          onRemoved={(updated) => handleUpdated(updated, "Account access removed.")}
          onError={(message) => showToast(message, "error")}
        />
      )}

      {createOpen && (
        <CreateStaffModal
          branches={branches}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
          onError={(message) => showToast(message, "error")}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function StaffDirectoryRow({ staff, currentUserId, branches, onOpen }) {
  const isCurrent = Number(staff.id) === Number(currentUserId);
  const staleBranch = Boolean(staff.branchName) && !branches.includes(staff.branchName);
  const initials = initialsFor(staff.displayName || staff.username);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--color-primary)]/30 sm:px-4 sm:py-3 ${
        staff.isActive ? "hover:bg-[var(--color-bg)]" : "opacity-65 hover:bg-[var(--color-bg)]"
      }`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-xs font-bold text-[var(--color-primary)] sm:h-11 sm:w-11">
        {initials}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--color-text)]">
            {staff.displayName || staff.username}
          </span>
          {isCurrent && <span className="shrink-0 text-[10px] font-semibold text-[var(--color-primary)]">You</span>}
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
          <span className="truncate">@{staff.username}</span>
          <span aria-hidden="true">·</span>
          <span>{staff.role === "admin" ? "Admin" : "Sales"}</span>
          {staff.role === "sales" && staff.branchName && (
            <>
              <span aria-hidden="true">·</span>
              <span className={staleBranch ? "text-[var(--color-danger)]" : ""}>
                {staff.branchName}{staleBranch ? " · old branch" : ""}
              </span>
            </>
          )}
          {!staff.isActive && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium">Access removed</span>
            </>
          )}
        </span>
      </span>

      <span className="hidden shrink-0 items-center gap-1 text-[11px] font-semibold text-[var(--color-text-muted)] transition group-hover:text-[var(--color-primary)] sm:inline-flex">
        Manage
        <ChevronRightIcon className="h-4 w-4" />
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] sm:hidden" />
    </button>
  );
}

function CreateStaffModal({ branches, onClose, onCreated, onError }) {
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
    } catch (err) {
      onError(err.message || "Couldn't create this account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Add staff account" subtitle="Create portal access for a new team member." onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name">
            <input
              className={inputClass}
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              placeholder="Jessica Tan"
            />
          </Field>
          <Field label="Username">
            <input
              className={inputClass}
              autoCapitalize="none"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              placeholder="jessica"
            />
          </Field>
          <Field label="Temporary password">
            <input
              className={inputClass}
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="At least 8 characters"
            />
          </Field>
          <Field label="Role">
            <select
              className={inputClass}
              value={form.role}
              onChange={(event) =>
                setForm({
                  ...form,
                  role: event.target.value,
                  branchName: event.target.value === "sales" ? form.branchName : "",
                })
              }
            >
              <option value="sales">Sales</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </div>

        {form.role === "sales" && (
          <Field label="Sales branch" hint="Optional. Used for branch-first lead assignment when the branch is already known.">
            <select
              className={inputClass}
              value={form.branchName}
              onChange={(event) => setForm({ ...form, branchName: event.target.value })}
            >
              <option value="">No fixed branch</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
            </select>
          </Field>
        )}

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-10 rounded-xl border border-[var(--color-border)] px-4 text-xs font-semibold disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving && <Spinner />}
            {saving ? "Creating…" : "Add account"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function StaffEditorModal({
  staff,
  branches,
  currentUserId,
  permissionDefinitions,
  onClose,
  onUpdated,
  onRemoved,
  onError,
}) {
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
    if (staff.role === "sales" && branchName !== savedBranchName) updates.branchName = branchName;
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

  const subtitleParts = [
    `@${staff.username}`,
    staff.role === "admin" ? "Admin" : "Sales",
    staff.role === "sales" && staff.branchName ? staff.branchName : null,
    !staff.isActive ? "Access removed" : null,
    isCurrent ? "You" : null,
  ].filter(Boolean);

  return (
    <ModalShell
      title={staff.displayName || staff.username}
      subtitle={subtitleParts.join(" · ")}
      onClose={onClose}
      wide
    >
      <div className="space-y-6">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold">Account</h3>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Profile, role and branch assignment.</p>
            </div>
            <div className="flex gap-2">
              <select
                disabled={busy}
                value={staff.role}
                onChange={(event) => changeRole(event.target.value)}
                className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs font-semibold disabled:opacity-50"
              >
                <option value="sales">Sales</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="button"
                disabled={busy || isCurrent}
                onClick={() => patch({ isActive: !staff.isActive })}
                className="h-9 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold disabled:opacity-40"
              >
                {staff.isActive ? "Disable" : "Reactivate"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <input className={inputClass} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </Field>
            <Field label="Reset password">
              <input
                className={inputClass}
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="Leave blank to keep current password"
              />
            </Field>
            {staff.role === "sales" && (
              <div className="sm:col-span-2">
                <Field
                  label="Sales branch"
                  hint={
                    staleBranch
                      ? "This branch is no longer configured. Choose a current branch or No fixed branch before branch-specific routing can use this account again."
                      : "Optional. Used for branch-first assignment when the branch is already known at lead creation."
                  }
                  danger={staleBranch}
                >
                  <select className={inputClass} value={branchName} onChange={(event) => setBranchName(event.target.value)}>
                    <option value="">No fixed branch</option>
                    {staleBranch && <option value={savedBranchName}>{savedBranchName} · no longer configured</option>}
                    {branches.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={saveProfile}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3.5 text-xs font-semibold disabled:opacity-50"
          >
            {busy && <Spinner />}
            Save account details
          </button>
        </section>

        <section className="border-t border-[var(--color-border)] pt-5">
          <div className="mb-3">
            <h3 className="text-sm font-bold">Capabilities</h3>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Choose what this account can see or change.</p>
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
                  className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-left transition hover:border-[var(--color-primary)]/30 disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-[var(--color-text)]">{permission.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">{permission.description}</span>
                  </span>
                  <Toggle enabled={enabled} />
                </button>
              );
            })}
          </div>
        </section>

        {!isCurrent && staff.isActive && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={removeAccess}
              className="h-10 rounded-xl px-3 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-light)] disabled:opacity-50"
            >
              Remove access
            </button>
          </section>
        )}
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-0 sm:p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface)] shadow-2xl sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:rounded-3xl sm:border sm:border-[var(--color-border)] ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-bold">{title}</h2>
            {subtitle && <p className="mt-1 truncate text-xs text-[var(--color-text-muted)]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">{children}</div>
      </section>
    </div>
  );
}

function Field({ label, hint, danger = false, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
      {hint && (
        <span className={`mt-1.5 block text-[10px] leading-4 ${danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
          {hint}
        </span>
      )}
    </label>
  );
}

function Toggle({ enabled }) {
  return (
    <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
    </span>
  );
}

function initialsFor(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return "?";
  return parts.map((part) => part[0]?.toUpperCase()).join("");
}

function SearchIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PlusIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function ChevronRightIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function UserIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.5 3.6-7 8-7s8 2.5 8 7" />
    </svg>
  );
}
