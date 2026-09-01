import { useSearchParams } from "react-router-dom";
import Tools from "./Tools";

export default function ToolsRoute() {
  const [searchParams] = useSearchParams();
  const selectedTool = searchParams.get("tool");
  const isFollowUpSelected =
    selectedTool !== "lead-temperature" && selectedTool !== "lead-distribution";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isFollowUpSelected && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-white px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <span className="rounded-full bg-[var(--color-surface-muted)] px-2.5 py-1 font-semibold text-[var(--color-text)]">
              WhatsApp · Messenger · Instagram
            </span>
            <p className="leading-5 text-[var(--color-text-muted)]">
              Follow-ups use the same settings on all three channels and send only while the customer conversation is still inside Meta&apos;s 24-hour messaging window.
            </p>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Tools />
      </div>
    </div>
  );
}
