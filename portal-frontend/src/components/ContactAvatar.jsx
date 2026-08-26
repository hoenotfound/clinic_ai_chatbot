const CHANNEL_BADGES = {
  whatsapp: {
    label: "WhatsApp",
    background: "#25D366",
    icon: (
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39a9.9 9.9 0 0 0 4.75 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.03c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.12.11-1.8-.11a13.6 13.6 0 0 1-1.85-.68c-2.6-1.13-4.3-3.75-4.44-3.93-.13-.18-1.06-1.41-1.06-2.7 0-1.28.67-1.9.91-2.16.24-.26.52-.33.7-.33.17 0 .35 0 .5.01.16.01.38-.06.59.45.24.58.81 2 .88 2.14.07.14.12.31.02.5-.09.18-.14.29-.28.45-.14.16-.29.35-.42.47-.14.13-.28.28-.12.55.16.27.71 1.17 1.52 1.9 1.05.94 1.93 1.23 2.2 1.37.27.14.43.12.59-.07.16-.19.68-.79.86-1.06.18-.27.36-.22.6-.13.24.09 1.55.73 1.82.87.27.13.44.2.51.31.07.11.07.63-.17 1.31z" />
    ),
  },
  instagram: {
    label: "Instagram",
    background: "#E1306C",
    icon: (
      <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.24 2.23.41.55.21.95.47 1.37.89.42.42.68.82.89 1.37.17.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.24 1.8-.41 2.23-.21.55-.47.95-.89 1.37-.42.42-.82.68-1.37.89-.42.17-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.24-2.23-.41a3.7 3.7 0 0 1-1.37-.89 3.7 3.7 0 0 1-.89-1.37c-.17-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.24-1.8.41-2.23.21-.55.47-.95.89-1.37.42-.42.82-.68 1.37-.89.42-.17 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.5a6.34 6.34 0 1 0 0 12.68 6.34 6.34 0 0 0 0-12.68zm0 10.46a4.12 4.12 0 1 1 0-8.24 4.12 4.12 0 0 1 0 8.24zm6.6-10.7a1.48 1.48 0 1 1-2.97 0 1.48 1.48 0 0 1 2.97 0z" />
    ),
  },
  facebook: {
    label: "Facebook",
    background: "#0866FF",
    icon: (
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.89h2.78l-.44 2.91h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94z" />
    ),
  },
};

export default function ContactAvatar({ src, channel = "whatsapp", size = 40 }) {
  const badgeSize = Math.round(size * 0.4);
  const badge = CHANNEL_BADGES[channel];

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="w-full h-full rounded-full bg-[var(--color-border)] flex items-center justify-center overflow-hidden">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" />
        ) : (
          <svg viewBox="0 0 24 24" width="70%" height="70%" fill="var(--color-surface)" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7v1H4v-1z" />
          </svg>
        )}
      </div>
      {badge && (
        <span
          className="absolute bottom-0 right-0 rounded-full flex items-center justify-center ring-2 ring-[var(--color-surface)]"
          style={{ width: badgeSize, height: badgeSize, background: badge.background }}
          title={badge.label}
          aria-label={badge.label}
        >
          <svg viewBox="0 0 24 24" width="65%" height="65%" fill="white" aria-hidden="true">
            {badge.icon}
          </svg>
        </span>
      )}
    </div>
  );
}
