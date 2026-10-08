import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import Spinner from "./Spinner";
import {
  buildWhatsAppBusinessAppLoginOptions,
  loadMetaSdk,
  parseWhatsAppEmbeddedSignupMessage,
} from "../utils/whatsappEmbeddedSignup";
import {
  createWhatsAppEmbeddedSignupAttempt,
  expireWhatsAppSignupAttempt,
  receiveWhatsAppSignupAuthorization,
  receiveWhatsAppSignupMessage,
} from "../utils/whatsappEmbeddedSignupAttempt";

const META_COMPLETION_WAIT_MS = 12000;

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
  const activeAttemptRef = useRef(null);
  const nextAttemptIdRef = useRef(0);
  const submittingRef = useRef(false);
  const completionTimerRef = useRef(null);

  const clearCompletionTimer = useCallback(() => {
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  }, []);

  const loadConfig = useCallback(async ({ preserveError = false } = {}) => {
    setLoading(true);
    if (!preserveError) setError("");
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
    return () => {
      activeAttemptRef.current = null;
      clearCompletionTimer();
    };
  }, [loadConfig, clearCompletionTimer]);

  const handleOutcome = useCallback((attempt, outcome) => {
    if (activeAttemptRef.current !== attempt || outcome.kind === "ignored") return;
    clearCompletionTimer();

    if (outcome.kind === "waiting") {
      setStage(
        attempt.code
          ? "Meta authorization received. Waiting for the Business App completion event…"
          : "Meta reported a signup completion. Waiting for the authorization code…"
      );
      completionTimerRef.current = window.setTimeout(() => {
        if (activeAttemptRef.current !== attempt) return;
        const expired = expireWhatsAppSignupAttempt(attempt);
        handleOutcome(attempt, expired);
      }, META_COMPLETION_WAIT_MS);
      return;
    }

    // A completed, cancelled or timed-out attempt must not consume late events
    // from that attempt. Neither of the non-coexistence outcomes reaches the API.
    activeAttemptRef.current = null;

    if (outcome.kind === "coexistence") {
      submittingRef.current = true;
      setConnecting(true);
      setNotice("");
      setError("");
      setStage("Meta finished Business App onboarding. Validating the authorization…");
      void (async () => {
        try {
          const completed = await api.completeWhatsAppCoexistenceOnboarding({
            code: outcome.code,
            nonce: outcome.nonce,
            sessionInfo: outcome.sessionInfo,
          });
          setResult(completed);
          setStage("Authorization validated. Nothing has been activated yet.");
        } catch (err) {
          setError(err.message || "WhatsApp coexistence onboarding could not be validated.");
          setStage("");
          void loadConfig({ preserveError: true });
        } finally {
          submittingRef.current = false;
          setConnecting(false);
        }
      })();
      return;
    }

    setConnecting(false);
    setStage("");

    if (outcome.kind === "standard") {
      setError("");
      setNotice("standard");
      return;
    }
    if (outcome.kind === "unconfirmed") {
      setError("");
      setNotice("unconfirmed");
      return;
    }

    setNotice("");
    if (outcome.kind === "missing_code") {
      setError(
        outcome.cancelled
          ? "Meta login was cancelled or blocked. No authorization code was received."
          : "Meta did not provide an authorization code. This signup is not connected. Check the Meta popup and try again."
      );
    } else if (outcome.kind === "conflict") {
      setError("Meta sent conflicting signup completion events. Nothing was connected. Close other Meta signup popups before trying again.");
    } else if (outcome.kind === "error") {
      setError(outcome.message || "Meta reported an error during WhatsApp Embedded Signup.");
    } else if (outcome.kind === "cancel") {
      setError("WhatsApp Embedded Signup was cancelled before completion.");
    }
  }, [loadConfig, clearCompletionTimer]);

  useEffect(() => {
    function onMessage(event) {
      const attempt = activeAttemptRef.current;
      if (!attempt || submittingRef.current) return;

      const payload = parseWhatsAppEmbeddedSignupMessage(event);
      if (!payload) return;
      handleOutcome(attempt, receiveWhatsAppSignupMessage(attempt, payload));
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleOutcome]);

  function launchSignup() {
    if (!config?.configured || !sdkReady || !window.FB?.login || connecting || submittingRef.current) return;
    if (!nonceRef.current) {
      setError("This signup session has expired. Reload Setup Status before trying again.");
      return;
    }

    clearCompletionTimer();
    const attempt = createWhatsAppEmbeddedSignupAttempt(
      ++nextAttemptIdRef.current,
      nonceRef.current
    );
    activeAttemptRef.current = attempt;
    setError("");
    setNotice("");
    setResult(null);
    setConnecting(true);
    setStage("Complete the Meta popup using the existing WhatsApp Business app number.");

    try {
      window.FB.login(
        (response) => {
          // This closure belongs to one launch; callbacks from previous popup
          // attempts cannot complete or overwrite the current attempt.
          if (activeAttemptRef.current !== attempt) return;
          handleOutcome(attempt, receiveWhatsAppSignupAuthorization(attempt, response));
        },
        buildWhatsAppBusinessAppLoginOptions(config)
      );
    } catch (err) {
      if (activeAttemptRef.current === attempt) {
        activeAttemptRef.current = null;
        clearCompletionTimer();
        setConnecting(false);
        setStage("");
        setError(err.message || "Meta Embedded Signup could not be launched.");
      }
    }
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
              ? "Meta reported a standard Cloud API signup"
              : "Meta authorization received, but coexistence not confirmed"}
          </p>
          <p className="mt-1">
            {notice === "standard"
              ? "Meta reported a standard Cloud API signup, not Business App coexistence. This screen has not exchanged the code, verified the WABA, or connected the number to DA Chatbot. For a new number, use the regular WhatsApp Cloud API setup to verify and configure its WABA, phone number and token. To use coexistence, first use an eligible number active in the WhatsApp Business mobile app."
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
