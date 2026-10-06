function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function byteArraysEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function browserSupportsPush() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Notification request failed.");
    error.code = data.code || null;
    throw error;
  }
  return data;
}

async function getServerConfig() {
  return requestJson("/api/push/config");
}

async function getRegistration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function currentSubscription({ register = true } = {}) {
  if (!browserSupportsPush()) return null;
  const registration = register
    ? await getRegistration()
    : await navigator.serviceWorker.getRegistration("/");
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

async function isServerSubscriptionActive(endpoint) {
  if (!endpoint) return false;
  const params = new URLSearchParams({ endpoint });
  const result = await requestJson(`/api/push/subscriptions/status?${params.toString()}`);
  return result.active === true;
}

export async function getPushNotificationState() {
  if (!browserSupportsPush()) {
    return {
      supported: false,
      configured: false,
      permission: "unsupported",
      subscribed: false,
    };
  }

  const [config, subscription] = await Promise.all([
    getServerConfig(),
    currentSubscription(),
  ]);
  const serverActive = subscription
    ? await isServerSubscriptionActive(subscription.endpoint)
    : false;

  return {
    supported: true,
    configured: config.configured === true,
    permission: Notification.permission,
    subscribed: Boolean(subscription && serverActive),
  };
}

export async function enablePushNotifications() {
  if (!browserSupportsPush()) {
    throw new Error("Push notifications are not supported on this browser.");
  }

  // Keep the permission request as the first asynchronous browser action from
  // the user's tap. iOS Home Screen web apps require notification permission
  // to be requested from a direct user interaction.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    const error = new Error(
      permission === "denied"
        ? "Notifications are blocked in your phone/browser settings."
        : "Notification permission was not granted."
    );
    error.code = "WEB_PUSH_PERMISSION_NOT_GRANTED";
    throw error;
  }

  const config = await getServerConfig();
  if (!config.configured || !config.publicKey) {
    const error = new Error("Web Push is not configured on this deployment.");
    error.code = "WEB_PUSH_NOT_CONFIGURED";
    throw error;
  }

  const registration = await getRegistration();
  const applicationServerKey = base64UrlToUint8Array(config.publicKey);
  let subscription = await registration.pushManager.getSubscription();

  const existingKey = subscription?.options?.applicationServerKey
    ? new Uint8Array(subscription.options.applicationServerKey)
    : null;
  if (subscription && existingKey && !byteArraysEqual(existingKey, applicationServerKey)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  await requestJson("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  return subscription;
}

export async function disablePushNotifications() {
  if (!browserSupportsPush()) return false;
  const registration = await getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  let serverError = null;
  try {
    await requestJson("/api/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch (err) {
    serverError = err;
  }

  // Always stop this browser endpoint locally, even if the server cleanup
  // request failed. The push service will subsequently retire the stale
  // endpoint and the backend also disables 404/410 subscriptions.
  await subscription.unsubscribe().catch(() => false);
  if (serverError) throw serverError;
  return true;
}

export async function sendPushTestNotification() {
  const subscription = await currentSubscription();
  if (!subscription) {
    const error = new Error("Enable notifications on this device first.");
    error.code = "WEB_PUSH_NO_SUBSCRIPTION";
    throw error;
  }
  return requestJson("/api/push/test", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
}

export async function getCurrentPushEndpoint() {
  const subscription = await currentSubscription({ register: false });
  return subscription?.endpoint || null;
}

export async function unsubscribeCurrentPushLocally() {
  const subscription = await currentSubscription({ register: false });
  if (!subscription) return false;
  return subscription.unsubscribe();
}

export function isAndroidDevice() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent || "");
}

export function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isStandaloneWebApp() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    window.navigator.standalone === true
  );
}
