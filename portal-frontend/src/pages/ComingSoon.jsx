export default function ComingSoon({ title, description }) {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-primary-light)] mb-5">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3"/>
          </svg>
        </div>
        <h2 className="font-display text-xl font-bold text-[var(--color-text)] mb-2">{title}</h2>
        <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
