import { createContext, useContext, useMemo } from "react";
import { useAuth } from "./AuthContext";

const BusinessConfigContext = createContext({
  config: null,
  loading: true,
  error: null,
  refresh: async () => null,
});

export function BusinessConfigProvider({ children }) {
  const { user, loading, refreshUser } = useAuth();
  const config = user?.businessProfile || null;

  const value = useMemo(
    () => ({
      config,
      loading,
      error: null,
      refresh: refreshUser,
    }),
    [config, loading, refreshUser]
  );

  return (
    <BusinessConfigContext.Provider value={value}>
      {children}
    </BusinessConfigContext.Provider>
  );
}

export function useBusinessConfig() {
  return useContext(BusinessConfigContext);
}
