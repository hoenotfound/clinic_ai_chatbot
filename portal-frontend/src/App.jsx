import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Inbox from "./pages/Inbox";
import Settings from "./pages/Settings";
import ComingSoon from "./pages/ComingSoon";

function ProtectedRoute({ children }) {
  const { username, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      </div>
    );
  }
  if (!username) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/inbox"
            element={
              <ProtectedRoute>
                <Inbox />
              </ProtectedRoute>
            }
          />
          <Route
            path="/contacts"
            element={
              <ProtectedRoute>
                <ComingSoon
                  title="Contacts"
                  description="A full patient directory — profiles, history, and notes across every conversation — is coming in the next build phase."
                />
              </ProtectedRoute>
            }
          />
          <Route
            path="/pipeline"
            element={
              <ProtectedRoute>
                <ComingSoon
                  title="Pipeline"
                  description="Track leads from first message through to booked and converted patients. Coming in the next build phase."
                />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
