import { createContext, useContext, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    api
      .me()
      .then((res) => setUser(normalizeUser(res)))
      .catch(() => setUser(null));
  }, []);

  async function login(u, p) {
    setError(null);
    try {
      const res = await api.login(u, p);
      setUser(normalizeUser(res));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  const value = useMemo(() => {
    const permissions = user?.permissions || {};
    return {
      user,
      username: user?.username || null,
      permissions,
      can: (capability) => permissions[capability] === true,
      login,
      logout,
      error,
      loading: user === undefined,
    };
  }, [user, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
