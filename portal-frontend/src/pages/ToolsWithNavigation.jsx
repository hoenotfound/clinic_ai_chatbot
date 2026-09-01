import { Link } from "react-router-dom";
import Tools from "./Tools";

export default function ToolsWithNavigation() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-white px-4 py-2.5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto">
          <span className="shrink-0 rounded-xl bg-[var(--color-primary-light)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)]">
            Follow-up & Lead Temperature
          </span>
          <Link
            to="/tools/lead-distribution"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--color-text)] transition hover:border-[var(--color-primary)]/30 hover:bg-[var(--color-primary-light)]/35"
          >
            <DistributionIcon className="h-4 w-4 text-[var(--color-primary)]" />
            Automatic Lead Distribution
          </Link>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Tools />
      </div>
    </div>
  );
}

function DistributionIcon(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M7.5 6.5 10.8 17M16.5 6.5 13.2 17M8 5h8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
