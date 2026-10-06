import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useToasts, ToastContainer } from "../components/Toast";
import Spinner from "../components/Spinner";

function supportsWebPush() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isIosBrowserMode() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;

  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIos) return false;

  const standalone =
    navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return !standalone;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function sameApplicationServerKey(subscription, publicKey) {
  const storedKey = subscription?.options?.applicationServerKey;
  if (!storedKey || !publicKey) return true;

  const current = new Uint8Array(storedKey);
  const expected = urlBase64ToUint8Array(publicKey);
  if (current.length !== expected.length) return false;
  return current.every((value, index) => value === expected[index]);
}

function StatusPill({ enabled }) {
  return (
    <span
      className={
        enabled
          ? "inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
          : "inline-flex items-center rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text-muted)]"
      }
    >
      {enabled ? "Enabled on this device" : "Off on this device"}
    </span>
  );
}

export default function Notifications() {
  const { toasts, showToast, dismissToast } = useToasts();
  const supported = useMemo(supportsWebPush, []);
  const iosBrowserMode = useMemo(isIosBrowserMode, []);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [staleKey, setStaleKey] = useState(false);

  const permission =
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const enabled =
    Boolean(subscription) &&
    permission === "granted" &&
    status?.configured === true &&
    !staleKey;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!supported) {
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        const serverStatus = await api.getWebPushStatus();
        const registration = await navigator.serviceWorker.ready;
        const localSubscription = await registration.pushManager.getSubscription();
        const keyIsStale =
          Boolean(localSubscription) &&
          Boolean(serverStatus.publicKey) &&
          !sameApplicationServerKey(localSubscription, serverStatus.publicKey);

        if (!cancelled) {
          setStatus(serverStatus);
          setSubscription(localSubscription);
          setStaleKey(keyIsStale);
        }

        if (
          localSubscription &&
          !keyIsStale &&
          serverStatus.configured &&
          Notification.permission === "granted"
        ) {
          await api.saveWebPushSubscription(localSubscription.toJSON());
        }
      } catch (err) {
        if (!cancelled) {
          showToast(err.message || "Couldn't load notification settings.", "error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [showToast, supported]);

  async function handleEnable() {
    if (!supported || !status?.configured || !status.publicKey) return;

    setWorking(true);
    try {
      // Keep this permission request directly inside the button action. iPhone
      // requires notification permission to be requested from a user gesture.
      const nextPermission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();

      if (nextPermission !== "granted") {
        throw new Error(
          nextPermission === "denied"
            ? "Notifications are blocked for this app. Allow them in your phone's notification settings."
            : "Notification permission was not granted."
        );
      }

      const registration = await navigator.serviceWorker.ready;
      let nextSubscription = await registration.pushManager.getSubscription();

      if (
        nextSubscription &&
        !sameApplicationServerKey(nextSubscription, status.publicKey)
      ) {
        await nextSubscription.unsubscribe();
        nextSubscription = null;
      }

      if (!nextSubscription) {
        nextSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.publicKey),
        });
      }

      await api.saveWebPushSubscription(nextSubscription.toJSON());
      setSubscription(nextSubscription);
      setStaleKey(false);
      showToast("Notifications enabled on this device.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't enable notifications.", "error");
    } finally {
      setWorking(false);
    }
  }

  async function handleDisable() {
    if (!subscription) return;

    setWorking(true);
    try {
      await api.deleteWebPushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
      setSubscription(null);
      setStaleKey(false);
      if ("clearAppBadge" in navigator) {
        await navigator.clearAppBadge().catch(() => {});
      }
      showToast("Notifications disabled on this device.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't disable notifications.", "error");
    } finally {
      setWorking(false);
    }
  }

  async function handleTest() {
    if (!subscription) return;

    setWorking(true);
    try {
      await api.sendWebPushTest(subscription.endpoint);
      showToast("Test notification sent to this device.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't send the test notification.", "error");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)] px-3.5 py-5 sm:px-6 sm:py-7 lg:px-8">
      <div className="mx-auto w-full max-w-2xl pb-10">
        <div className="mb-5">
          <h1 className="font-display text-2xl font-bold">Notifications</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-text-muted)]">
            Enable important DA CHATBOT alerts on this phone or computer.
          </p>
        </div>

        <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm sm:p-7">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center">
              <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Push notifications</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                    This setting applies only to this device.
                  </p>
                </div>
                <StatusPill enabled={enabled} />
              </div>

              <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                <p className="text-sm font-semibold">You will be notified for</p>
                <div className="mt-3 space-y-2.5 text-sm">
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden="true">✓</span>
                    <span><strong>Booking Ready</strong> when a customer is ready for staff to confirm a booking.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden="true">✓</span>
                    <span><strong>Needs Human Attention</strong> when the AI hands a conversation to staff.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden="true">✓</span>
                    <span><strong>Delivery Failed</strong> when a WhatsApp message needs staff action after automatic retry handling.</span>
                  </div>
                </div>
                <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs font-medium leading-relaxed text-[var(--color-text-muted)]">
                  Ordinary new customer messages do not send push notifications.
                </p>
              </div>

              {!supported && (
                <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                  This browser does not support Web Push notifications. Try the installed Home Screen app or an up-to-date browser.
                </div>
              )}

              {supported && iosBrowserMode && (
                <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                  On iPhone or iPad, open DA CHATBOT from its Home Screen icon before enabling notifications.
                </div>
              )}

              {supported && status?.configured === false && (
                <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                  Web Push has not been configured on this client deployment yet. Add the VAPID environment variables in Render, then redeploy.
                </div>
              )}

              {permission === "denied" && (
                <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                  Notifications are blocked by the device. Re-enable notification permission in the phone or browser settings, then return here.
                </div>
              )}

              {staleKey && (
                <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                  The server notification key changed. Tap Enable again to refresh this device.
                </div>
              )}

              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
                {enabled ? (
                  <>
                    <button
                      type="button"
                      onClick={handleTest}
                      disabled={working}
                      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                    >
                      {working ? "Working…" : "Send test notification"}
                    </button>
                    <button
                      type="button"
                      onClick={handleDisable}
                      disabled={working}
                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
                    >
                      Disable on this device
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleEnable}
                    disabled={
                      working ||
                      !supported ||
                      iosBrowserMode ||
                      status?.configured !== true ||
                      permission === "denied"
                    }
                    className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {working ? "Enabling…" : "Enable notifications on this device"}
                  </button>
                )}
              </div>

              <p className="mt-5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Tapping an alert opens the related Inbox conversation. Notification permission is controlled by the device and can also be changed in system settings.
              </p>
            </>
          )}
        </section>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
