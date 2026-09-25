import Sidebar from "./Sidebar";

export default function Layout({ children }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 h-dvh overflow-hidden">{children}</main>
    </div>
  );
}
