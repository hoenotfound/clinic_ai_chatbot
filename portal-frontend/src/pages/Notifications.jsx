import { useEffect, useState } from "react";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushNotificationState,
  isAndroidDevice,
  isIosDevice,
  isStandaloneWebApp,
  sendPushTestNotification,
} from "../utils/pushNotifications";

export default function Notifications() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toasts, showToast, dismissToast } = useToasts();
  const standalone = isStandaloneWebApp();
  const android = isAndroidDevice();
  const ios = isIosDevice();

  async function refresh() {
    try {
      setState(await getPushNotificationState());
    } catch (err) {
      showToast(err.message || "Couldn't check notification status.", "error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function enable() {
    setBusy(true);
    try {
      await enablePushNotifications();
      await refresh();
      showToast("Notifications enabled on this device.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't enable notifications.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await disablePushNotifications();
      await refresh();
      showToast("Notifications disabled on this device.", "info");
    } catch (err) {
      await refresh();
      showToast(
        err.message || "Notifications were stopped locally, but server cleanup may need another try.",
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const result = await sendPushTestNotification();
      if (!result.ok) {
        showToast("The test notification could not be delivered.", "error");
      } else {
        showToast("Test notification sent to this device.", "info");
      }
    } catch (err) {
      showToast(err.message || "Couldn't send the test notification.", "error");
    } finally {
      setBusy(false);
    }
  }

  const enabled = state?.subscribed && state?.permission === "granted";
  const blocked = state?.permission === "denied";

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)] px-3.5 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-3xl pb-8">
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:rounded-3xl sm:p-6 lg:p-7">
          <div className="mb-5 sm:mb-6">
            <h1 className="font-display text-lg font-bold sm:text-xl">Notifications</h1>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)] sm:text-sm">
              Phone notifications for important staff-action events. Normal new customer messages are intentionally excluded.
            </p>
          </div>

          {!state ? (
            <div className="flex min-h-24 items-center justify-center">
              <Spinner className="h-5 w-5 text-[var(--color-text-muted)]" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-bold">Push notifications on this device</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                      {enabled
                        ? "Enabled. Alerts can arrive even when the portal is closed."
                        : blocked
                          ? "Blocked by this phone or browser."
                          : state.supported
                            ? "Not enabled yet."
                            : "This browser does not support Web Push."}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                    enabled
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-[var(--color-surface)] text-[var(--color-text-muted)]"
                  }`}>
                    {enabled ? "On" : "Off"}
                  </span>
                </div>

                {ios && !standalone && state.supported && (
                  <p className="mt-3 rounded-xl bg-[var(--color-surface)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-text-muted)]">
                    On iPhone, install DA CHATBOT to the Home Screen first, open it from the Home Screen icon, then enable notifications here.
                  </p>
                )}

                {!state.configured && (
                  <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] leading-5 text-amber-800">
                    Web Push is not configured on this deployment yet. Ask an administrator to add the VAPID environment variables.
                  </p>
                )}

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  {enabled ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={disable}
                      className="h-11 rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-50"
                    >
                      Disable on this device
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !state.supported || !state.configured || blocked}
                      onClick={enable}
                      className="h-11 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Enable notifications
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy || !enabled}
                    onClick={sendTest}
                    className="h-11 rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-50"
                  >
                    Send test notification
                  </button>
                </div>
              </div>

              {android && (
                <details className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                  <summary className="cursor-pointer list-none text-sm font-bold">
                    Android / HONOR notification reliability
                    <span className="ml-2 text-[11px] font-medium text-[var(--color-text-muted)]">
                      If alerts arrive late or not at all
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3 text-xs leading-5 text-[var(--color-text-muted)]">
                    <p>
                      Android phones can restrict background notifications to save battery. HONOR MagicOS can be especially aggressive. If your test notification does not appear while the phone is locked, check these phone settings.
                    </p>

                    <div className="rounded-xl bg-[var(--color-surface)] px-3 py-3">
                      <p className="font-semibold text-[var(--color-text)]">1. Allow notifications</p>
                      <p className="mt-1">
                        Phone Settings → Notifications → DA CHATBOT or Chrome → Allow notifications.
                      </p>
                    </div>

                    <div className="rounded-xl bg-[var(--color-surface)] px-3 py-3">
                      <p className="font-semibold text-[var(--color-text)]">
                        2. Allow background activity
                      </p>
                      <p className="mt-1">
                        On HONOR/MagicOS: Phone Settings → Battery → App launch → DA CHATBOT or Chrome. Turn off Manage automatically, then allow Auto-launch, Secondary launch, and Run in background. On other Android phones, allow background activity and remove battery restrictions.
                      </p>
                    </div>

                    <div className="rounded-xl bg-[var(--color-surface)] px-3 py-3">
                      <p className="font-semibold text-[var(--color-text)]">3. Remove battery optimization if needed</p>
                      <p className="mt-1">
                        Set DA CHATBOT or Chrome to unrestricted / not optimized if notifications are delayed after the phone has been idle.
                      </p>
                    </div>

                    <div className="rounded-xl bg-[var(--color-surface)] px-3 py-3">
                      <p className="font-semibold text-[var(--color-text)]">4. Test with the app closed</p>
                      <p className="mt-1">
                        Tap Send test notification, then close DA CHATBOT and lock the phone. A later Booking Ready or Human Attention alert should still appear.
                      </p>
                    </div>

                    <p className="text-[11px]">
                      Menu names can vary slightly by MagicOS/Android version. These settings do not change how the chatbot replies; they only affect whether the phone lets background notifications appear promptly.
                    </p>
                  </div>
                </details>
              )}

              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <p className="text-sm font-bold">What will notify staff</p>
                <div className="mt-3 space-y-2 text-xs leading-5 text-[var(--color-text-muted)]">
                  <p>✓ Booking Ready</p>
                  <p>✓ Needs Human Attention / AI handoff</p>
                  <p>✓ Message delivery failure that requires staff action</p>
                  <p>✕ Normal new customer messages</p>
                  <p>✕ AI replies and staff's own messages</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
