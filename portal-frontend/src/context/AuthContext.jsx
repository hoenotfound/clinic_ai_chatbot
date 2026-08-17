import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [username, setUsername] = useState(undefined); // undefined = still checking, null = logged out
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .me()
      .then((res) => setUsername(res.username))
      .catch(() => setUsername(null));
  }, []);

  async function login(u, p) {
    setError(null);
    try {
      const res = await api.login(u, p);
      setUsername(res.username);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    setUsername(null);
  }

  return (
    <AuthContext.Provider value={{ username, login, logout, error, loading: username === undefined }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
