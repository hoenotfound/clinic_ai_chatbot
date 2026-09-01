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
            <span className="rounded-full bg-[#25D366]/10 px-2.5 py-1 font-semibold text-[#128C7E]">
              WhatsApp only
            </span>
            <p className="leading-5 text-[var(--color-text-muted)]">
              Automated follow-ups are currently sent only to WhatsApp conversations. Instagram and Facebook leads are not included.
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
