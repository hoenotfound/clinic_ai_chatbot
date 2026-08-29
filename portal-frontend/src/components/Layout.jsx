import Sidebar from "./Sidebar";
import InboxContactDetailsHost from "./InboxContactDetailsHost";

export default function Layout({ children }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 h-screen overflow-hidden">{children}</main>
      <InboxContactDetailsHost />
    </div>
  );
}
