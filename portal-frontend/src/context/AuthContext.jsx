import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";

const AuthContext = createContext(null);

function normalizeUser(response) {
  if (response?.user) return response.user;
  if (response?.username) {
    return {
      username: response.username,
      displayName: response.username,
      role: "admin",
      permissions: {},
    };
  }
  return null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [error, setError] = useState(null);

  const refreshUser = useCallback(async () => {
    const res = await api.me();
    const nextUser = normalizeUser(res);
    setUser(nextUser);
    return nextUser;
  }, []);

  useEffect(() => {
    refreshUser().catch(() => setUser(null));
  }, [refreshUser]);

  useEffect(() => {
    const root = document.documentElement;
    const permissions = user?.permissions || {};
    root.dataset.canReplyLeads = String(permissions.reply_to_assigned_leads === true);
    root.dataset.canManageLeads = String(permissions.manage_assigned_leads === true);
    return () => {
      delete root.dataset.canReplyLeads;
      delete root.dataset.canManageLeads;
    };
  }, [user]);

  const login = useCallback(async (u, p) => {
    setError(null);
    try {
      const res = await api.login(u, p);
      setUser(normalizeUser(res));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

  const value = useMemo(() => {
    const permissions = user?.permissions || {};
    return {
      user,
      username: user?.username || null,
      permissions,
      can: (capability) => permissions[capability] === true,
      login,
      logout,
      refreshUser,
      error,
      loading: user === undefined,
    };
  }, [user, login, logout, refreshUser, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
