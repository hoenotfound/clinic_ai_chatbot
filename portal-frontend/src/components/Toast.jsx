import { useCallback, useRef, useState } from "react";

const AUTO_DISMISS_MS = 6000;

const TYPE_STYLES = {
  error: "bg-[var(--color-danger-light)] text-[var(--color-danger)] border-[var(--color-danger)]/20",
  warning: "bg-[var(--color-accent-light)] text-[var(--color-accent)] border-[var(--color-accent)]/20",
  info: "bg-[var(--color-primary-light)] text-[var(--color-primary)] border-[var(--color-primary)]/20",
};

/**
 * Minimal in-app toast queue — replaces blocking `alert()` calls with a
 * dismissible, non-blocking notification that matches the rest of the UI.
 * Usage: const { toasts, showToast, dismissToast } = useToasts();
 */
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message, type = "info") => {
      const id = ++nextId.current;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
    },
    [dismissToast]
  );

  return { toasts, showToast, dismissToast };
}

export function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg animate-[fadeIn_0.15s_ease-out] ${
            TYPE_STYLES[t.type] || TYPE_STYLES.info
          }`}
        >
          <p className="flex-1 leading-snug">{t.message}</p>
          <button
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 -mt-0.5 opacity-60 hover:opacity-100 transition-opacity"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
