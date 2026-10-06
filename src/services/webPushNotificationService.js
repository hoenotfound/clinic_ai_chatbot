const crypto = require("crypto");
const pushSubscriptionsRepo = require("../db/pushSubscriptionsRepo");
const { pool } = require("../db/db");
const { effectivePermissions } = require("../utils/permissions");

const MAX_PAYLOAD_BYTES = 3000;
const PUSH_TIMEOUT_MS = 7000;
const DEFAULT_TTL_SECONDS = 3600;

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function validVapidSubject(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch (_) {
    return false;
  }
}

function pushConfig(env = process.env) {
  const publicKey = String(env.WEB_PUSH_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.WEB_PUSH_VAPID_PRIVATE_KEY || "").trim();
  const publicBytes = decodeBase64Url(publicKey);
  const privateBytes = decodeBase64Url(privateKey);
  let keyPairMatches = false;
  if (
    publicBytes.length === 65 &&
    publicBytes[0] === 4 &&
    privateBytes.length === 32
  ) {
    try {
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.setPrivateKey(privateBytes);
      keyPairMatches = crypto.timingSafeEqual(
        ecdh.getPublicKey(null, "uncompressed"),
        publicBytes
      );
    } catch (_) {
      keyPairMatches = false;
    }
  }
  const configuredBaseUrl = String(env.PUBLIC_BASE_URL || "").trim();
  const subject =
    String(env.WEB_PUSH_SUBJECT || "").trim() ||
    (/^https:\/\//i.test(configuredBaseUrl)
      ? configuredBaseUrl
      : "https://dasmarketingsolution.com");
  const configured = keyPairMatches && validVapidSubject(subject);
  return { configured, publicKey, publicBytes, privateBytes, subject };
}

function buildVapidPrivateKey(config) {
  const x = config.publicBytes.subarray(1, 33);
  const y = config.publicBytes.subarray(33, 65);
  return crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: encodeBase64Url(x),
      y: encodeBase64Url(y),
      d: encodeBase64Url(config.privateBytes),
    },
    format: "jwk",
  });
}

function makeVapidJwt(endpoint, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const audience = new URL(endpoint).origin;
  const header = encodeBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      aud: audience,
      exp: nowSeconds + 12 * 60 * 60,
      sub: config.subject,
    })
  );
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: buildVapidPrivateKey(config),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

function encryptPayload(subscription, payloadBuffer) {
  const clientPublicKey = decodeBase64Url(subscription.p256dh);
  const authSecret = decodeBase64Url(subscription.auth);
  if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 4) {
    throw new Error("Invalid Web Push p256dh key.");
  }
  if (!authSecret.length) {
    throw new Error("Invalid Web Push auth secret.");
  }

  const server = crypto.createECDH("prime256v1");
  const serverPublicKey = server.generateKeys();
  const sharedSecret = server.computeSecret(clientPublicKey);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    clientPublicKey,
    serverPublicKey,
  ]);
  const ikm = Buffer.from(
    crypto.hkdfSync("sha256", sharedSecret, authSecret, info, 32)
  );
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0", "ascii"),
      16
    )
  );
  const nonce = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: nonce\0", "ascii"),
      12
    )
  );

  // RFC 8188 final-record delimiter. Keep one record so notification payloads
  // remain small and interoperable across Apple/Google push services.
  const record = Buffer.concat([payloadBuffer, Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, tag]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPublicKey.length, 20);

  return Buffer.concat([header, serverPublicKey, ciphertext]);
}

async function postWebPush(subscription, payload, {
  env = process.env,
  fetchImpl = global.fetch,
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  const config = pushConfig(env);
  if (!config.configured) {
    return { status: "disabled" };
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Web Push requires the built-in fetch API.");
  }

  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  if (payloadBuffer.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Web Push payload is too large.");
  }
  const body = encryptPayload(subscription, payloadBuffer);
  const jwt = makeVapidJwt(subscription.endpoint, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${config.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "high",
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    return {
      status: response.ok ? "sent" : "failed",
      statusCode: response.status,
      terminal: response.status === 404 || response.status === 410,
    };
  } finally {
    clearTimeout(timer);
  }
}

function displayName(context) {
  return (
    String(context?.name || "").trim() ||
    String(context?.whatsapp_profile_name || "").trim() ||
    "Customer"
  );
}

async function getContactPushContext(contactId, queryable = pool) {
  const result = await queryable.query(
    `SELECT
       c.id, c.name, c.whatsapp_profile_name, c.channel,
       current_lead.owner_username
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT l.owner_username
       FROM leads l
       WHERE l.contact_id = c.id AND l.is_closed = false
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 1
     ) current_lead ON true
     WHERE c.id = $1`,
    [Number(contactId)]
  );
  return result.rows[0] || null;
}

function canReceiveContactPush(subscription, context) {
  const permissions = effectivePermissions(subscription);
  if (permissions.view_all_leads === true) return true;
  return (
    permissions.view_assigned_leads === true &&
    context?.owner_username &&
    subscription.username === context.owner_username
  );
}

function notificationCopy(type, context) {
  const name = displayName(context);
  if (type === "booking_ready") {
    return {
      title: "Booking Ready",
      body: `${name} is ready for staff to confirm the booking.`,
    };
  }
  if (type === "delivery_failure") {
    return {
      title: "Message Delivery Failed",
      body: `A message to ${name} needs staff attention.`,
    };
  }
  return {
    title: "Needs Human Attention",
    body: `${name} needs a staff review.`,
  };
}

function buildPayload(type, context) {
  const copy = notificationCopy(type, context);
  return {
    ...copy,
    type,
    contactId: Number(context.id),
    url: `/inbox?contact=${encodeURIComponent(context.id)}`,
    tag: `da-chatbot:${type}:${context.id}`,
  };
}

async function deliverToSubscriptions(subscriptions, payload, {
  repository = pushSubscriptionsRepo,
  send = postWebPush,
  logger = console,
} = {}) {
  let sent = 0;
  let failed = 0;

  await Promise.all(
    (subscriptions || []).map(async (subscription) => {
      try {
        const result = await send(subscription, payload);
        if (result?.status === "disabled") return;
        if (result?.status === "sent") {
          sent += 1;
          await repository.markSuccess(subscription.id);
          return;
        }
        failed += 1;
        await repository.markFailure(subscription.id, {
          terminal: result?.terminal === true,
        });
      } catch (err) {
        failed += 1;
        await repository.markFailure(subscription.id).catch(() => {});
        logger.warn(
          `Web Push failed for subscription ${subscription.id}:`,
          err?.message || err
        );
      }
    })
  );

  return { sent, failed };
}

async function sendContactAlert({
  contactId,
  type,
  repository = pushSubscriptionsRepo,
  database = pool,
  logger = console,
} = {}) {
  const config = pushConfig();
  if (!config.configured) return { status: "disabled", sent: 0, failed: 0 };

  const context = await getContactPushContext(contactId, database);
  if (!context) return { status: "skipped", sent: 0, failed: 0 };

  const subscriptions = (await repository.listActiveSubscriptions())
    .filter((subscription) => canReceiveContactPush(subscription, context));
  if (!subscriptions.length) {
    return { status: "no-subscribers", sent: 0, failed: 0 };
  }

  const result = await deliverToSubscriptions(
    subscriptions,
    buildPayload(type, context),
    { repository, logger }
  );
  return { status: "complete", ...result };
}

async function sendUserTest(userId, endpoint, {
  repository = pushSubscriptionsRepo,
  logger = console,
} = {}) {
  const config = pushConfig();
  if (!config.configured) return { status: "disabled", sent: 0, failed: 0 };
  const subscription = await repository.getActiveSubscriptionForUser(userId, endpoint);
  if (!subscription) return { status: "no-subscribers", sent: 0, failed: 0 };
  const subscriptions = [subscription];
  const payload = {
    title: "DA CHATBOT Notifications",
    body: "Push notifications are working on this device.",
    type: "test",
    url: "/inbox",
    tag: "da-chatbot:test",
  };
  const result = await deliverToSubscriptions(subscriptions, payload, {
    repository,
    logger,
  });
  return { status: "complete", ...result };
}

function sendContactAlertBestEffort(input, logger = console) {
  Promise.resolve(sendContactAlert(input)).catch((err) => {
    logger.warn(
      `Web Push ${input?.type || "staff"} alert failed for contact ${input?.contactId || "unknown"}:`,
      err?.message || err
    );
  });
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
  PUSH_TIMEOUT_MS,
  buildPayload,
  canReceiveContactPush,
  deliverToSubscriptions,
  encryptPayload,
  getContactPushContext,
  makeVapidJwt,
  notificationCopy,
  postWebPush,
  pushConfig,
  sendContactAlert,
  sendContactAlertBestEffort,
  sendUserTest,
};
