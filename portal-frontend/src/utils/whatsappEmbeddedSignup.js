const META_MESSAGE_ORIGINS = new Set([
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
]);

let sdkPromise = null;

export function buildWhatsAppBusinessAppLoginOptions(config = {}) {
  return {
    config_id: config.configId,
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
    },
  };
}

export function parseWhatsAppEmbeddedSignupMessage(event) {
  if (!META_MESSAGE_ORIGINS.has(event?.origin)) return null;

  let payload = event?.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      return null;
    }
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    payload.type !== "WA_EMBEDDED_SIGNUP"
  ) {
    return null;
  }

  return payload;
}

function initializeSdk(config) {
  if (!window.FB?.init || !window.FB?.login) {
    throw new Error("Meta SDK loaded without the Facebook Login API.");
  }
  window.FB.init({
    appId: config.appId,
    cookie: true,
    xfbml: false,
    version: config.graphVersion || "v26.0",
  });
  return window.FB;
}

export function loadMetaSdk(config) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Meta Embedded Signup requires a browser."));
  }
  if (!config?.appId) {
    return Promise.reject(new Error("Meta App ID is not configured."));
  }

  if (window.FB?.init && window.FB?.login) {
    return Promise.resolve(initializeSdk(config));
  }

  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      sdkPromise = null;
      reject(new Error("Meta Login SDK did not finish loading."));
    }, 15000);

    const previous = window.fbAsyncInit;
    window.fbAsyncInit = () => {
      try {
        if (typeof previous === "function") previous();
        const sdk = initializeSdk(config);
        window.clearTimeout(timeout);
        resolve(sdk);
      } catch (err) {
        window.clearTimeout(timeout);
        sdkPromise = null;
        reject(err);
      }
    };

    if (document.getElementById("facebook-jssdk")) return;

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.onerror = () => {
      window.clearTimeout(timeout);
      sdkPromise = null;
      reject(new Error("Meta Login SDK could not be loaded."));
    };
    document.head.appendChild(script);
  });

  return sdkPromise;
}

export { META_MESSAGE_ORIGINS };
