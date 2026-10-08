import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";
import {
  buildWhatsAppBusinessAppLoginOptions,
  classifyWhatsAppEmbeddedSignupEvent,
  loadMetaSdk,
  parseWhatsAppEmbeddedSignupMessage,
} from "../utils/whatsappEmbeddedSignup";

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function MatchBadge({ matched, children }) {
  return (
    <span
      className={
        matched
          ? "rounded-full bg-[var(--color-primary-light)] px-2 py-1 text-[10px] font-bold text-[var(--color-primary)]"
          : "rounded-full bg-[var(--color-accent-light)] px-2 py-1 text-[10px] font-bold text-[var(--color-text)]"
      }
    >
      {children}
    </span>
  );
}

export default function WhatsAppCoexistenceOnboardingPanel() {
  const [config, setConfig] = useState(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(null);

  const nonceRef = useRef(null);
  const codeRef = useRef(null);
  const sessionInfoRef = useRef(null);
  const submittingRef = useRef(false);
  const standardSignupRef = useRef(false);
  const completionTimerRef = useRef(null);

  const clearCompletionTimer = useCallback(() => {
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api.getWhatsAppCoexistenceOnboardingConfig();
      setConfig(next);
      nonceRef.current = next.nonce;
      setSdkReady(false);
      if (next.appId) {
        await loadMetaSdk(next);
        setSdkReady(true);
      }
    } catch (err) {
      setError(err.message || "Couldn't load WhatsApp coexistence onboarding.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    return () => clearCompletionTimer();
  }, [loadConfig, clearCompletionTimer]);

  const completeIfReady = useCallback(async () => {
    const code = codeRef.current;
    const sessionInfo = sessionInfoRef.current;
    const nonce = nonceRef.current;
    if (!code || !sessionInfo || !nonce || submittingRef.current) return;

    submittingRef.current = true;
    setConnecting(true);
    setStage("Validating the authorized WhatsApp Business account…");
    setError("");

    try {
      const completed = await api.completeWhatsAppCoexistenceOnboarding({
        code,
        nonce,
        sessionInfo,
      });
      setResult(completed);
      setNotice("");
      setStage("Authorization validated. Nothing has been activated yet.");
      clearCompletionTimer();
    } catch (err) {
      setError(err.message || "WhatsApp coexistence onboarding could not be validated.");
      setStage("");
      void loadConfig();
    } finally {
      submittingRef.current = false;
      setConnecting(false);
    }
  }, [loadConfig, clearCompletionTimer]);

  useEffect(() => {
    function onMessage(event) {
      const payload = parseWhatsAppEmbeddedSignupMessage(event);
      if (!payload) return;

      const outcome = classifyWhatsAppEmbeddedSignupEvent(payload);

      if (outcome === "coexistence") {
        standardSignupRef.current = false;
        sessionInfoRef.current = payload;
        setNotice("");
        setStage("Meta finished Business App onboarding. Securing the authorization…");
        void completeIfReady();
        return;
      }

      if (outcome === "standard") {
        // A normal Cloud API signup may also return an authorization code.
        // Never submit that code as a Business App coexistence authorization.
        if (sessionInfoRef.current || submittingRef.current) return;
        standardSignupRef.current = true;
        clearCompletionTimer();
        setConnecting(false);
        setStage("");
        setError("");
        setNotice("standard");
        return;
      }

      if (outcome === "error" || outcome === "cancel") {
        clearCompletionTimer();
        setConnecting(false);
        setStage("");
        setNotice("");
        setError(
          outcome === "error"
            ? payload.data?.error_message || "Meta reported an error during WhatsApp Embedded Signup."
            : "WhatsApp Embedded Signup was cancelled before completion."
        );
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [completeIfReady, clearCompletionTimer]);

  function launchSignup() {
    if (!config?.configured || !sdkReady || !window.FB?.login || connecting) return;

    clearCompletionTimer();
    setError("");
    setNotice("");
    setResult(null);
    setConnecting(true);
    setStage("Complete the Meta popup using the existing WhatsApp Business app number.");
    codeRef.current = null;
    sessionInfoRef.current = null;
    standardSignupRef.current = false;
    submittingRef.current = false;

    window.FB.login(
      (response) => {
        // Meta's postMessage can arrive before the FB.login callback.
        if (standardSignupRef.current) return;
        const code = response?.authResponse?.code;
        if (!code) {
          setConnecting(false);
          setStage("");
          setError(
            response?.status === "unknown"
              ? "Meta login was cancelled, blocked, or did not finish."
              : "Meta did not return an Embedded Signup authorization code."
          );
          return;
        }

        codeRef.current = code;
        setStage("Meta authorization received. Waiting for the Business App completion event…");
        void completeIfReady();

        clearCompletionTimer();
        completionTimerRef.current = window.setTimeout(() => {
          completionTimerRef.current = null;
          if (!sessionInfoRef.current && !submittingRef.current && !standardSignupRef.current) {
            setConnecting(false);
            setStage("");
            setError("");
            setNotice("unconfirmed");
          }
        }, 12000);
      },
      buildWhatsAppBusinessAppLoginOptions(config)
    );
  }

  const latest = result?.attempt || config?.latestAttempt || null;
  const missing = config?.missing || [];

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-bold sm:text-lg">
              WhatsApp Business App coexistence
            </h2>
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
              Authorization only
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[var(--color-text-muted)]">
            Connect an existing WhatsApp Business app number through Meta Embedded Signup.
            This step validates the WABA and phone number only. It does not register the
            number, change runtime credentials, enable coexistence, or move the live webhook.
          </p>
        </div>

        <button
          type="button"
          onClick={launchSignup}
          disabled={loading || connecting || !config?.configured || !sdkReady}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading || connecting ? <Spinner className="h-4 w-4" /> : null}
          {connecting
            ? "Connecting…"
            : sdkReady
              ? "Connect existing WhatsApp app"
              : "Loading Meta…"}
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs leading-5 text-[var(--color-text)]">
        <p className="font-semibold">Already using the WhatsApp Business mobile app?</p>
        <p className="mt-1">
          Coexistence is only for an eligible number already active in the WhatsApp Business app.
          If you purchased a new number, including a virtual number, and entered it directly into
          Meta, use standard WhatsApp Cloud API setup instead. This panel cannot activate a new
          number or turn a standard signup into coexistence.
        </p>
      </div>

      {!loading && !config?.configured && (
        <div className="mt-4 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] p-3 text-xs leading-5 text-[var(--color-text)]">
          Embedded Signup is not ready on this deployment. Configure:{" "}
          <span className="font-semibold">
            {missing.join(", ") || "Meta Embedded Signup settings"}
          </span>.
        </div>
      )}

      {stage && (
        <div className="mt-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)] p-3 text-xs leading-5 text-[var(--color-text)]">
          {stage}
        </div>
      )}

      {notice && (
        <div role="status" className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs leading-5 text-[var(--color-text)]">
          <p className="font-semibold">
            {notice === "standard"
              ? "Standard WhatsApp Cloud API signup completed"
              : "Meta authorization received, but coexistence not confirmed"}
          </p>
          <p className="mt-1">
            {notice === "standard"
              ? "Meta completed a standard Cloud API signup, not WhatsApp Business App coexistence. For a new number, continue with the regular WhatsApp Cloud API setup using its WABA and phone credentials. To use coexistence, first use an eligible number already active in the WhatsApp Business mobile app."
              : "No WhatsApp Business App completion event reached this page. If you used a new number, follow regular Cloud API setup. If the number was already active in the WhatsApp Business app, check the Embedded Signup configuration and try again only after confirming eligibility."}
          </p>
          <p className="mt-1 font-medium">
            Do not enable coexistence or switch the live WhatsApp credentials from this result.
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger-light)] p-3 text-xs leading-5 text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
              Authorized WABA
            </p>
            <p className="mt-1 text-sm font-semibold">
              {result.waba?.name || "WhatsApp Business Account"}
            </p>
            <p className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]">
              {result.waba?.id}
            </p>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
                Business App number
              </p>
              <MatchBadge matched={result.phone?.coexistenceReady}>
                {result.phone?.coexistenceReady ? "Coexistence confirmed" : "Meta status pending"}
              </MatchBadge>
            </div>
            <p className="mt-1 text-sm font-semibold">
              {result.phone?.displayPhoneNumber || result.phone?.verifiedName || "Phone number"}
            </p>
            <p className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]">
              {result.phone?.id}
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <p className="text-xs font-bold">Runtime is still unchanged</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <MatchBadge matched={result.runtime?.wabaMatches}>
              WABA {result.runtime?.wabaMatches ? "matches runtime" : "needs runtime update"}
            </MatchBadge>
            <MatchBadge matched={result.runtime?.phoneMatches}>
              Phone ID {result.runtime?.phoneMatches ? "matches runtime" : "needs runtime update"}
            </MatchBadge>
            <MatchBadge matched={result.runtime?.coexistenceEnabled}>
              Coexistence flag {result.runtime?.coexistenceEnabled ? "enabled" : "still off"}
            </MatchBadge>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
            Next, update the client runtime credentials deliberately, verify the selected number,
            then enable coexistence and configure its WABA callback. Do not use the normal phone
            registration step for this Business App number.
          </p>
        </div>
      )}

      {latest && !result && (
        <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-bold">Latest authorization attempt</p>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {formatTime(latest.createdAt)}
            </span>
          </div>
          <p className="mt-1 text-[var(--color-text-muted)]">
            {latest.status === "validated"
              ? (latest.displayPhoneNumber || latest.phoneNumberId || "WhatsApp number") + " validated."
              : latest.errorMessage || "The last Embedded Signup attempt failed."}
          </p>
        </div>
      )}
    </section>
  );
}
