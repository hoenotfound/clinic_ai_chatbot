import { buildFollowUpIntelligence, MIN_MATURE_SENDS, MIN_REPLIES } from "./followUpIntelligence";

export default function FollowUpIntelligence({ report }) {
  const intelligence = buildFollowUpIntelligence(report);
  return (
    <section aria-label="Follow-up intelligence" className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">Follow-up intelligence</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Read-only guidance from mature, observed outcomes. No AI-generated changes or automated optimizations.
          </p>
        </div>
        <span className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-semibold">
          {intelligence.ready ? "Enough mature reply data" : "Collecting evidence"}
        </span>
      </div>
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        {intelligence.mature} mature sends · {intelligence.replied} first replies · {intelligence.milestoneMature} mature 7-day sends
      </p>
      {intelligence.notes.length > 0 && (
        <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3" aria-label="Data quality and sample-size notices">
          {intelligence.notes.map(note => <p className="text-xs leading-5" key={note}>{note}</p>)}
        </div>
      )}
      {intelligence.total > 0 && (
        <>
        <p className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs font-semibold leading-5">Comparison rates are observational only, not reliable winners or recommendations to change follow-up timing or messages. Customer mix and sample variation can explain differences.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {intelligence.insights.map(insight => (
            <div key={insight.dimension} className="rounded-lg border border-[var(--color-border)] p-3">
              <h4 className="text-xs font-semibold">{insight.title}</h4>
              {insight.groups.length >= 2 && (
                <div className="mt-2 space-y-1 text-xs">
                  {insight.groups.map(group => (
                    <p key={group.label}>
                      <strong>{group.label}</strong>: {group.rate}% ({group.replied}/{group.mature} mature sends)
                    </p>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">{insight.note}</p>
            </div>
          ))}
        </div>
        </>
      )}
      <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">
        Minimum per comparison group: {MIN_MATURE_SENDS} complete 72-hour sends and {MIN_REPLIES} first replies.
        These associations do not establish causality. Keep current sending times, messages, quiet hours,
        consent and strict RM0 safeguards unchanged. Use controlled A/B tests before adopting changes.
      </p>
    </section>
  );
}
