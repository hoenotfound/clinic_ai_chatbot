import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";

const MODEL_LABELS = {
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
};

function resultLabel(item) {
  if (item.status === "ready") return "OK";
  if (item.failureKind === "quota_exhausted") return "QUOTA EXHAUSTED";
  if (item.failureKind === "rate_limit") return "RATE LIMIT";
  if (item.failureKind === "timeout") return "TIMEOUT";
  if (item.status === "invalid") return "INVALID KEY";
  if (item.httpStatus === 503 || item.providerStatus === "UNAVAILABLE") return "503 UNAVAILABLE";
  return String(item.httpStatus || item.providerStatus || item.failureKind || item.status || "FAILED").toUpperCase();
}

function resultTone(item) {
  if (item.status === "ready") {
    return "bg-[var(--color-primary-light)] text-[var(--color-primary)]";
  }
  if (item.failureKind === "timeout" || item.httpStatus === 503 || item.providerStatus === "UNAVAILABLE") {
    return "bg-[var(--color-accent-light)] text-[var(--color-text)]";
  }
  return "bg-[var(--color-danger-light)] text-[var(--color-danger)]";
}

function durationLabel(ms) {
  const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function DiagnosticResult({ item }) {
  if (!item) return <span className="text-[10px] text-[var(--color-text-muted)]">Not tested</span>;
  return (
    <div className="space-y-1">
      <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${resultTone(item)}`}>
        {resultLabel(item)}
      </span>
      <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">
        {item.latencyMs}ms
        {item.status === "ready" && item.totalTokens ? ` · ${item.totalTokens} token${item.totalTokens === 1 ? "" : "s"}` : ""}
      </p>
    </div>
  );
}

export default function GeminiDiagnosticPanel() {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    api.getGeminiDiagnosticStatus()
      .then((payload) => {
        if (!cancelled) setStatus(payload);
      })
      .catch(() => {
        // The button can still try the protected endpoint; avoid turning a
        // harmless status-read failure into a Setup Status page error.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!status?.inFlight || running) return undefined;

    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const payload = await api.getGeminiDiagnosticStatus();
        if (!cancelled) {
          setStatus(payload);
          setNowMs(Date.now());
        }
      } catch {
        // Keep the last known protected status. The server still enforces the
        // in-flight lock and cooldown if the user tries again later.
      }
    };

    const timer = window.setInterval(refreshStatus, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.inFlight, running]);

  const remainingMs = status?.nextAllowedAt
    ? Math.max(0, new Date(status.nextAllowedAt).getTime() - nowMs)
    : Math.max(0, Number(status?.remainingMs) || 0);

  useEffect(() => {
    if (remainingMs <= 0) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [remainingMs]);

  const rows = useMemo(() => {
    const byKey = new Map();
    for (const item of result?.results || []) {
      if (!byKey.has(item.label)) {
        byKey.set(item.label, { label: item.label, fingerprint: item.fingerprint, models: {} });
      }
      byKey.get(item.label).models[item.model] = item;
    }
    return [...byKey.values()];
  }, [result]);

  const cooldownLabel = durationLabel(remainingMs);
  const disabled = running || status?.inFlight || remainingMs > 0;

  async function runDiagnostic() {
    if (disabled) return;
    const confirmed = window.confirm(
      "Run the Gemini model diagnostic?\n\nThis sends up to 10 real Gemini generation requests (5 keys × 2 models) and uses project RPM/RPD quota. Run it while chatbot traffic is quiet. It does not change runtime key health or routing."
    );
    if (!confirmed) return;

    setRunning(true);
    setError("");
    try {
      const payload = await api.runGeminiDiagnostic();
      setResult(payload);
      setStatus(payload.diagnosticStatus || null);
      setNowMs(Date.now());
    } catch (err) {
      setError(err.message || "Couldn't run the Gemini model diagnostic.");
      if (err.diagnosticStatus) {
        setStatus(err.diagnosticStatus);
        setNowMs(Date.now());
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-[var(--color-text)]">Real Gemini model test</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--color-text-muted)]">
            Manually tests the production reply chain: Gemini 3.8 Flash first, then Gemini 3.5 Flash-Lite, across up to 5 configured keys. This is separate from Run all checks.
          </p>
        </div>
        <button
          type="button"
          onClick={runDiagnostic}
          disabled={disabled}
          aria-busy={running}
          className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-[11px] font-bold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-55"
        >
          {running ? <Spinner className="h-3.5 w-3.5" /> : null}
          {running
            ? "Testing…"
            : status?.inFlight
              ? "Already running"
              : cooldownLabel
                ? `Available in ${cooldownLabel}`
                : "Test Gemini models"}
        </button>
      </div>

      <div className="mt-2 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--color-accent-light)] px-2.5 py-2 text-[10px] leading-4 text-[var(--color-text)]">
        Uses up to 10 real requests and can consume RPM/RPD quota. A server-side 10-minute cooldown prevents accidental repeated runs. Run while customer traffic is quiet.
      </div>

      {error && (
        <div role="alert" className="mt-2 rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] px-2.5 py-2 text-[10px] leading-4 text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2.5">
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-white">
            <table className="w-full min-w-[470px] border-collapse text-left">
              <thead className="bg-[var(--color-bg)] text-[10px] font-bold text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-2.5 py-2">Key</th>
                  <th className="px-2.5 py-2">Gemini 3.8 Flash</th>
                  <th className="px-2.5 py-2">Gemini 3.5 Flash-Lite</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-t border-[var(--color-border)]/70 align-top">
                    <td className="px-2.5 py-2.5">
                      <p className="text-[10px] font-bold text-[var(--color-text)]">{row.label}</p>
                      <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">{row.fingerprint}</p>
                    </td>
                    <td className="px-2.5 py-2.5"><DiagnosticResult item={row.models["gemini-3.8-flash"]} /></td>
                    <td className="px-2.5 py-2.5"><DiagnosticResult item={row.models["gemini-3.5-flash-lite"]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-1 text-[10px] leading-4 text-[var(--color-text-muted)] sm:grid-cols-2">
            <p>{result.successfulRequests}/{result.requestsAttempted} attempted requests succeeded.</p>
            <p>{result.totalTokens} token{result.totalTokens === 1 ? "" : "s"} reported by completed responses.</p>
            {result.rateLimitedRequests > 0 && <p>{result.rateLimitedRequests} rate-limit result{result.rateLimitedRequests === 1 ? "" : "s"}.</p>}
            {result.quotaExhaustedRequests > 0 && <p className="font-semibold text-[var(--color-danger)]">{result.quotaExhaustedRequests} quota-exhausted result{result.quotaExhaustedRequests === 1 ? "" : "s"}.</p>}
          </div>

          {result.stoppedEarly && (
            <p className="rounded-lg bg-[var(--color-accent-light)] px-2.5 py-2 text-[10px] leading-4 text-[var(--color-text)]">
              Stopped after {result.requestsAttempted}/{result.plannedRequests} planned requests because a request timed out. {result.remainingRequests} later request{result.remainingRequests === 1 ? " was" : "s were"} not started.
            </p>
          )}

          {(result.warnings || []).length > 0 && (
            <div className="space-y-1 rounded-lg bg-white px-2.5 py-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
              {result.warnings.map((warning) => <p key={warning}>• {warning}</p>)}
            </div>
          )}
        </div>
      )}

      <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
        The test never exposes API-key values and does not change the active Gemini key, runtime key cooldowns, model cooldowns, or normal AI usage history.
      </p>
    </div>
  );
}
