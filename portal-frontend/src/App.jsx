import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Inbox from "./pages/Inbox";
import Contacts from "./pages/Contacts";
import Settings from "./pages/Settings";
import TeamAccess from "./pages/TeamAccess";
import Tools from "./pages/Tools";
import LeadDistribution from "./pages/LeadDistribution";
import Pipeline from "./pages/Pipeline";
import Analytics from "./pages/Analytics";

function homeForPermissions(permissions = {}) {
  if (permissions.view_all_leads || permissions.view_assigned_leads) return "/inbox";
  if (permissions.view_analytics) return "/analytics";
  if (permissions.manage_tools) return "/tools";
  if (permissions.manage_settings) return "/settings";
  if (permissions.manage_users) return "/settings/team";
  return "/no-access";
}

function ProtectedRoute({ children, anyCapabilities = [] }) {
  const { username, permissions, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      </div>
    );
  }

  if (!username) return <Navigate to="/login" replace />;

  if (anyCapabilities.length > 0 && !anyCapabilities.some((capability) => permissions[capability])) {
    return <Navigate to={homeForPermissions(permissions)} replace />;
  }

  return <Layout>{children}</Layout>;
}

function DefaultRoute() {
  const { username, permissions, loading } = useAuth();
  if (loading) return null;
  if (!username) return <Navigate to="/login" replace />;
  return <Navigate to={homeForPermissions(permissions)} replace />;
}

function NoAccess() {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-light)] text-xl text-[var(--color-primary)]">🔒</div>
        <h1 className="mt-4 font-display text-xl font-bold">No portal access enabled</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
          Your account is active, but no portal capabilities are currently enabled. Ask an administrator to update your access.
        </p>
      </div>
    </div>
  );
}

const LEAD_VIEW = ["view_assigned_leads", "view_all_leads"];

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route path="/inbox" element={<ProtectedRoute anyCapabilities={LEAD_VIEW}><Inbox /></ProtectedRoute>} />
          <Route path="/contacts" element={<ProtectedRoute anyCapabilities={LEAD_VIEW}><Contacts /></ProtectedRoute>} />
          <Route path="/pipeline" element={<ProtectedRoute anyCapabilities={LEAD_VIEW}><Pipeline /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute anyCapabilities={["view_analytics"]}><Analytics /></ProtectedRoute>} />
          <Route path="/tools" element={<ProtectedRoute anyCapabilities={["manage_tools"]}><Tools /></ProtectedRoute>} />
          <Route path="/tools/lead-distribution" element={<ProtectedRoute anyCapabilities={["manage_tools"]}><LeadDistribution /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute anyCapabilities={["manage_settings"]}><Settings /></ProtectedRoute>} />
          <Route path="/settings/team" element={<ProtectedRoute anyCapabilities={["manage_users"]}><TeamAccess /></ProtectedRoute>} />
          <Route path="/no-access" element={<ProtectedRoute><NoAccess /></ProtectedRoute>} />

          <Route path="*" element={<DefaultRoute />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
